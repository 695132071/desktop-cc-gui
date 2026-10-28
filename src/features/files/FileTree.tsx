import { useTranslation } from "react-i18next";
import ChevronsDown from "lucide-react/dist/esm/icons/chevrons-down";
import ChevronsUp from "lucide-react/dist/esm/icons/chevrons-up";
import {
  formatShortcutForPlatform,
  isEditableShortcutTarget,
  matchesShortcutForPlatform,
} from "@/features/shortcuts/shortcuts";
import { useFilesStore } from "./store";
import { useFileTreeVirtualList } from "./useFileTreeVirtualList";
import { useFileTreeOperations } from "./useFileTreeOperations";
import { FileTreeBody } from "./FileTreeBody";
import { FileTreeOverlays } from "./FileTreeOverlays";

/** Tree-local keys: they act only while focus is inside the tree. */
const EXPAND_LOADED_SHORTCUT = "alt+shift+arrowright";
const COLLAPSE_ALL_SHORTCUT = "alt+shift+arrowleft";
const TOOLBAR_BUTTON =
  "flex size-6 items-center justify-center rounded text-foreground-icon-tertiary hover:bg-background-primary-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-border-focus-ring";

export function FileTree() {
  const { t } = useTranslation();
  const { parentRef, virtualizer, visible } = useFileTreeVirtualList();
  const ops = useFileTreeOperations();
  const expandLoadedDirs = useFilesStore((s) => s.expandLoadedDirs);
  const collapseAllDirs = useFilesStore((s) => s.collapseAllDirs);
  const expandLabel = t("files.expandLoadedFolders");
  const collapseLabel = t("files.collapseAllFolders");

  return (
    // tabIndex -1: WebKit (the macOS app) does not focus a clicked <button>
    // but the nearest focusable ancestor, so without it a mouse click on a
    // row leaves focus outside the tree and the keys never arrive here.
    <div
      tabIndex={-1}
      className="relative flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={(event) => {
        if (isEditableShortcutTarget(event.target)) return;
        if (matchesShortcutForPlatform(event.nativeEvent, EXPAND_LOADED_SHORTCUT)) expandLoadedDirs();
        else if (matchesShortcutForPlatform(event.nativeEvent, COLLAPSE_ALL_SHORTCUT)) collapseAllDirs();
        else return;
        event.preventDefault();
      }}
    >
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 px-2">
        <button
          type="button"
          aria-label={expandLabel}
          title={`${expandLabel} (${formatShortcutForPlatform(EXPAND_LOADED_SHORTCUT)})`}
          aria-keyshortcuts="Alt+Shift+ArrowRight"
          onClick={expandLoadedDirs}
          className={TOOLBAR_BUTTON}
        >
          <ChevronsDown className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={collapseLabel}
          title={`${collapseLabel} (${formatShortcutForPlatform(COLLAPSE_ALL_SHORTCUT)})`}
          aria-keyshortcuts="Alt+Shift+ArrowLeft"
          onClick={collapseAllDirs}
          className={TOOLBAR_BUTTON}
        >
          <ChevronsUp className="size-4" aria-hidden />
        </button>
      </div>
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto py-1">
        <FileTreeBody
          virtualizer={virtualizer}
          visible={visible}
          onContextMenu={ops.openContextMenu}
        />
        <FileTreeOverlays ops={ops} />
      </div>
    </div>
  );
}
