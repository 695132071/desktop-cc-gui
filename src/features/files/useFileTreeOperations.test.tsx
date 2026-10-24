import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VisibleNode } from "./FileTreeRow";

const mocks = vi.hoisted(() => ({
  clipboardFileSnapshot: vi.fn(),
  setClipboardFilePaths: vi.fn(),
  pasteClipboardItems: vi.fn(),
  pasteItem: vi.fn(),
  listDir: vi.fn(async () => []),
  gitTreeStatus: vi.fn(async () => ({ repositories: [], fileColors: {} })),
  gitRepositorySummaries: vi.fn(async () => []),
  gitFileColors: vi.fn(async () => ({})),
  requestMention: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("@/features/browser/store", () => ({
  useBrowserStore: { getState: () => ({ deactivate: vi.fn() }) },
}));
vi.mock("@/features/chat/store", () => ({
  useChatStore: { getState: () => ({ requestMention: mocks.requestMention }) },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { message?: string }) =>
      opts?.message ? `${key}: ${opts.message}` : key,
  }),
}));

import { useFilesStore } from "./store";
import { useFileTreeOperations } from "./useFileTreeOperations";

/**
 * The tree's Copy/Paste must be the OS clipboard's Copy/Paste: Copy stages
 * the item for the menu *and* puts the file on the system clipboard, Paste
 * reads that clipboard first (a copy made in Finder / Explorer, or a newer
 * copy than our own) and only falls back to the in-app stage.
 */
function renderHook<T>(hook: () => T) {
  const result: { current: T } = {} as { current: T };
  function TestComponent() {
    result.current = hook();
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<TestComponent />);
  });
  return {
    result,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

const node = (path: string, isDir = false): VisibleNode => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir,
  size: 0,
  mtimeMs: 0,
  depth: 0,
  expanded: false,
  loading: false,
});

const contextMenuEvent = () =>
  ({ preventDefault: vi.fn(), clientX: 40, clientY: 60 }) as unknown as React.MouseEvent<HTMLElement>;

/** Drain the chained `await`s inside the fire-and-forget menu handlers. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("file tree clipboard sync", () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.clipboardFileSnapshot.mockResolvedValue({ paths: [], changeCount: null });
    mocks.setClipboardFilePaths.mockResolvedValue(undefined);
    mocks.pasteClipboardItems.mockResolvedValue({ created: [], failed: [] });
    mocks.pasteItem.mockResolvedValue({ path: "/repo/notes.md", isDir: false });
    useFilesStore.setState({
      root: "/repo",
      // No cached listing: revealInTree's invalidateDir then has nothing to
      // re-read, keeping the assertions to the clipboard calls.
      children: {},
      expanded: { "/repo": true },
      loadingDirs: {},
      dirErrors: {},
      clipboard: null,
      selectedPath: null,
      selectedIsDir: false,
    });
  });

  let unmount: (() => void) | null = null;
  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  it("Copy stages the item and puts the file on the OS clipboard", async () => {
    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;

    act(() => hook.result.current.openContextMenu(contextMenuEvent(), node("/repo/notes.md")));
    await act(async () => {
      hook.result.current.copyItem();
      await flush();
    });

    expect(useFilesStore.getState().clipboard).toEqual({ path: "/repo/notes.md", isDir: false });
    expect(mocks.setClipboardFilePaths).toHaveBeenCalledWith(["/repo/notes.md"]);
  });

  it("Paste uses the OS clipboard even when the in-app item differs", async () => {
    mocks.clipboardFileSnapshot.mockResolvedValue({ paths: ["/elsewhere/draft.md"], changeCount: 7 });
    mocks.pasteClipboardItems.mockResolvedValue({
      created: [{ path: "/repo/draft.md", isDir: false }],
      failed: [],
    });
    useFilesStore.setState({ clipboard: { path: "/repo/stale.md", isDir: false } });

    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;
    await act(async () => {
      hook.result.current.paste("/repo");
      await flush();
    });

    expect(mocks.pasteClipboardItems).toHaveBeenCalledWith("/repo");
    expect(mocks.pasteItem).not.toHaveBeenCalled();
  });

  it("Paste uses the new tree copy when its OS write failed and the old OS files remain", async () => {
    const write = deferred<void>();
    mocks.setClipboardFilePaths.mockReturnValue(write.promise);
    mocks.clipboardFileSnapshot.mockResolvedValue({ paths: ["/elsewhere/old-a.md"], changeCount: 7 });
    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;

    act(() => hook.result.current.openContextMenu(contextMenuEvent(), node("/repo/new-b.md")));
    act(() => hook.result.current.copyItem());
    await act(async () => {
      write.reject(new Error("clipboard is occupied"));
      await flush();
      hook.result.current.paste("/repo");
      await flush();
    });

    expect(mocks.pasteItem).toHaveBeenCalledWith("/repo/new-b.md", "/repo");
    expect(mocks.pasteClipboardItems).not.toHaveBeenCalled();
  });

  it("Paste prefers a newer external copy when its own OS write failed", async () => {
    mocks.setClipboardFilePaths.mockRejectedValue(new Error("clipboard is occupied"));
    mocks.clipboardFileSnapshot
      .mockResolvedValueOnce({ paths: ["/elsewhere/old-a.md"], changeCount: 7 })
      .mockResolvedValueOnce({ paths: ["/elsewhere/old-a.md"], changeCount: 7 })
      .mockResolvedValueOnce({ paths: ["/elsewhere/new-c.md"], changeCount: 8 })
      .mockResolvedValueOnce({ paths: ["/elsewhere/new-c.md"], changeCount: 8 });
    mocks.pasteClipboardItems.mockResolvedValue({
      created: [{ path: "/repo/new-c.md", isDir: false }],
      failed: [],
    });
    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;

    await act(async () => {
      hook.result.current.openContextMenu(contextMenuEvent(), node("/repo/new-b.md"));
      await flush();
      hook.result.current.copyItem();
      await flush();
      hook.result.current.paste("/repo");
      await flush();
    });

    expect(mocks.pasteClipboardItems).toHaveBeenCalledWith("/repo");
    expect(mocks.pasteItem).not.toHaveBeenCalled();
  });

  it("Paste waits for an in-flight copy write before choosing its source", async () => {
    const write = deferred<void>();
    mocks.setClipboardFilePaths.mockReturnValue(write.promise);
    mocks.clipboardFileSnapshot.mockResolvedValue({
      paths: ["/repo/new-b.md"],
      changeCount: 8,
    });
    mocks.pasteClipboardItems.mockResolvedValue({
      created: [{ path: "/repo/new-b.md", isDir: false }],
      failed: [],
    });
    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;
    act(() => hook.result.current.openContextMenu(contextMenuEvent(), node("/repo/new-b.md")));
    await act(async () => {
      hook.result.current.copyItem();
      await flush();
      hook.result.current.paste("/repo");
      await flush();
    });
    expect(mocks.pasteClipboardItems).not.toHaveBeenCalled();
    expect(mocks.pasteItem).not.toHaveBeenCalled();

    await act(async () => {
      write.resolve();
      await flush();
    });
    expect(mocks.pasteClipboardItems).toHaveBeenCalledWith("/repo");
    expect(mocks.pasteItem).not.toHaveBeenCalled();
  });

  it("serializes consecutive copies so an older write cannot finish last", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    mocks.setClipboardFilePaths
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;
    act(() => hook.result.current.openContextMenu(contextMenuEvent(), node("/repo/a.md")));
    await act(async () => {
      hook.result.current.copyItem();
      await flush();
    });
    act(() => hook.result.current.openContextMenu(contextMenuEvent(), node("/repo/b.md")));
    await act(async () => {
      hook.result.current.copyItem();
      await flush();
    });
    expect(mocks.setClipboardFilePaths).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve();
      await flush();
    });
    expect(mocks.setClipboardFilePaths).toHaveBeenLastCalledWith(["/repo/b.md"]);
    expect(mocks.setClipboardFilePaths).toHaveBeenCalledTimes(2);
    await act(async () => {
      second.resolve();
      await flush();
    });
  });
  it("does not paste the failed tree copy after an external text-only copy", async () => {
    mocks.setClipboardFilePaths.mockRejectedValue(new Error("clipboard is occupied"));
    mocks.clipboardFileSnapshot
      .mockResolvedValueOnce({ paths: ["/elsewhere/old-a.md"], changeCount: 7 })
      .mockResolvedValueOnce({ paths: ["/elsewhere/old-a.md"], changeCount: 7 })
      .mockResolvedValueOnce({ paths: [], changeCount: 8 })
      .mockResolvedValueOnce({ paths: [], changeCount: 8 });
    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;

    await act(async () => {
      hook.result.current.openContextMenu(contextMenuEvent(), node("/repo/new-b.md"));
      await flush();
    });
    await act(async () => {
      hook.result.current.copyItem();
      await flush();
    });
    await act(async () => {
      hook.result.current.paste("/repo");
      await flush();
    });

    expect(mocks.pasteItem).not.toHaveBeenCalled();
    expect(mocks.pasteClipboardItems).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toBe("files.pasteUnavailable");
  });
  it("Paste falls back to the in-app item when the OS clipboard has no files", async () => {
    useFilesStore.setState({ clipboard: { path: "/repo/notes.md", isDir: false } });

    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;
    await act(async () => {
      hook.result.current.paste("/repo");
      await flush();
    });

    expect(mocks.pasteClipboardItems).not.toHaveBeenCalled();
    expect(mocks.pasteItem).toHaveBeenCalledWith("/repo/notes.md", "/repo");
  });

  it("Paste reports an OS read failure instead of falling back to a stale tree item", async () => {
    mocks.clipboardFileSnapshot.mockRejectedValue(new Error("clipboard is occupied"));
    useFilesStore.setState({ clipboard: { path: "/repo/stale-a.md", isDir: false } });
    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;

    await act(async () => {
      hook.result.current.paste("/repo");
      await flush();
    });

    expect(mocks.pasteItem).not.toHaveBeenCalled();
    expect(mocks.pasteClipboardItems).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toBe("files.opFailed: clipboard is occupied");
  });

  it("Paste says so when neither clipboard has a source", async () => {
    useFilesStore.setState({ clipboard: null });

    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;
    await act(async () => {
      hook.result.current.paste("/repo");
      await flush();
    });

    expect(mocks.pasteItem).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toBe("files.pasteUnavailable");
  });

  it("reports items the host could not copy instead of failing silently", async () => {
    mocks.clipboardFileSnapshot.mockResolvedValue({ paths: ["/elsewhere/gone.md"], changeCount: 7 });
    mocks.pasteClipboardItems.mockResolvedValue({
      created: [],
      failed: ["stat /elsewhere/gone.md: not found"],
    });

    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;
    await act(async () => {
      hook.result.current.paste("/repo");
      await flush();
    });

    expect(hook.result.current.notice).toBe(
      "files.opFailed: stat /elsewhere/gone.md: not found",
    );
  });

  it("says so when the OS clipboard empties before the host reads it", async () => {
    mocks.clipboardFileSnapshot.mockResolvedValue({ paths: ["/elsewhere/draft.md"], changeCount: 7 });
    mocks.pasteClipboardItems.mockResolvedValue({ created: [], failed: [] });

    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;
    await act(async () => {
      hook.result.current.paste("/repo");
      await flush();
    });

    expect(hook.result.current.notice).toBe("files.pasteUnavailable");
  });

  it("enables Paste from the OS clipboard alone", async () => {
    mocks.clipboardFileSnapshot.mockResolvedValue({ paths: ["/elsewhere/draft.md"], changeCount: 7 });
    useFilesStore.setState({ clipboard: null });

    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;
    expect(hook.result.current.canPaste).toBe(false);

    await act(async () => {
      hook.result.current.openContextMenu(contextMenuEvent(), node("/repo"));
      await flush();
    });

    expect(hook.result.current.canPaste).toBe(true);
  });

  it("ignores an older menu clipboard probe that resolves after the latest one", async () => {
    const first = deferred<{ paths: string[]; changeCount: number }>();
    const second = deferred<{ paths: string[]; changeCount: number }>();
    mocks.clipboardFileSnapshot
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    useFilesStore.setState({ clipboard: null });
    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;

    act(() => {
      hook.result.current.openContextMenu(contextMenuEvent(), node("/repo/first"));
      hook.result.current.openContextMenu(contextMenuEvent(), node("/repo/second"));
    });
    await act(async () => {
      second.resolve({ paths: [], changeCount: 8 });
      await flush();
    });
    expect(hook.result.current.canPaste).toBe(false);

    await act(async () => {
      first.resolve({ paths: ["/elsewhere/old-a.md"], changeCount: 7 });
      await flush();
    });
    expect(hook.result.current.canPaste).toBe(false);
  });

  it("ignores a menu clipboard probe that resolves after unmount", async () => {
    const probe = deferred<{ paths: string[]; changeCount: number }>();
    mocks.clipboardFileSnapshot.mockReturnValue(probe.promise);
    useFilesStore.setState({ clipboard: null });
    const hook = renderHook(() => useFileTreeOperations());

    act(() => hook.result.current.openContextMenu(contextMenuEvent(), node("/repo")));
    hook.unmount();
    await act(async () => {
      probe.resolve({ paths: ["/elsewhere/old-a.md"], changeCount: 7 });
      await flush();
    });
    expect(mocks.setClipboardFilePaths).not.toHaveBeenCalled();
    expect(mocks.pasteClipboardItems).not.toHaveBeenCalled();
  });

  it("restarts Paste source selection when a Copy arrives during its read", async () => {
    const firstRead = deferred<{ paths: string[]; changeCount: number }>();
    mocks.clipboardFileSnapshot
      .mockReturnValueOnce(firstRead.promise)
      .mockResolvedValue({ paths: ["/repo/new-b.md"], changeCount: 8 });
    mocks.pasteClipboardItems.mockResolvedValue({
      created: [{ path: "/repo/new-b.md", isDir: false }],
      failed: [],
    });
    useFilesStore.setState({ clipboard: null });
    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;
    await act(async () => {
      hook.result.current.paste("/repo");
      await flush();
    });
    expect(mocks.pasteClipboardItems).not.toHaveBeenCalled();

    act(() => hook.result.current.openContextMenu(contextMenuEvent(), node("/repo/new-b.md")));
    await act(async () => {
      firstRead.resolve({ paths: ["/elsewhere/old-a.md"], changeCount: 7 });
      await flush();
      hook.result.current.copyItem();
      await flush();
    });

    expect(mocks.pasteClipboardItems).toHaveBeenCalledWith("/repo");
    expect(mocks.pasteItem).not.toHaveBeenCalled();
  });
  it("ignores a menu clipboard probe that resolves after the menu closes", async () => {
    const probe = deferred<{ paths: string[]; changeCount: number }>();
    mocks.clipboardFileSnapshot.mockReturnValue(probe.promise);
    useFilesStore.setState({ clipboard: null });
    const hook = renderHook(() => useFileTreeOperations());
    unmount = hook.unmount;
    act(() => {
      hook.result.current.openContextMenu(contextMenuEvent(), node("/repo"));
      hook.result.current.closeMenu();
    });
    await act(async () => {
      probe.resolve({ paths: ["/elsewhere/old-a.md"], changeCount: 7 });
      await flush();
    });
    expect(hook.result.current.canPaste).toBe(false);
    expect(mocks.pasteClipboardItems).not.toHaveBeenCalled();
  });
});
