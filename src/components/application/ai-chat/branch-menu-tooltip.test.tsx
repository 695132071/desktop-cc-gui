import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { NativeTitleTooltip } from "@/components/base/tooltip/native-title-tooltip";
import { BranchMenu, type BranchMenuItem } from "./branch-menu";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BRANCHES: BranchMenuItem[] = [
  { name: "main" },
  { name: "fix/dsh-host-log-hygiene-and-retention" },
  { name: "origin/fix/dsh-host-log-hygiene-and-retention", isRemote: true },
];

/**
 * 真机验收发现：`title` 只挂在被截断的文字 span 上时，鼠标停在行内其他位置
 * （图标、文字右侧空白）没有气泡。这里把 `NativeTitleTooltip` 与真实组件一起挂上，
 * 断言「整行任意位置」都能弹出全名——`branch-menu.test.tsx` 里没有拦截器，那条
 * `title` 属性用例测的是 §2.3 契约，这条补的是端到端可见行为。
 */
describe("分支行整行全名气泡", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
    }
    container.remove();
    vi.useRealTimers();
  });

  async function openWithInterceptor() {
    const next = createRoot(container);
    root = next;
    await act(async () => {
      next.render(
        <>
          <NativeTitleTooltip />
          <BranchMenu branches={BRANCHES} currentName="main" />
        </>,
      );
    });
    await act(async () => {
      container.querySelector("button")!.click();
    });
    return document.querySelector<HTMLElement>('[role="dialog"]')!;
  }

  const rows = (dialog: HTMLElement) =>
    [...dialog.querySelectorAll<HTMLButtonElement>(".max-h-64 button")];

  const hover = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(
        new MouseEvent("pointerover", { bubbles: true, relatedTarget: null }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(700);
    });
  };

  it("整行带 title，并被拦截器搬进 data-native-tooltip", async () => {
    const row = rows(await openWithInterceptor())[2];
    expect(row.getAttribute("data-native-tooltip")).toBe(
      "origin/fix/dsh-host-log-hygiene-and-retention",
    );
    expect(row.getAttribute("title")).toBe("");
  });

  it("停在行的图标上（非文字子节点）也弹全名", async () => {
    const row = rows(await openWithInterceptor())[2];
    await hover(row.querySelector("svg")!);
    expect(document.querySelector('[role="tooltip"]')?.textContent ?? "").toContain(
      "origin/fix/dsh-host-log-hygiene-and-retention",
    );
  });

  it("停在被截断的文字上也弹全名", async () => {
    const row = rows(await openWithInterceptor())[2];
    await hover(row.querySelector("span.truncate")!);
    expect(document.querySelector('[role="tooltip"]')?.textContent ?? "").toContain(
      "origin/fix/dsh-host-log-hygiene-and-retention",
    );
  });
});