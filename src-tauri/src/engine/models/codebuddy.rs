use super::{run_probe, EngineCatalog, EngineModel};

pub(super) async fn codebuddy_catalog(bin: &str) -> EngineCatalog {
    let default_model = read_configured_default_model();

    // Live probe from the CLI binary
    if let Ok(stdout) = run_probe(bin, &["--help"], "help").await {
        let mut models = parse_help_models(&stdout);
        if !models.is_empty() {
            // Prioritize the user's configured default model within its group
            if let Some(def) = &default_model {
                let is_custom = def.starts_with("custom:");
                if is_custom {
                    let split_idx = models
                        .iter()
                        .position(|m| m.provider == "enterprise")
                        .unwrap_or(models.len());
                    if let Some(pos) = models[split_idx..].iter().position(|m| m.id == *def) {
                        let item = models.remove(split_idx + pos);
                        models.insert(split_idx, item);
                    } else {
                        models.push(EngineModel {
                            id: def.clone(),
                            name: Some(friendly_model_name(def)),
                            provider: "enterprise".to_string(),
                            description: None,
                            context_window: None,
                        });
                    }
                } else if let Some(pos) = models.iter().position(|m| m.id == *def) {
                    let item = models.remove(pos);
                    models.insert(0, item);
                } else {
                    models.insert(
                        0,
                        EngineModel {
                            id: def.clone(),
                            name: Some(friendly_model_name(def)),
                            provider: infer_provider(def).to_string(),
                            description: None,
                            context_window: None,
                        },
                    );
                }
            }
            return EngineCatalog::authoritative(models);
        }
    }

    // Fallback if probe fails (e.g. CLI missing or timeout)
    EngineCatalog {
        models: fallback_catalog(default_model.as_deref()),
        authoritative: false,
        remote: false,
    }
}

fn codebuddy_config_dir() -> std::path::PathBuf {
    // Same resolver as history/MCP (engine_home): expands `~`, and under
    // `cfg(test)` honors the HOME the tests set. A local copy ignored both, so
    // a relocated config dir was found by history/MCP but not here.
    crate::engine::engine_home(Some("CODEBUDDY_CONFIG_DIR"), ".codebuddy")
}

fn read_configured_default_model() -> Option<String> {
    let dir = codebuddy_config_dir();
    for name in ["settings.local.json", "settings.json"] {
        if let Ok(content) = std::fs::read_to_string(dir.join(name)) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(m) = v
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    return Some(m.to_string());
                }
                if let Some(m) = v
                    .pointer("/env/CODEBUDDY_MODEL")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    return Some(m.to_string());
                }
            }
        }
    }
    None
}

pub fn parse_help_models(text: &str) -> Vec<EngineModel> {
    let Some(start) = text.find("Currently supported: (") else {
        return Vec::new();
    };
    let after = &text[start + "Currently supported: (".len()..];
    let Some(end) = after.find(')') else {
        return Vec::new();
    };
    let list_str = &after[..end];

    let mut public_models = Vec::new();
    let mut enterprise_models = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    for raw in list_str.split(',') {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let id = trimmed.split('|').next().unwrap_or(trimmed).trim();
        if !seen_ids.insert(id.to_string()) {
            continue;
        }

        let is_custom = id.starts_with("custom:");
        let provider = if is_custom {
            "enterprise".to_string()
        } else {
            infer_provider(id).to_string()
        };
        let name = friendly_model_name(id);

        let model = EngineModel {
            id: id.to_string(),
            name: Some(name),
            description: None,
            provider,
            context_window: None,
        };

        if is_custom {
            enterprise_models.push(model);
        } else {
            public_models.push(model);
        }
    }

    // Public base models lead at the top; enterprise models are grouped at the bottom
    let mut models = public_models;
    models.extend(enterprise_models);
    models
}

fn infer_provider(id: &str) -> &'static str {
    let lower = id.to_lowercase();
    if lower.starts_with("hy") || lower.contains("hunyuan") {
        "hunyuan"
    } else if lower.contains("kimi") {
        "kimi"
    } else if lower.contains("deepseek") {
        "deepseek"
    } else if lower.contains("glm") || lower.contains("chatglm") {
        "chatglm"
    } else if lower.contains("minimax") {
        "minimax"
    } else if lower.contains("step") {
        "stepfun"
    } else {
        "codebuddy"
    }
}

fn friendly_model_name(id: &str) -> String {
    let bare = id.strip_prefix("custom:").unwrap_or(id);
    let (prefix, model) = if let Some((vendor, rest)) = bare.split_once('/') {
        (Some(vendor), rest)
    } else {
        (None, bare)
    };
    let model_name = match model {
        "hy4-preview" => "Hunyuan 4 Preview",
        "hy3" => "Hunyuan 3",
        "hy3-x" => "Hunyuan 3X",
        "step-5-preview" => "Step 5 Preview",
        "space-bunny" => "Space Bunny",
        "deepseek-v4-pro" => "DeepSeek V4 Pro",
        "deepseek-v4.1-flash" => "DeepSeek V4.1 Flash",
        "deepseek-flash" => "DeepSeek Flash",
        "glm-5.3" => "GLM 5.3",
        "glm-5.3-flash" => "GLM 5.3 Flash",
        "glm-5.3-flashx" => "GLM 5.3 FlashX",
        "glm-5.2" => "GLM 5.2",
        "glm-5.1" => "GLM 5.1",
        "glm-5v-turbo" => "GLM 5V Turbo",
        "minimax-m3.1-flash" => "MiniMax M3.1 Flash",
        "minimax-m3-pay" => "MiniMax M3",
        "minimax-m2.7" => "MiniMax M2.7",
        "kimi-k3" => "Kimi K3",
        "kimi-k3.1-pro" => "Kimi K3.1 Pro",
        "kimi-k3.1-pro-highspeed" => "Kimi K3.1 Pro Highspeed",
        "kimi-k3-2" => "Kimi K3.2",
        "kimi-k2.8-preview" => "Kimi K2.8 Preview",
        "kimi-k2.7" => "Kimi K2.7",
        "kimi-k2.6" => "Kimi K2.6",
        "mimo-v2.6-pro" => "MiMo V2.6 Pro",
        _ => model,
    };
    if let Some(vendor) = prefix {
        format!("{vendor}/{model_name}")
    } else {
        model_name.to_string()
    }
}

fn fallback_catalog(default_model: Option<&str>) -> Vec<EngineModel> {
    let mut models = vec![
        EngineModel {
            id: "hy4-preview".to_string(),
            name: Some("Hunyuan 4 Preview".to_string()),
            provider: "hunyuan".to_string(),
            description: None,
            context_window: Some(256_000),
        },
        EngineModel {
            id: "hy3".to_string(),
            name: Some("Hunyuan 3".to_string()),
            provider: "hunyuan".to_string(),
            description: None,
            context_window: Some(128_000),
        },
        EngineModel {
            id: "deepseek-v4-pro".to_string(),
            name: Some("DeepSeek V4 Pro".to_string()),
            provider: "deepseek".to_string(),
            description: None,
            context_window: Some(128_000),
        },
        EngineModel {
            id: "glm-5.3".to_string(),
            name: Some("GLM 5.3".to_string()),
            provider: "chatglm".to_string(),
            description: None,
            context_window: Some(128_000),
        },
    ];
    if let Some(def) = default_model {
        if !models.iter().any(|m| m.id == def) {
            let is_custom = def.starts_with("custom:");
            let item = EngineModel {
                id: def.to_string(),
                name: Some(friendly_model_name(def)),
                provider: if is_custom {
                    "enterprise".to_string()
                } else {
                    infer_provider(def).to_string()
                },
                description: None,
                context_window: None,
            };
            if is_custom {
                models.push(item);
            } else {
                models.insert(0, item);
            }
        }
    }
    models
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_help_models_separates_enterprise_models_to_bottom() {
        let help = r#"
  --model <model>  Model for the current session. Please provide the model ID. Currently supported: (custom:kimi-k3, hy4-preview, deepseek-v4-pro|deepseek-v4-pro)
"#;
        let models = parse_help_models(help);
        assert_eq!(models.len(), 3);

        // Public models come first
        assert_eq!(models[0].id, "hy4-preview");
        assert_eq!(models[0].provider, "hunyuan");
        assert_eq!(models[0].name.as_deref(), Some("Hunyuan 4 Preview"));

        assert_eq!(models[1].id, "deepseek-v4-pro");
        assert_eq!(models[1].provider, "deepseek");
        assert_eq!(models[1].name.as_deref(), Some("DeepSeek V4 Pro"));

        // Enterprise models placed at the bottom with provider "enterprise"
        assert_eq!(models[2].id, "custom:kimi-k3");
        assert_eq!(models[2].provider, "enterprise");
        assert_eq!(models[2].name.as_deref(), Some("Kimi K3"));
    }

    #[test]
    fn friendly_model_name_preserves_vendor_prefix() {
        assert_eq!(
            friendly_model_name("custom:vendor/glm-5.3"),
            "vendor/GLM 5.3"
        );
        assert_eq!(
            friendly_model_name("custom:glm-5.3"),
            "GLM 5.3"
        );
        assert_eq!(
            friendly_model_name("custom:kimi-k3.1-pro"),
            "Kimi K3.1 Pro"
        );
    }
}
