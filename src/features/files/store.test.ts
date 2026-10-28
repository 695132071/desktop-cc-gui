import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "@/lib/ipc";

const mocks = vi.hoisted(() => ({
  listDir: vi.fn(),
  readFile: vi.fn(async () => ({ kind: "text", text: "", dataUrl: null, truncated: false })),
  gitTreeStatus: vi.fn(),
  gitRepositorySummaries: vi.fn(),
  gitFileColors: vi.fn(),
}));
const browserMock = vi.hoisted(() => ({ deactivate: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("@/features/browser/store", () => ({
  useBrowserStore: { getState: () => browserMock },
}));
import { useGitStore } from "@/features/git/store";
import { resetMissionStore, useMissionStore } from "@/features/mission/store";
import { usePluginHubStore } from "@/features/plugins/hub/store";
import { usePluginTabsStore } from "@/features/plugins/runtime/center-tabs";
import { fileTreeWorkspaceKey, useFilesStore } from "./store";
import { useFileTreePreferencesStore } from "./tree-preferences";

const entry = (name: string, isDir = false): DirEntry => ({ name, isDir, size: 0, mtimeMs: 0 });
const emptyStatus = () => ({ repositories: [], fileColors: {} });

describe("文件树单链展开与记忆", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.gitTreeStatus.mockResolvedValue(emptyStatus());
    useFileTreePreferencesStore.setState({ hideIgnored: false });
    useFilesStore.setState({ root: "/chain", children: { "/chain": [entry("src", true)] }, expanded: { "/chain": true }, loadingDirs: {}, dirErrors: {}, repositories: {}, fileColors: {} });
    localStorage.removeItem(fileTreeWorkspaceKey("/chain"));
  });

  it("一次点击沿唯一子目录读到含文件的链尾", async () => {
    mocks.listDir.mockImplementation(async (path: string) => ({
      "/chain/src": [entry("main", true)],
      "/chain/src/main": [entry("java", true)],
      "/chain/src/main/java": [entry("App.java")],
    })[path] ?? []);
    await useFilesStore.getState().toggleCompactDir(["/chain/src"]);
    expect(mocks.listDir.mock.calls.map(([path]) => path)).toEqual([
      "/chain/src", "/chain/src/main", "/chain/src/main/java",
    ]);
    expect(useFilesStore.getState().expanded).toMatchObject({
      "/chain/src": true, "/chain/src/main": true, "/chain/src/main/java": true,
    });
    expect(useFilesStore.getState().children["/chain/src/main/java"]).toEqual([entry("App.java")]);
  });

  it("读取途中收起目录后不继续展开晚到的子目录", async () => {
    let finish!: (entries: DirEntry[]) => void;
    mocks.listDir.mockReturnValue(new Promise<DirEntry[]>((resolve) => { finish = resolve; }));
    const click = useFilesStore.getState().toggleCompactDir(["/chain/src"]);
    await useFilesStore.getState().toggleDir("/chain/src");
    finish([entry("main", true)]);
    await click;
    expect(useFilesStore.getState().expanded["/chain/src/main"]).toBeUndefined();
    expect(mocks.listDir).toHaveBeenCalledTimes(1);
  });

  it("隐藏 Git 忽略项时不沿其展开，也不批量展开", async () => {
    useFileTreePreferencesStore.setState({ hideIgnored: true });
    useFilesStore.setState({ children: {
      "/chain": [entry("src", true), { ...entry("cache", true), ignored: true }],
      "/chain/src": [{ ...entry("ignored", true), ignored: true }, entry("Main.java")],
      "/chain/cache": [],
    } });
    await useFilesStore.getState().toggleCompactDir(["/chain/src"]);
    expect(useFilesStore.getState().expanded["/chain/src/ignored"]).toBeUndefined();
    useFilesStore.getState().expandLoadedDirs();
    expect(useFilesStore.getState().expanded["/chain/cache"]).toBeUndefined();
    expect(mocks.listDir).not.toHaveBeenCalled();
  });

  it("收起父目录清理后代展开路径，持久化只保留可达路径", async () => {
    useFilesStore.setState({ expanded: { "/chain": true, "/chain/src": true, "/chain/src/main": true } });
    await useFilesStore.getState().toggleDir("/chain/src");
    expect(useFilesStore.getState().expanded).toEqual({ "/chain": true });
    expect(JSON.parse(localStorage.getItem(fileTreeWorkspaceKey("/chain"))!)).toEqual({ expanded: ["/chain"] });
  });

  it("切换工作区后分别恢复展开路径，持久化内容不含过滤配置", () => {
    mocks.listDir.mockResolvedValue([]);
    useFilesStore.setState({ expanded: { "/chain": true, "/chain/src": true } });
    useFilesStore.getState().setRoot("/other");
    expect(useFilesStore.getState().expanded).toEqual({ "/other": true });
    useFilesStore.getState().setRoot("/chain");
    expect(useFilesStore.getState().expanded).toEqual({ "/chain": true, "/chain/src": true });
    expect(JSON.parse(localStorage.getItem(fileTreeWorkspaceKey("/chain"))!)).toEqual({
      expanded: ["/chain", "/chain/src"],
    });
  });

  it("刷新不重读当前被隐藏的 Git 忽略目录", async () => {
    useFileTreePreferencesStore.setState({ hideIgnored: true });
    useFilesStore.setState({
      children: { "/chain": [{ ...entry("cache", true), ignored: true }], "/chain/cache": [] },
      expanded: { "/chain": true, "/chain/cache": true },
    });
    mocks.listDir.mockResolvedValue([]);
    await useFilesStore.getState().refreshTree();
    expect(mocks.listDir.mock.calls.map(([path]) => path)).toEqual(["/chain"]);
  });
});

describe("file tree Git refresh", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    mocks.listDir.mockResolvedValue([entry("file.txt")]);
    mocks.gitTreeStatus.mockResolvedValue(emptyStatus());
    mocks.gitRepositorySummaries.mockResolvedValue([]);
    mocks.gitFileColors.mockResolvedValue({});
    useFilesStore.setState({ root: "/repo", children: { "/repo": [entry("sub", true)], "/repo/sub": [] }, expanded: { "/repo": true, "/repo/sub": true }, loadingDirs: {}, dirErrors: {}, repositories: {}, fileColors: {}, refreshing: false });
  });

  it("batches all loaded levels instead of requesting a scan per directory", async () => {
    await useFilesStore.getState().refreshTree();
    expect(mocks.gitTreeStatus).toHaveBeenCalledTimes(1);
    expect(mocks.gitTreeStatus).toHaveBeenCalledWith([
      { path: "/repo", files: ["file.txt"], directories: [] },
      { path: "/repo/sub", files: ["file.txt"], directories: [] },
    ]);
    expect(mocks.gitFileColors).not.toHaveBeenCalled();
    expect(mocks.gitRepositorySummaries).not.toHaveBeenCalled();
  });

  it("keeps refreshing true until Git settles and rejects duplicate refreshes", async () => {
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof emptyStatus>) => void;
    const pending = new Promise<ReturnType<typeof emptyStatus>>((resolve) => { finish = resolve; });
    mocks.gitTreeStatus.mockReturnValue(pending);
    mocks.gitFileColors.mockReturnValue(pending);
    const refresh = useFilesStore.getState().refreshTree();
    await vi.advanceTimersByTimeAsync(600);
    expect(useFilesStore.getState().refreshing).toBe(true);
    await useFilesStore.getState().refreshTree();
    expect(mocks.listDir).toHaveBeenCalledTimes(2);
    finish(emptyStatus());
    await refresh;
    expect(useFilesStore.getState().refreshing).toBe(false);
  });

  it("removes obsolete repository badges and colors after a successful refresh", async () => {
    useFilesStore.setState({ repositories: { "/repo": { path: "/repo", branch: "main", changed: 1, untracked: 0 } }, fileColors: { "/repo": { "file.txt": "modified" } } });
    await useFilesStore.getState().refreshTree();
    expect(useFilesStore.getState().repositories).toEqual({});
    expect(useFilesStore.getState().fileColors["/repo"]).toEqual({});
  });

  it("awaits Git when invalidating a directory and recovers from Git failure", async () => {
    let fail!: (error: Error) => void;
    mocks.gitTreeStatus.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    let settled = false;
    const refresh = useFilesStore.getState().invalidateDir("/repo").then(() => { settled = true; });
    await vi.waitFor(() => expect(mocks.gitTreeStatus).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);
    fail(new Error("Git unavailable"));
    await refresh;
    expect(settled).toBe(true);
    expect(useFilesStore.getState().children["/repo"]).toEqual([entry("file.txt")]);
  });

  it("retains cached Git state on failure and allows a fresh retry", async () => {
    useFilesStore.setState({ fileColors: { "/repo": { "file.txt": "modified" } } });
    mocks.gitTreeStatus.mockRejectedValueOnce(new Error("Git unavailable"));
    await useFilesStore.getState().refreshTree();
    expect(useFilesStore.getState().refreshing).toBe(false);
    expect(useFilesStore.getState().fileColors["/repo"]).toEqual({ "file.txt": "modified" });
    await useFilesStore.getState().refreshTree();
    expect(mocks.gitTreeStatus).toHaveBeenCalledTimes(2);
    expect(useFilesStore.getState().fileColors["/repo"]).toEqual({});
  });

  it("discards old Git replies after switching away and back to the same root", async () => {
    let finish!: (value: { repositories: []; fileColors: Record<string, Record<string, string>> }) => void;
    mocks.gitTreeStatus.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const refresh = useFilesStore.getState().refreshTree();
    await vi.waitFor(() => expect(mocks.gitTreeStatus).toHaveBeenCalledTimes(1));
    useFilesStore.getState().setRoot("");
    useFilesStore.getState().setRoot("/repo");
    await vi.waitFor(() => expect(mocks.gitTreeStatus).toHaveBeenCalledTimes(2));
    finish({ repositories: [], fileColors: { "/repo": { "stale.txt": "modified" } } });
    await refresh;
    expect(useFilesStore.getState().fileColors["/repo"]).toEqual({});
  });
});

/** list_dir 在后台线程跑，同一目录的两次列举可能乱序返回：只有最新一次能写入。 */
describe("file tree listings of one directory", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
    mocks.gitTreeStatus.mockResolvedValue(emptyStatus());
    useFilesStore.setState({ root: "/repo", children: { "/repo": [entry("old.txt")] }, expanded: {}, loadingDirs: {}, dirErrors: {}, repositories: {}, fileColors: {}, refreshing: false });
  });

  function deferredListing() {
    let resolve!: (entries: DirEntry[]) => void;
    mocks.listDir.mockReturnValueOnce(new Promise<DirEntry[]>((r) => { resolve = r; }));
    return resolve;
  }

  it("asks for Git ignore flags bounded by the tree root", async () => {
    mocks.listDir.mockResolvedValue([entry("a.txt")]);
    await useFilesStore.getState().invalidateDir("/repo");
    expect(mocks.listDir).toHaveBeenCalledWith("/repo", { gitIgnoreRoot: "/repo" });
  });

  it("a refresh listing that resolves after a newer invalidate does not overwrite it", async () => {
    const finishRefresh = deferredListing();
    mocks.listDir.mockResolvedValueOnce([entry("renamed.txt")]);
    const refresh = useFilesStore.getState().refreshTree();
    await useFilesStore.getState().invalidateDir("/repo");
    expect(useFilesStore.getState().children["/repo"]).toEqual([entry("renamed.txt")]);

    finishRefresh([entry("before-rename.txt")]);
    await refresh;
    expect(useFilesStore.getState().children["/repo"]).toEqual([entry("renamed.txt")]);
    expect(useFilesStore.getState().refreshing).toBe(false);
  });

  it("a superseded first load still clears its loading flag", async () => {
    useFilesStore.setState({ children: { "/repo": [entry("sub", true)] }, expanded: { "/repo": true, "/repo/sub": true } });
    const finishLoad = deferredListing();
    mocks.listDir.mockResolvedValue([entry("fresh.txt")]);
    const load = useFilesStore.getState().ensureDir("/repo/sub");
    await useFilesStore.getState().refreshTree();
    expect(useFilesStore.getState().children["/repo/sub"]).toEqual([entry("fresh.txt")]);

    finishLoad([entry("stale.txt")]);
    await load;
    expect(useFilesStore.getState().children["/repo/sub"]).toEqual([entry("fresh.txt")]);
    expect(useFilesStore.getState().loadingDirs["/repo/sub"]).toBeUndefined();
  });
});

/** 文件抢到中心时，其余中心面（插件中心/插件页/工作台/差异/浏览器）要让位，
 *  否则编辑器页签亮了，画面还停在原来那一面。 */
describe("文件打开时的中心面互斥", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFilesStore.setState({
      root: "/repo",
      children: {},
      expanded: {},
      loadingDirs: {},
      dirErrors: {},
      repositories: {},
      fileColors: {},
      refreshing: false,
      openFiles: [],
      fileStates: {},
      activeFilePath: null,
      dirtyPaths: {},
    });
    usePluginHubStore.setState({ open: true, active: true, view: "market" });
    usePluginTabsStore.setState({ tabs: ["plugin:demo:main"], activeId: "plugin:demo:main" });
    resetMissionStore();
    useMissionStore.setState({ open: true, active: true });
    useGitStore.setState({
      diffView: { workspacePath: "/repo", target: { file: "a.ts", staged: false } },
    });
  });

  afterEach(() => {
    usePluginHubStore.setState({ open: false, active: false, view: "market" });
    usePluginTabsStore.setState({ tabs: [], activeId: null });
    resetMissionStore();
    useGitStore.setState({ diffView: null });
  });

  function expectOnlyFileLeft() {
    expect(usePluginHubStore.getState().active).toBe(false);
    expect(usePluginTabsStore.getState().activeId).toBeNull();
    expect(useMissionStore.getState().active).toBe(false);
    expect(useGitStore.getState().diffView).toBeNull();
    expect(browserMock.deactivate).toHaveBeenCalled();
  }

  it("openFile（文件树/搜索/插件桥）让其他中心面靠边", async () => {
    await useFilesStore.getState().openFile("/repo/a.ts");
    expectOnlyFileLeft();
    expect(useFilesStore.getState().activeFilePath).toBe("/repo/a.ts");
  });

  it("activateFile（页签选择/已加载文件）同样清场", () => {
    useFilesStore.setState({
      fileStates: {
        "/repo/a.ts": {
          path: "/repo/a.ts",
          content: { kind: "text", text: "", dataUrl: null, truncated: false, readOnly: false },
          loading: false,
          error: null,
          loadNonce: 0,
        },
      },
    });
    useFilesStore.getState().activateFile("/repo/a.ts");
    expectOnlyFileLeft();
    expect(useFilesStore.getState().activeFilePath).toBe("/repo/a.ts");
  });
});
