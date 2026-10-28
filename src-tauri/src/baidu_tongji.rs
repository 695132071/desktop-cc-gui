//! Linux-native Baidu Tongji transport.
//!
//! Ported from the legacy desktop-cc-gui analytics module. On Linux native
//! (WebKitGTK), any `hm.baidu.com` request through WebKitNetworkProcess can
//! crash libsoup and blank the window, so the renderer installs an Image.src
//! bridge and these two commands move the official `hm.js` fetch and the
//! `hm.gif` beacon onto a fixed, narrow reqwest path. The official script
//! stays the payload authority; only the network transport is native.
//! Windows/macOS and the web-access build keep the external script path and
//! never invoke these commands.

use crate::paths;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, COOKIE, REFERER, SET_COOKIE, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{State, WebviewWindow};
use tokio::sync::Mutex;

const BAIDU_TONGJI_SITE_ID: &str = "b18f7c7bbeab70682b0a359e6b7b058d";
const BAIDU_TONGJI_SCRIPT_URL_PREFIX: &str = "https://hm.baidu.com/hm.js?";
const BAIDU_TONGJI_SCRIPT_MARKER: &str = "hm.baidu.com/hm.gif";
const BAIDU_TONGJI_REFERER: &str = "https://tauri.localhost/";
const BAIDU_TONGJI_COOKIE_FILENAME: &str = "baidu-tongji.json";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_SCRIPT_BYTES: usize = 128 * 1024;
const MAX_BEACON_URL_BYTES: usize = 8 * 1024;
const MAX_USER_AGENT_BYTES: usize = 1024;
const MAX_HMAC_COUNT_BYTES: usize = 128;

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedVisitorCookie {
    hmac_count: Option<String>,
}

pub(crate) struct BaiduTongjiState {
    client: Option<reqwest::Client>,
    client_error: Option<String>,
    visitor_cookie: Mutex<Option<String>>,
    cookie_commit: Mutex<()>,
    storage_path: Option<PathBuf>,
}

struct NativeAnalyticsResponse {
    response: reqwest::Response,
    sent_cookie: Option<String>,
    response_cookie: Option<String>,
}

// ── Minimal JSON storage helpers (legacy storage:: equivalents) ─────────────

fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map(Some)
            .map_err(|error| format!("parse {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read {}: {error}", path.display())),
    }
}

fn write_json_file<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let content = serde_json::to_string(value).map_err(|error| error.to_string())?;
    crate::settings::atomic_write(path, &content)
}

/// Quarantine a corrupted record: rename next to the original and report the
/// backup path. Never deletes data, never fails the caller.
fn backup_corrupted_file(path: &Path, error: &str) -> Option<PathBuf> {
    if !path.exists() {
        return None;
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let file_name = path.file_name()?.to_string_lossy();
    let backup = path.with_file_name(format!("{file_name}.corrupted-{millis}"));
    match std::fs::rename(path, &backup) {
        Ok(()) => Some(backup),
        Err(rename_error) => {
            eprintln!(
                "baidu_tongji: failed to quarantine corrupted record ({error}): {rename_error}"
            );
            None
        }
    }
}

// ── State ───────────────────────────────────────────────────────────────────

impl BaiduTongjiState {
    pub(crate) fn load() -> Self {
        let (storage_path, visitor_cookie) = match visitor_cookie_path() {
            Ok(path) => {
                let cookie = load_visitor_cookie(&path);
                (Some(path), cookie)
            }
            Err(error) => {
                eprintln!("baidu_tongji: failed to resolve visitor-cookie storage: {error}");
                (None, None)
            }
        };

        let (client, client_error) = match reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
        {
            Ok(client) => (Some(client), None),
            Err(error) => {
                let message =
                    redacted_reqwest_error("failed to build native analytics HTTP client", &error);
                eprintln!("baidu_tongji: {message}");
                (None, Some(message))
            }
        };

        Self {
            client,
            client_error,
            visitor_cookie: Mutex::new(visitor_cookie),
            cookie_commit: Mutex::new(()),
            storage_path,
        }
    }
}

fn visitor_cookie_path() -> Result<PathBuf, String> {
    Ok(paths::app_home()
        .join("analytics")
        .join(BAIDU_TONGJI_COOKIE_FILENAME))
}

fn reqwest_error_kind(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_body() {
        "response-body"
    } else if error.is_decode() {
        "decode"
    } else if error.is_request() || error.is_builder() {
        "request"
    } else {
        "transport"
    }
}

fn redacted_reqwest_error(action: &str, error: &reqwest::Error) -> String {
    format!("{action}: {}", reqwest_error_kind(error))
}

fn valid_hmac_count(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_HMAC_COUNT_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn validate_user_agent(user_agent: &str) -> Result<HeaderValue, String> {
    if user_agent.is_empty()
        || user_agent.len() > MAX_USER_AGENT_BYTES
        || user_agent.trim() != user_agent
        || user_agent.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err("invalid native analytics user-agent".to_string());
    }
    HeaderValue::from_str(user_agent)
        .map_err(|error| format!("invalid native analytics user-agent header: {error}"))
}

fn validate_beacon_url(raw_url: &str) -> Result<reqwest::Url, String> {
    if raw_url.is_empty() || raw_url.len() > MAX_BEACON_URL_BYTES {
        return Err("invalid native analytics beacon URL length".to_string());
    }

    let mut url = reqwest::Url::parse(raw_url)
        .map_err(|_| "invalid native analytics beacon URL".to_string())?;
    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("native analytics beacon scheme is not allowed".to_string());
    }
    if url.host_str() != Some("hm.baidu.com")
        || url.path() != "/hm.gif"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("native analytics beacon endpoint is not allowed".to_string());
    }
    if let Some(port) = url.port() {
        let expected = if scheme == "http" { 80 } else { 443 };
        if port != expected {
            return Err("native analytics beacon port is not allowed".to_string());
        }
    }

    let mut site_ids = Vec::new();
    let mut hca_values = Vec::new();
    for (key, value) in url.query_pairs() {
        if key == "si" {
            site_ids.push(value.into_owned());
        } else if key == "hca" {
            hca_values.push(value.into_owned());
        }
    }
    if site_ids.as_slice() != [BAIDU_TONGJI_SITE_ID]
        || hca_values.len() != 1
        || hca_values[0].is_empty()
        || hca_values[0].len() > 256
    {
        return Err("native analytics beacon identity is invalid".to_string());
    }

    url.set_scheme("https")
        .map_err(|_| "failed to normalize native analytics beacon scheme".to_string())?;
    url.set_port(None)
        .map_err(|_| "failed to normalize native analytics beacon port".to_string())?;
    Ok(url)
}

fn extract_hmac_count(headers: &HeaderMap) -> Option<String> {
    for header in headers.get_all(SET_COOKIE) {
        let Ok(raw_value) = header.to_str() else {
            continue;
        };
        for cookie_part in raw_value
            .split(';')
            .flat_map(|part| part.split(','))
            .map(str::trim)
        {
            let Some((name, value)) = cookie_part.split_once('=') else {
                continue;
            };
            if name.eq_ignore_ascii_case("HMACCOUNT") && valid_hmac_count(value) {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn read_visitor_cookie(path: &Path) -> Result<Option<String>, String> {
    let Some(record) = read_json_file::<PersistedVisitorCookie>(path)? else {
        return Ok(None);
    };
    match record.hmac_count {
        None => Ok(None),
        Some(value) if valid_hmac_count(&value) => Ok(Some(value)),
        Some(_) => Err("invalid native analytics visitor-cookie record".to_string()),
    }
}

fn load_visitor_cookie(path: &PathBuf) -> Option<String> {
    match read_visitor_cookie(path) {
        Ok(cookie) => cookie,
        Err(error) => {
            let backup_path = backup_corrupted_file(path, &error);
            eprintln!(
                "baidu_tongji: failed to read visitor cookie; quarantined={}",
                backup_path.is_some()
            );
            None
        }
    }
}

fn persist_visitor_cookie(path: &Path, value: &str) -> Result<(), String> {
    if !valid_hmac_count(value) {
        return Err("invalid native analytics visitor cookie".to_string());
    }
    write_json_file(
        path,
        &PersistedVisitorCookie {
            hmac_count: Some(value.to_string()),
        },
    )
    .map_err(|error| format!("failed to persist native analytics visitor cookie: {error}"))
}

fn fixed_script_url() -> String {
    format!("{BAIDU_TONGJI_SCRIPT_URL_PREFIX}{BAIDU_TONGJI_SITE_ID}")
}

fn validate_main_linux_webview(webview: &WebviewWindow) -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("native Baidu analytics transport is Linux-only".to_string());
    }
    if webview.label() != "main" {
        return Err("native Baidu analytics transport is main-window-only".to_string());
    }
    Ok(())
}

async fn persist_cookie_update(state: &BaiduTongjiState, value: String) {
    let Some(path) = state.storage_path.clone() else {
        eprintln!("baidu_tongji: visitor cookie is memory-only because storage is unavailable");
        return;
    };
    let persisted =
        tokio::task::spawn_blocking(move || persist_visitor_cookie(&path, &value)).await;
    match persisted {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("baidu_tongji: {error}"),
        Err(error) => eprintln!("baidu_tongji: visitor-cookie persistence task failed: {error}"),
    }
}

async fn commit_response_cookie(
    state: &BaiduTongjiState,
    sent_cookie: Option<String>,
    response_cookie: Option<String>,
) {
    let Some(response_cookie) = response_cookie else {
        return;
    };

    // Serialize accepted updates through persistence so an older disk write cannot
    // finish after a newer in-memory identity. Network I/O never holds either lock.
    let _commit_guard = state.cookie_commit.lock().await;
    let accepted = {
        let mut current_cookie = state.visitor_cookie.lock().await;
        if current_cookie.as_deref() != sent_cookie.as_deref()
            || current_cookie.as_deref() == Some(response_cookie.as_str())
        {
            false
        } else {
            *current_cookie = Some(response_cookie.clone());
            true
        }
    };

    if accepted {
        persist_cookie_update(state, response_cookie).await;
    }
}

async fn send_fixed_get(
    state: &BaiduTongjiState,
    url: reqwest::Url,
    user_agent: HeaderValue,
) -> Result<NativeAnalyticsResponse, String> {
    let client = state.client.as_ref().ok_or_else(|| {
        state
            .client_error
            .clone()
            .unwrap_or_else(|| "native analytics HTTP client is unavailable".to_string())
    })?;
    let sent_cookie = state.visitor_cookie.lock().await.clone();

    let mut request = client
        .get(url)
        .header(USER_AGENT, user_agent)
        .header(REFERER, BAIDU_TONGJI_REFERER)
        .header(ACCEPT, "*/*");
    if let Some(value) = sent_cookie.as_deref() {
        request = request.header(COOKIE, format!("HMACCOUNT={value}"));
    }
    let response = request
        .send()
        .await
        .map_err(|error| redacted_reqwest_error("native analytics request failed", &error))?;
    let response_cookie = extract_hmac_count(response.headers());

    Ok(NativeAnalyticsResponse {
        response,
        sent_cookie,
        response_cookie,
    })
}

fn append_bounded_script_chunk(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), String> {
    if chunk.len() > MAX_SCRIPT_BYTES.saturating_sub(body.len()) {
        return Err("native analytics script exceeds size limit".to_string());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

async fn read_bounded_script_body(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| redacted_reqwest_error("failed to read native analytics script", &error))?
    {
        append_bounded_script_chunk(&mut body, &chunk)?;
    }
    if body.is_empty() {
        return Err("native analytics script body has invalid size".to_string());
    }
    Ok(body)
}

fn validate_official_script(bytes: &[u8]) -> Result<&str, String> {
    let script = std::str::from_utf8(bytes)
        .map_err(|_| "native analytics script is not UTF-8".to_string())?;
    if !script.contains(BAIDU_TONGJI_SCRIPT_MARKER) || !script.contains(BAIDU_TONGJI_SITE_ID) {
        return Err("native analytics script transport marker changed".to_string());
    }
    Ok(script)
}

async fn validate_and_commit_official_script<'a>(
    state: &BaiduTongjiState,
    bytes: &'a [u8],
    sent_cookie: Option<String>,
    response_cookie: Option<String>,
) -> Result<&'a str, String> {
    let script = validate_official_script(bytes)?;
    commit_response_cookie(state, sent_cookie, response_cookie).await;
    Ok(script)
}

async fn validate_and_commit_beacon_response(
    state: &BaiduTongjiState,
    status: reqwest::StatusCode,
    sent_cookie: Option<String>,
    response_cookie: Option<String>,
) -> Result<(), String> {
    if !status.is_success() {
        return Err(format!("native analytics beacon returned HTTP {status}"));
    }
    commit_response_cookie(state, sent_cookie, response_cookie).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn load_baidu_tongji_script(
    user_agent: String,
    webview: WebviewWindow,
    state: State<'_, BaiduTongjiState>,
) -> Result<(), String> {
    validate_main_linux_webview(&webview)?;
    let user_agent = validate_user_agent(&user_agent)?;
    let script_url = reqwest::Url::parse(&fixed_script_url())
        .map_err(|error| format!("failed to construct native analytics script URL: {error}"))?;
    let NativeAnalyticsResponse {
        response,
        sent_cookie,
        response_cookie,
    } = send_fixed_get(&state, script_url, user_agent).await?;
    let had_visitor_cookie = sent_cookie.is_some();
    let status = response.status();
    if !status.is_success() {
        return Err(format!("native analytics script returned HTTP {status}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SCRIPT_BYTES as u64)
    {
        return Err("native analytics script exceeds size limit".to_string());
    }
    let bytes = read_bounded_script_body(response).await?;
    let script =
        validate_and_commit_official_script(&state, &bytes, sent_cookie, response_cookie).await?;
    webview
        .eval(script)
        .map_err(|error| format!("failed to evaluate native analytics script: {error}"))?;
    println!(
        "baidu_tongji: native script loaded status={} bytes={} visitorCookiePresent={}",
        status.as_u16(),
        bytes.len(),
        had_visitor_cookie
    );
    Ok(())
}

#[tauri::command]
pub(crate) async fn send_baidu_tongji_beacon(
    url: String,
    user_agent: String,
    webview: WebviewWindow,
    state: State<'_, BaiduTongjiState>,
) -> Result<(), String> {
    validate_main_linux_webview(&webview)?;
    let url = validate_beacon_url(&url)?;
    let user_agent = validate_user_agent(&user_agent)?;
    let NativeAnalyticsResponse {
        response,
        sent_cookie,
        response_cookie,
    } = send_fixed_get(&state, url, user_agent).await?;
    let had_visitor_cookie = sent_cookie.is_some();
    let status = response.status();
    validate_and_commit_beacon_response(&state, status, sent_cookie, response_cookie).await?;
    println!(
        "baidu_tongji: native beacon accepted status={} hasHca=true visitorCookiePresent={}",
        status.as_u16(),
        had_visitor_cookie
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::SET_COOKIE;
    use uuid::Uuid;

    const VALID_BEACON: &str =
        "http://hm.baidu.com/hm.gif?si=b18f7c7bbeab70682b0a359e6b7b058d&hca=visitor-1&et=0";

    fn test_state(visitor_cookie: Option<&str>, storage_path: Option<PathBuf>) -> BaiduTongjiState {
        BaiduTongjiState {
            client: None,
            client_error: None,
            visitor_cookie: Mutex::new(visitor_cookie.map(str::to_string)),
            cookie_commit: Mutex::new(()),
            storage_path,
        }
    }

    #[test]
    fn validates_and_upgrades_the_fixed_beacon_endpoint() {
        let url = validate_beacon_url(VALID_BEACON).expect("valid fixed beacon");

        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("hm.baidu.com"));
        assert_eq!(url.path(), "/hm.gif");
        assert!(url
            .query_pairs()
            .any(|(key, value)| key == "hca" && value == "visitor-1"));
    }

    #[test]
    fn rejects_beacons_outside_the_fixed_site_contract() {
        for candidate in [
            "https://example.com/hm.gif?si=b18f7c7bbeab70682b0a359e6b7b058d&hca=v",
            "https://hm.baidu.com/other?si=b18f7c7bbeab70682b0a359e6b7b058d&hca=v",
            "https://hm.baidu.com/hm.gif?si=wrong&hca=v",
            "https://hm.baidu.com/hm.gif?si=b18f7c7bbeab70682b0a359e6b7b058d",
        ] {
            assert!(
                validate_beacon_url(candidate).is_err(),
                "accepted {candidate}"
            );
        }
    }

    #[test]
    fn validates_a_bounded_webview_user_agent() {
        let valid = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15";
        assert_eq!(validate_user_agent(valid).unwrap(), valid);
        assert!(validate_user_agent("").is_err());
        assert!(validate_user_agent("Mozilla/5.0\nInjected: value").is_err());
        assert!(validate_user_agent(&"x".repeat(1025)).is_err());
    }

    #[test]
    fn extracts_only_a_bounded_hmac_count_cookie() {
        let mut headers = HeaderMap::new();
        headers.append(
            SET_COOKIE,
            HeaderValue::from_static(
                "OTHER=value; Path=/, HMACCOUNT=350BB24308ABC8D1; Path=/; Domain=hm.baidu.com",
            ),
        );
        assert_eq!(
            extract_hmac_count(&headers).as_deref(),
            Some("350BB24308ABC8D1")
        );

        let mut invalid = HeaderMap::new();
        invalid.insert(
            SET_COOKIE,
            HeaderValue::from_static("HMACCOUNT=bad value; Path=/"),
        );
        assert_eq!(extract_hmac_count(&invalid), None);
    }

    #[test]
    fn persists_and_reloads_visitor_cookie_continuity() {
        let root =
            std::env::temp_dir().join(format!("ccgui-baidu-tongji-cookie-test-{}", Uuid::new_v4()));
        let path = root.join("analytics").join("baidu-tongji.json");

        persist_visitor_cookie(&path, "350BB24308ABC8D1").expect("persist cookie");
        assert_eq!(
            read_visitor_cookie(&path).expect("read cookie").as_deref(),
            Some("350BB24308ABC8D1")
        );

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_invalid_persisted_cookie_values() {
        let root = std::env::temp_dir().join(format!(
            "ccgui-baidu-tongji-invalid-cookie-test-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create temp root");
        let path = root.join("baidu-tongji.json");
        std::fs::write(&path, r#"{"hmacCount":"bad value"}"#).expect("write fixture");

        assert!(read_visitor_cookie(&path).is_err());
        assert_eq!(load_visitor_cookie(&path), None);
        assert!(!path.exists(), "invalid record must be quarantined");
        let backups = std::fs::read_dir(&root)
            .expect("read temp root")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("baidu-tongji.json.corrupted-")
            })
            .count();
        assert_eq!(backups, 1, "expected exactly one quarantined record");

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn rejects_a_streamed_script_chunk_before_exceeding_the_limit() {
        let mut body = vec![b'a'; MAX_SCRIPT_BYTES - 2];
        append_bounded_script_chunk(&mut body, b"bc").expect("exact limit is allowed");
        assert_eq!(body.len(), MAX_SCRIPT_BYTES);

        let error = append_bounded_script_chunk(&mut body, b"d")
            .expect_err("overflowing chunk must be rejected");
        assert_eq!(error, "native analytics script exceeds size limit");
        assert_eq!(body.len(), MAX_SCRIPT_BYTES, "rejected chunk was appended");
    }

    #[tokio::test]
    async fn invalid_official_script_does_not_commit_response_cookie() {
        let root = std::env::temp_dir().join(format!(
            "ccgui-baidu-tongji-invalid-script-cookie-test-{}",
            Uuid::new_v4()
        ));
        let path = root.join("analytics").join("baidu-tongji.json");
        persist_visitor_cookie(&path, "old-cookie").expect("persist old cookie");
        let state = test_state(Some("old-cookie"), Some(path.clone()));
        let missing_marker = format!("window.siteId = '{BAIDU_TONGJI_SITE_ID}';");
        assert!(validate_and_commit_official_script(
            &state,
            missing_marker.as_bytes(),
            Some("old-cookie".to_string()),
            Some("new-cookie".to_string()),
        )
        .await
        .is_err());

        let missing_site_id = format!("new Image().src = '{BAIDU_TONGJI_SCRIPT_MARKER}';");
        assert!(validate_official_script(missing_site_id.as_bytes()).is_err());
        assert!(validate_official_script(&[0xff, 0xfe]).is_err());

        assert_eq!(
            state.visitor_cookie.lock().await.as_deref(),
            Some("old-cookie")
        );
        assert_eq!(
            read_visitor_cookie(&path)
                .expect("read unchanged cookie")
                .as_deref(),
            Some("old-cookie")
        );

        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn failed_beacon_response_does_not_commit_response_cookie() {
        let state = test_state(Some("old-cookie"), None);

        assert!(validate_and_commit_beacon_response(
            &state,
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            Some("old-cookie".to_string()),
            Some("new-cookie".to_string()),
        )
        .await
        .is_err());

        assert_eq!(
            state.visitor_cookie.lock().await.as_deref(),
            Some("old-cookie")
        );
    }

    #[tokio::test]
    async fn commits_a_valid_response_cookie_and_persists_it() {
        let root = std::env::temp_dir().join(format!(
            "ccgui-baidu-tongji-commit-cookie-test-{}",
            Uuid::new_v4()
        ));
        let path = root.join("analytics").join("baidu-tongji.json");
        let state = test_state(Some("old-cookie"), Some(path.clone()));

        commit_response_cookie(
            &state,
            Some("old-cookie".to_string()),
            Some("new-cookie".to_string()),
        )
        .await;

        assert_eq!(
            state.visitor_cookie.lock().await.as_deref(),
            Some("new-cookie")
        );
        assert_eq!(
            read_visitor_cookie(&path)
                .expect("read committed cookie")
                .as_deref(),
            Some("new-cookie")
        );

        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn response_without_a_cookie_leaves_identity_unchanged() {
        let state = test_state(Some("existing-cookie"), None);

        commit_response_cookie(&state, Some("existing-cookie".to_string()), None).await;

        assert_eq!(
            state.visitor_cookie.lock().await.as_deref(),
            Some("existing-cookie")
        );
    }

    #[tokio::test]
    async fn stale_response_cannot_overwrite_a_newer_cookie() {
        let root = std::env::temp_dir().join(format!(
            "ccgui-baidu-tongji-stale-cookie-test-{}",
            Uuid::new_v4()
        ));
        let path = root.join("analytics").join("baidu-tongji.json");
        persist_visitor_cookie(&path, "newer-cookie").expect("persist newer cookie");
        let state = test_state(Some("newer-cookie"), Some(path.clone()));

        commit_response_cookie(
            &state,
            Some("old-cookie".to_string()),
            Some("stale-cookie".to_string()),
        )
        .await;

        assert_eq!(
            state.visitor_cookie.lock().await.as_deref(),
            Some("newer-cookie")
        );
        assert_eq!(
            read_visitor_cookie(&path)
                .expect("read newer cookie")
                .as_deref(),
            Some("newer-cookie")
        );

        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn site_id_constant_matches_the_existing_frontend_contract() {
        assert_eq!(BAIDU_TONGJI_SITE_ID, "b18f7c7bbeab70682b0a359e6b7b058d");
    }
}
