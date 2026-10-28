import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "@/lib/i18n";
import { BranchMenu, type BranchMenuItem } from "./branch-menu";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BRANCHES: BranchMenuItem[] = [
  { name: "main" },
  { name: "fix/login-flash" },
  { name: "origin/fix/login-flash", isRemote: true },
  { name: "release/v1.1.6" },
];

describe("BranchMenu 分支过滤与全名提示", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
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
  });

  async function open(onSelect = vi.fn()) {
    const nextRoot = createRoot(container);
    root = nextRoot;
    await act(async () => {
      nextRoot.render(
        <BranchMenu branches={BRANCHES} currentName="main" onSelect={onSelect} />,
      );
    });
    await act(async () => {
      trigger().click();
    });
    return onSelect;
  }

  function trigger() {
    return container.querySelector<HTMLButtonElement>("button")!;
  }

  /** The popover portals to <body>, so its contents live outside `container`. */
  function dialog() {
    return document.querySelector<HTMLElement>('[role="dialog"]');
  }

  function rows() {
    return [...dialog()!.querySelectorAll<HTMLButtonElement>(".max-h-64 button")];
  }

  function names() {
    return rows().map((row) => row.querySelector("span.truncate")!.textContent);
  }

  /** Controlled input: React tracks the value setter, so set it natively. */
  async function type(value: string) {
    const input = dialog()!.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!
        .set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("无输入时列全部，输入后大小写不敏感地过滤且远程徽标保留", async () => {
    await open();
    expect(names()).toEqual([
      "main",
      "fix/login-flash",
      "origin/fix/login-flash",
      "release/v1.1.6",
    ]);
    await type("LOGIN");
    expect(names()).toEqual(["fix/login-flash", "origin/fix/login-flash"]);
    expect(rows()[1].textContent).toContain("远程分支");
  });

  it("过滤后点行仍只触发一次 onSelect 并关闭弹层", async () => {
    const onSelect = await open();
    await type("release");
    await act(async () => {
      rows()[0].click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("release/v1.1.6");
    expect(dialog()).toBeNull();
  });

  it("无匹配时给出空态且不残留任何行", async () => {
    await open();
    await type("zzz-no-such-branch");
    expect(rows()).toHaveLength(0);
    expect(dialog()!.textContent).toContain("无匹配分支");
  });

  it("每一行整行带 title = 分支全名（不只在被截断的文字上）", async () => {
    await open();
    for (const row of rows()) {
      const name = row.querySelector("span.truncate")!.textContent;
      expect(row.getAttribute("title")).toBe(name);
    }
  });

  it("重新打开不残留上一次的过滤条件", async () => {
    await open();
    await type("login");
    expect(names()).toHaveLength(2);
    await act(async () => {
      trigger().click(); // close
    });
    await act(async () => {
      trigger().click(); // reopen
    });
    expect(names()).toEqual([
      "main",
      "fix/login-flash",
      "origin/fix/login-flash",
      "release/v1.1.6",
    ]);
  });

  it("打开后焦点落在搜索框，搜索框是弹层第一个元素且不在滚动体内", async () => {
    await open();
    const input = dialog()!.querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(input);
    // 「搜索框在列表上方且不随列表滚动」的直接证据：它不是滚动体的后代。
    expect(input.closest(".max-h-64")).toBeNull();
    // 选定布局：第一行就是搜索框（没有「分支」标题行）。
    const column = dialog()!.firstElementChild as HTMLElement;
    expect(column.firstElementChild).toBe(input.parentElement);
  });

  it("Esc 关闭弹层（焦点进入弹层后才生效）", async () => {
    await open();
    const input = dialog()!.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
  });
});