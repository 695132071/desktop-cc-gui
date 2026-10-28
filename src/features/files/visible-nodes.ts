import type { DirEntry, FileTreeColor, RepositorySummary } from "@/lib/ipc";
import type { VisibleNode } from "./FileTreeRow";
import { fileName, joinPath } from "./store";

/** The store slices the visible row list is derived from. */
export interface TreeSnapshot {
  root: string;
  children: Record<string, DirEntry[]>;
  expanded: Record<string, true>;
  loadingDirs: Record<string, true>;
  dirErrors: Record<string, string>;
  repositories: Record<string, RepositorySummary>;
  fileColors: Record<string, Record<string, FileTreeColor>>;
  /** Drop entries Git ignores (and, with them, everything beneath). */
  hideIgnored: boolean;
}

/** Flatten the expanded tree into rows, depth-first in listing order. */
export function buildVisibleNodes({
  root,
  children,
  expanded,
  loadingDirs,
  dirErrors,
  repositories,
  fileColors,
  hideIgnored,
}: TreeSnapshot): VisibleNode[] {
  if (!root) return [];
  const out: VisibleNode[] = [];
  // Synthetic root row: the workspace root itself is the first tree row
  // with its repository badge (`open-reverselab main M1 ?12`); clicking
  // it expands the tree below it. Never hidden, whatever Git says.
  out.push({
    name: fileName(root),
    isDir: true,
    size: 0,
    mtimeMs: 0,
    path: root,
    depth: 0,
    expanded: !!expanded[root],
    loading: !!loadingDirs[root],
    repository: repositories[root],
    // Repo-root rows are blue (the workspace repo root row here; nested
    // repo dirs get theirs from the backend color pass).
    color: repositories[root] ? "repository" : undefined,
  });
  const walk = (dirPath: string, depth: number) => {
    const entries = children[dirPath];
    if (!entries) return;
    for (const e of entries) {
      if (hideIgnored && e.ignored) continue;
      let path = joinPath(dirPath, e.name);
      let name = e.name;
      const compactPaths = [path];
      if (e.isDir) {
        while (!repositories[path] && !loadingDirs[path] && !dirErrors[path]) {
          const visible = children[path]?.filter((entry) => !hideIgnored || !entry.ignored);
          if (visible?.length !== 1 || !visible[0].isDir) break;
          name += `/${visible[0].name}`;
          path = joinPath(path, visible[0].name);
          compactPaths.push(path);
        }
      }
      const isExpanded = compactPaths.every((part) => !!expanded[part]);
      out.push({
        ...e,
        name,
        path,
        compactPaths: compactPaths.length > 1 ? compactPaths : undefined,
        depth,
        expanded: e.isDir && isExpanded,
        loading: e.isDir && !!loadingDirs[path],
        repository: e.isDir ? repositories[path] : undefined,
        // Plain folders never carry color; files take their git state;
        // nested repo dirs take their own repo's status color from the
        // backend. Blue stays exclusive to the workspace root row.
        color: fileColors[dirPath]?.[e.name],
      });
      // Only already-expanded levels are walked. Listing requests belong to
      // the click handler, which follows a single chain when needed.
      if (e.isDir && isExpanded) walk(path, depth + 1);
    }
  };
  if (expanded[root]) walk(root, 1);
  return out;
}
