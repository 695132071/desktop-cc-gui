"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import GitMerge from "lucide-react/dist/esm/icons/git-merge";
import Search from "lucide-react/dist/esm/icons/search";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { menuPopoverSurface } from "@/components/base/dropdown/menu-styles";
import { cx } from "@/utils/cx";
import { usePopoverState } from "@/utils/use-dismiss-on-outside-press";

/**
 * Status-bar branch switcher — sibling of ProjectFolderMenu, same react-aria
 * non-modal popover recipe; contents are props-driven.
 */

const POPOVER_CLASSES = menuPopoverSurface({ width: "w-[266px]", origin: "origin-bottom-left" });

export interface BranchMenuItem {
  name: string;
  /** Remote-tracking branch (`origin/x`); rendered with the remote badge. */
  isRemote?: boolean;
}

/** Status-bar trigger + branch popover. `repoName` labels the repository the
 * branch belongs to when the followed repo is a nested one (file-tree
 * selection inside a subfolder repository), never the workspace default. */
export function BranchMenu({
  branches,
  currentName,
  repoName,
  onSelect,
}: {
  /** Local and remote-tracking branches; empty until the first load. */
  branches: BranchMenuItem[];
  currentName?: string;
  /** Repository display name; renders as a prefix when set. */
  repoName?: string;
  onSelect?: (name: string) => void;
}) {
  const { t } = useTranslation();
  // `isNonModal` popovers don't dismiss on outside press and don't toggle
  // closed on a trigger press — usePopoverState restores both (hook doc).
  const { isOpen, triggerRef, popoverRef, close, setOpen } = usePopoverState();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Stale filter text must not survive into the next open: a branch list that
  // silently lost rows on reopen reads as data loss.
  useEffect(() => {
    if (!isOpen) setQuery("");
  }, [isOpen]);

  // Focus the filter as the popover opens (autoFocus would move focus on load,
  // which the a11y rules reject). Focus landing inside the popover also makes
  // Esc reach react-aria's dismiss handler — before this, focus stayed on the
  // trigger and Esc did nothing.
  useEffect(() => {
    if (isOpen) searchRef.current?.focus();
  }, [isOpen]);

  // An empty query returns the original array, so the unfiltered render path is
  // what it was before the filter existed.
  const filteredBranches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return branches;
    return branches.filter((branch) => branch.name.toLowerCase().includes(needle));
  }, [branches, query]);

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={setOpen}>
      <AriaButton
        ref={triggerRef}
        className="flex max-w-full min-w-0 cursor-pointer items-center gap-1 overflow-hidden rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <GitMerge
          className="size-3.5 shrink-0 -scale-y-100 text-foreground-icon-tertiary"
          aria-hidden
        />
        <span className="flex min-w-0 items-center overflow-hidden">
          {repoName && (
            <>
              <span className="min-w-0 truncate text-caption-1-medium text-text-secondary">
                {repoName}
              </span>
              <span
                className="shrink-0 px-1 text-caption-1-regular text-text-tertiary"
                aria-hidden
              >
                ·
              </span>
            </>
          )}
          <span
            title={repoName ? `${repoName} · ${currentName ?? "…"}` : currentName}
            className="min-w-0 truncate text-caption-1-regular text-text-tertiary"
          >
            {currentName ?? "…"}
          </span>
          <ChevronDown
            className={cx(
              "size-3.5 shrink-0 text-foreground-icon-tertiary transition-transform duration-200 ease",
              isOpen && "rotate-180",
            )}
            aria-hidden
          />
        </span>
      </AriaButton>

      <AriaPopover
        ref={popoverRef}
        isNonModal
        placement="top start"
        offset={8}
        className={POPOVER_CLASSES}
      >
        <AriaDialog aria-label={t("git.branch")} className="outline-none">
          <div className="flex w-full flex-col gap-1.5 pt-1">
            {/* The filter is the popover's first element and a sibling of the
                scroller, not a child: the list below is the max-h-64 scroll
                body and would carry the field away with it. No "分支" heading —
                the trigger already shows the current branch, the placeholder
                carries the label, and the dialog keeps `aria-label`. */}
            <div className="flex h-8 w-full items-center gap-1.5 rounded-lg border border-border-button-default px-2 focus-within:ring-2 focus-within:ring-border-focus-ring">
              <Search
                className="size-4 shrink-0 text-foreground-icon-secondary"
                aria-hidden
              />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("git.searchBranches")}
                aria-label={t("git.searchBranches")}
                className="min-w-0 flex-1 bg-transparent text-body-medium text-text-primary outline-none placeholder:text-text-placeholder"
              />
            </div>
            <div className="flex max-h-64 w-full flex-col gap-1 overflow-y-auto">
              {filteredBranches.map((branch) => (
                <button
                  key={branch.name}
                  type="button"
                  // Whole-row title, not just the truncated name span: hovering
                  // any part of the row (icon, clipped text, empty tail) must
                  // reveal the full branch name. Intercepted by
                  // NativeTitleTooltip, so write the plain attribute.
                  title={branch.name}
                  aria-pressed={branch.name === currentName}
                  onClick={() => {
                    // Compare against the displayed current name, not a cached
                    // isCurrent: the list snapshot lags behind external
                    // checkouts and would no-op the click.
                    if (branch.name !== currentName) onSelect?.(branch.name);
                    close();
                  }}
                  className={cx(
                    "flex w-full cursor-pointer items-center gap-2 rounded-2lg p-2 outline-none transition-colors",
                    branch.name === currentName
                      ? "bg-background-primary-hover"
                      : "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
                  )}
                >
                  <GitMerge
                    className="size-5 shrink-0 -scale-y-100 text-foreground-icon-secondary"
                    aria-hidden
                  />
                  <span className="truncate text-body-medium whitespace-nowrap text-text-primary">
                    {branch.name}
                  </span>
                  {branch.isRemote && (
                    <span className="ml-auto shrink-0 rounded-md bg-background-secondary-default px-1.5 py-0.5 text-caption-1-regular text-text-tertiary">
                      {t("git.remoteBranch")}
                    </span>
                  )}
                  {branch.name === currentName && (
                    <Check
                      className="ml-auto size-4 shrink-0 text-foreground-icon-secondary"
                      aria-hidden
                    />
                  )}
                </button>
              ))}
              {/* Only the filter can empty a populated list: a branch list that
                  has not loaded yet renders exactly as it did before. */}
              {query.trim().length > 0 && filteredBranches.length === 0 && (
                <span className="px-2 py-1.5 text-body-medium text-text-tertiary">
                  {t("git.noMatchingBranches")}
                </span>
              )}
            </div>
          </div>
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
