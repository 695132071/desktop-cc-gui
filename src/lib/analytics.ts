/**
 * Baidu Tongji (百度统计) analytics: PV/UV install + custom event tracking.
 *
 * Ported from the legacy desktop-cc-gui analytics module.
 *
 * Windows / macOS / web-access browser: external official `hm.js` script.
 * Linux native: WebKitGTK's NetworkProcess can crash on `hm.baidu.com`
 * requests (legacy desktop-cc-gui#blank-window), so an exact `hm.gif` Image
 * bridge is installed first and the official script + beacons travel over the
 * narrow Rust reqwest commands instead. The official script stays the payload
 * authority in both paths.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWeb } from "./transport";

const BAIDU_TONGJI_SITE_ID = "b18f7c7bbeab70682b0a359e6b7b058d";
const BAIDU_TONGJI_HOST = "hm.baidu.com";
const BAIDU_TONGJI_BEACON_PATH = "/hm.gif";
const IMAGE_BRIDGE_MARKER = Symbol("ccgui.baiduTongjiImageBridge");

type BridgedImageConstructor = typeof Image & {
  [IMAGE_BRIDGE_MARKER]?: true;
};

declare global {
  interface Window {
    _hmt?: unknown[][];
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Only the main window counts: secondary windows loading the same index.html
 * would each inflate PV. Scoped to main, 1 PV ≈ 1 app launch.
 */
function isMainWindow(): boolean {
  try {
    return (getCurrentWindow().label ?? "main") === "main";
  } catch {
    // Non-Tauri environment (browser, tests) counts as the main window.
    return true;
  }
}

function isLinuxNativeRuntime(): boolean {
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = (
    nav.userAgentData?.platform ||
    nav.platform ||
    nav.userAgent ||
    ""
  ).toLowerCase();
  return !isWeb && platform.includes("linux");
}

function isBaiduTongjiBeacon(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname === BAIDU_TONGJI_HOST &&
      url.pathname === BAIDU_TONGJI_BEACON_PATH
    );
  } catch {
    return false;
  }
}

function installNativeImageBridge(): void {
  const currentImage = window.Image as BridgedImageConstructor;
  if (currentImage[IMAGE_BRIDGE_MARKER]) {
    return;
  }
  const srcDescriptor = Object.getOwnPropertyDescriptor(
    window.HTMLImageElement.prototype,
    "src",
  );
  if (!srcDescriptor?.get || !srcDescriptor.set) {
    throw new Error("HTMLImageElement.src descriptor is unavailable");
  }

  const NativeImage = window.Image;
  const BridgedImage = function (width?: number, height?: number) {
    const image = new NativeImage(width, height);
    Object.defineProperty(image, "src", {
      configurable: true,
      enumerable: srcDescriptor.enumerable ?? true,
      get: () => srcDescriptor.get?.call(image),
      set: (value: string) => {
        const url = String(value);
        if (isBaiduTongjiBeacon(url)) {
          void invoke("send_baidu_tongji_beacon", {
            url,
            userAgent: navigator.userAgent,
          }).catch((error) => {
            console.warn(
              "[baidu-tongji] failed to send native analytics beacon",
              errorMessage(error),
            );
          });
          return;
        }
        srcDescriptor.set?.call(image, url);
      },
    });
    return image;
  } as unknown as BridgedImageConstructor;

  Object.setPrototypeOf(BridgedImage, NativeImage);
  BridgedImage.prototype = NativeImage.prototype;
  BridgedImage[IMAGE_BRIDGE_MARKER] = true;
  window.Image = BridgedImage;
}

function installLinuxNativeBaiduTongji(): void {
  try {
    installNativeImageBridge();
  } catch (error) {
    console.warn(
      "[baidu-tongji] failed to install native analytics bridge",
      errorMessage(error),
    );
    return;
  }

  window._hmt = window._hmt || [];
  void invoke("load_baidu_tongji_script", {
    userAgent: navigator.userAgent,
  }).catch((error) => {
    console.warn(
      "[baidu-tongji] failed to load native analytics script",
      errorMessage(error),
    );
  });
}

function installExternalBaiduTongji(): void {
  window._hmt = window._hmt || [];
  const script = document.createElement("script");
  script.src = `https://hm.baidu.com/hm.js?${BAIDU_TONGJI_SITE_ID}`;
  script.async = true;
  document.head.appendChild(script);
}

/**
 * Install Baidu Tongji (PV/UV). Production main window only; the install is
 * fire-and-forget and must never block or crash app startup.
 */
export function installBaiduTongji(): void {
  if (!import.meta.env.PROD || !isMainWindow()) {
    return;
  }
  if (isLinuxNativeRuntime()) {
    installLinuxNativeBaiduTongji();
    return;
  }
  installExternalBaiduTongji();
}
