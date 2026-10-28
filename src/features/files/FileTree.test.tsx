import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "@/lib/i18n";
import { useFilesStore } from "./store";
import { FileTree } from "./FileTree";

vi.mock("./useFileTreeVirtualList", () => ({
  useFileTreeVirtualList: () => ({ parentRef: { current: null }, virtualizer: {}, visible: [] }),
}));
vi.mock("./useFileTreeOperations", () => ({
  useFileTreeOperations: () => ({ openContextMenu: vi.fn() }),
}));
vi.mock("./FileTreeBody", () => ({ FileTreeBody: () => <button>树节点</button> }));
vi.mock("./FileTreeOverlays", () => ({ FileTreeOverlays: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const expandLoadedDirs = vi.fn();
const collapseAllDirs = vi.fn();

beforeEach(() => {
  expandLoadedDirs.mockClear();
  collapseAllDirs.mockClear();
  useFilesStore.setState({ root: "/repo", expandLoadedDirs, collapseAllDirs });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<FileTree />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("工具条按钮和文件树内快捷键执行同一操作", () => {
  const buttons = container.querySelectorAll<HTMLButtonElement>("button[aria-keyshortcuts]");
  expect(buttons).toHaveLength(2);
  act(() => {
    buttons[0].click();
    buttons[1].click();
    container.querySelector("button:not([aria-keyshortcuts])")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, shiftKey: true, bubbles: true }),
    );
    container.querySelector("button:not([aria-keyshortcuts])")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, shiftKey: true, bubbles: true }),
    );
  });
  expect(expandLoadedDirs).toHaveBeenCalledTimes(2);
  expect(collapseAllDirs).toHaveBeenCalledTimes(2);
});
