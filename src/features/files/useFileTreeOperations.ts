import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/lib/clipboard";
import { ipc, type ClipboardFileSnapshot } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { joinPath, parentPath, useFilesStore, type TreeClipboard } from "./store";
import type { FileTreeMenuState } from "./FileTreeContextMenu";
import type { VisibleNode } from "./FileTreeRow";
import { useChatStore } from "@/features/chat/store";

interface PendingTreeCopy {
  id: number;
  /** Undefined means no unchanged clipboard generation was proven. */
  beforeChangeCount?: number | null;
  write: Promise<void>;
}
interface PromptState {
  kind: "newFile" | "newFolder" | "rename";
  /** Parent dir for newFile/newFolder; the item itself for rename. */
  path: string;
  isDir: boolean;
}

interface TrashTarget {
  path: string;
  isDir: boolean;
}

export interface FileTreeOperations {
  clipboard: TreeClipboard | null;
  /** Paste has a source: the in-app tree clipboard, or a file list the OS
   *  clipboard currently holds (Finder / Explorer copy). */
  canPaste: boolean;
  menu: FileTreeMenuState | null;
  prompt: PromptState | null;
  trashTarget: TrashTarget | null;
  notice: string | null;
  openContextMenu: (event: MouseEvent<HTMLElement>, node: VisibleNode) => void;
  closeMenu: () => void;
  startNewFile: (dir: string) => void;
  startNewFolder: (dir: string) => void;
  copyItem: () => void;
  paste: (dir: string) => void;
  duplicate: () => void;
  startRename: () => void;
  copyPath: () => void;
  sendPath: () => void;
  revealInFileManager: () => void;
  startTrash: () => void;
  submitPrompt: (name: string) => void;
  cancelPrompt: () => void;
  confirmTrash: () => void;
  cancelTrash: () => void;
  dismissNotice: () => void;
}

/**
 * Context-menu and file-operation state for the tree: menu/prompt/trash
 * dialog targets, the auto-dismissing failure notice, and every action the
 * menu entries trigger.
 */
export function useFileTreeOperations(): FileTreeOperations {
  const { t } = useTranslation();
  const root = useFilesStore((s) => s.root);
  const clipboard = useFilesStore((s) => s.clipboard);
  const toggleDir = useFilesStore((s) => s.toggleDir);
  const invalidateDir = useFilesStore((s) => s.invalidateDir);
  const selectPath = useFilesStore((s) => s.selectPath);

  const copyIdRef = useRef(0);
  const pendingCopyRef = useRef<PendingTreeCopy | null>(null);
  const clipboardWriteRef = useRef<Promise<void>>(Promise.resolve());
  const clipboardProbeRef = useRef(0);
  const mountedRef = useRef(true);
  const [menu, setMenu] = useState<FileTreeMenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [trashTarget, setTrashTarget] = useState<TrashTarget | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** File list the OS clipboard held when the menu opened; `null` until the
   *  first probe resolves. Only gates Paste's enabled state — the paste
   *  itself re-reads the clipboard, which can change while the menu is up. */
  const [systemClipboard, setSystemClipboard] = useState<string[] | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      copyIdRef.current += 1;
      clipboardProbeRef.current += 1;
    };
  }, []);

  const opFailed = useCallback(
    (e: unknown) => {
      if (mountedRef.current) setNotice(t("files.opFailed", { message: errorText(e) }));
    },
    [t],
  );

  const openContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>, node: VisibleNode) => {
      event.preventDefault();
      selectPath(node.path, node.isDir);
      setMenu({ x: event.clientX, y: event.clientY, path: node.path, isDir: node.isDir });
      // Only the latest open may update Paste; closing invalidates the probe.
      const probeId = ++clipboardProbeRef.current;
      setSystemClipboard(null);
      void ipc
        .clipboardFileSnapshot()
        .then((snapshot) => {
          if (mountedRef.current && clipboardProbeRef.current === probeId) {
            setSystemClipboard(snapshot.paths);
          }
        })
        .catch(() => {
          if (mountedRef.current && clipboardProbeRef.current === probeId) {
            setSystemClipboard([]);
          }
        });
    },
    [selectPath],
  );

  /** Refresh the (loaded) parent listing, expand it when collapsed, and
   *  select the operation result so the user sees what changed. */
  const revealInTree = useCallback(
    async (dir: string, target: string | null, isDir: boolean) => {
      if (dir && dir !== root && !useFilesStore.getState().expanded[dir]) {
        await toggleDir(dir);
      }
      await invalidateDir(dir);
      if (target) selectPath(target, isDir);
    },
    [root, toggleDir, invalidateDir, selectPath],
  );

  const closeMenu = useCallback(() => {
    clipboardProbeRef.current += 1;
    setMenu(null);
  }, []);

  const submitPrompt = useCallback(
    async (name: string) => {
      const p = prompt;
      setPrompt(null);
      if (!p) return;
      if (name.includes("/") || name.includes("\\")) {
        setNotice(t("files.opFailed", { message: name }));
        return;
      }
      try {
        if (p.kind === "rename") {
          const parent = parentPath(p.path);
          const to = joinPath(parent, name);
          if (to !== p.path) {
            await ipc.renameItem(p.path, to);
            useFilesStore.getState().remapTreePath(p.path, to);
            await invalidateDir(parent);
            selectPath(to, p.isDir);
          }
          return;
        }
        const target = joinPath(p.path, name);
        if (p.kind === "newFile") {
          await ipc.createFile(target);
          await revealInTree(p.path, target, false);
        } else {
          await ipc.createDir(target);
          await revealInTree(p.path, target, true);
        }
      } catch (e) {
        opFailed(e);
      }
    },
    [prompt, t, invalidateDir, selectPath, revealInTree, opFailed],
  );

  const confirmTrash = useCallback(async () => {
    const target = trashTarget;
    setTrashTarget(null);
    if (!target) return;
    try {
      await ipc.trashItem(target.path);
      useFilesStore.getState().removeTreePath(target.path);
      await invalidateDir(parentPath(target.path));
    } catch (e) {
      opFailed(e);
    }
  }, [trashTarget, invalidateDir, opFailed]);

  const handlePaste = useCallback(
    async (targetDir: string) => {
      try {
        // Copy ids are captured around both waits and reads. A Copy that
        // arrives while Paste is reading invalidates that source decision.
        let pending = pendingCopyRef.current;
        if (pending) await pending.write.catch(() => {});
        let snapshot: ClipboardFileSnapshot;
        for (;;) {
          const copyId = copyIdRef.current;
          pending = pendingCopyRef.current;
          // The host reads its own snapshot inside pasteClipboardItems;
          // renderer-supplied source paths never enter the paste command.
          snapshot = await ipc.clipboardFileSnapshot();
          if (copyIdRef.current === copyId) break;
        }
        if (!mountedRef.current) return;
        const usePendingCopy =
          pending &&
          (snapshot.changeCount === null ||
            (pending.beforeChangeCount !== undefined &&
              snapshot.changeCount === pending.beforeChangeCount));
        if (snapshot.paths.length > 0 && !usePendingCopy) {
          const { created, failed } = await ipc.pasteClipboardItems(targetDir);
          if (created.length > 0) {
            const last = created[created.length - 1];
            await revealInTree(targetDir, last.path, last.isDir);
          }
          if (!mountedRef.current) return;
          if (failed.length > 0) {
            setNotice(t("files.opFailed", { message: failed.join("; ") }));
          } else if (created.length === 0) {
            setNotice(t("files.pasteUnavailable"));
          }
          return;
        }
        if (pending && !usePendingCopy) {
          // A newer external clipboard containing only text must invalidate
          // the failed write's tree fallback too.
          setNotice(t("files.pasteUnavailable"));
          return;
        }
        const item = useFilesStore.getState().clipboard;
        if (!item) {
          setNotice(t("files.pasteUnavailable"));
          return;
        }
        const result = await ipc.pasteItem(item.path, targetDir);
        await revealInTree(targetDir, result.path, result.isDir);
      } catch (e) {
        opFailed(e);
      }
    },
    [t, revealInTree, opFailed],
  );

  const handleDuplicate = useCallback(async () => {
    if (!menu) return;
    try {
      const result = await ipc.duplicateItem(menu.path);
      await revealInTree(parentPath(menu.path), result.path, result.isDir);
    } catch (e) {
      opFailed(e);
    }
  }, [menu, revealInTree, opFailed]);

  const copyItem = useCallback(() => {
    if (!menu) return;
    const item = { path: menu.path, isDir: menu.isDir };
    const id = ++copyIdRef.current;
    useFilesStore.getState().setClipboard(item);
    const pending: PendingTreeCopy = { id, write: Promise.resolve() };
    pendingCopyRef.current = pending;
    // Serialize native writes: a late write for an older Copy must not
    // overwrite the newer item. Capture the generation immediately before
    // this copy's actual native write.
    const write = clipboardWriteRef.current.catch(() => {}).then(async () => {
      if (copyIdRef.current !== id) return;
      const before = await ipc.clipboardFileSnapshot();
      if (copyIdRef.current !== id) return;
      try {
        await ipc.setClipboardFilePaths([item.path]);
      } catch (error) {
        const after = await ipc.clipboardFileSnapshot().catch(() => null);
        pending.beforeChangeCount =
          after?.changeCount === before.changeCount ? before.changeCount : undefined;
        throw error;
      }
    });
    pending.write = write;
    clipboardWriteRef.current = write;
    void write.then(
      () => {
        if (copyIdRef.current === id) pendingCopyRef.current = null;
      },
      () => {
        // Keep the failed copy for the unchanged-generation fallback.
      },
    );
  }, [menu]);

  const copyPath = useCallback(() => {
    if (!menu) return;
    void copyText(menu.path).then((ok) => {
      if (!ok) opFailed(new Error("Failed to copy path"));
    }).catch(opFailed);
  }, [menu, opFailed]);

  const sendPath = useCallback(() => {
    if (!menu) return;
    useChatStore.getState().requestMention(menu.path);
  }, [menu]);

  const revealInFileManager = useCallback(() => {
    if (!menu) return;
    void ipc.revealInFileManager(menu.path).catch(opFailed);
  }, [menu, opFailed]);

  return {
    clipboard,
    canPaste: clipboard !== null || (systemClipboard?.length ?? 0) > 0,
    menu,
    prompt,
    trashTarget,
    notice,
    openContextMenu,
    closeMenu,
    startNewFile: useCallback(
      (dir: string) => setPrompt({ kind: "newFile", path: dir, isDir: true }),
      [],
    ),
    startNewFolder: useCallback(
      (dir: string) => setPrompt({ kind: "newFolder", path: dir, isDir: true }),
      [],
    ),
    copyItem,
    paste: useCallback((dir: string) => void handlePaste(dir), [handlePaste]),
    duplicate: useCallback(() => void handleDuplicate(), [handleDuplicate]),
    startRename: useCallback(() => {
      if (menu) setPrompt({ kind: "rename", path: menu.path, isDir: menu.isDir });
    }, [menu]),
    copyPath,
    sendPath,
    revealInFileManager,
    startTrash: useCallback(() => {
      if (menu) setTrashTarget({ path: menu.path, isDir: menu.isDir });
    }, [menu]),
    submitPrompt: useCallback((name: string) => void submitPrompt(name), [submitPrompt]),
    cancelPrompt: useCallback(() => setPrompt(null), []),
    confirmTrash: useCallback(() => void confirmTrash(), [confirmTrash]),
    cancelTrash: useCallback(() => setTrashTarget(null), []),
    dismissNotice: useCallback(() => setNotice(null), []),
  };
}
