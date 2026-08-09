/** Workspace keyboard shortcut definitions shown in the help page and wired in App. */

export type ShortcutScope =
  | "global"
  | "pull-requests"
  | "views"
  | "flows"
  | "comments";

export type ShortcutDefinition = {
  id: string;
  scope: ShortcutScope;
  /** Display tokens; use "Mod" for ⌘ on Apple platforms and Ctrl on Windows/Linux. */
  keys: string[];
  description: string;
};

export type ShortcutScopeMeta = {
  id: ShortcutScope;
  title: string;
  summary: string;
};

export type PlatformHints = {
  userAgent?: string;
  platform?: string;
};

export const SHORTCUT_SCOPES: ShortcutScopeMeta[] = [
  {
    id: "global",
    title: "Workspace",
    summary: "Open help, settings, and the activity log from anywhere.",
  },
  {
    id: "pull-requests",
    title: "Pull requests",
    summary: "Search and move through the visible pull-request list.",
  },
  {
    id: "views",
    title: "Pull request sections",
    summary: "Jump between sections for the selected pull request.",
  },
  {
    id: "flows",
    title: "Flows",
    summary: "Navigate the flow graph, tour, and canvas zoom.",
  },
  {
    id: "comments",
    title: "Comments",
    summary: "Composer actions while writing a pull-request comment.",
  },
];

export const KEYBOARD_SHORTCUTS: ShortcutDefinition[] = [
  {
    id: "open-shortcuts",
    scope: "global",
    keys: ["?"],
    description: "Open or close keyboard shortcuts",
  },
  {
    id: "open-settings",
    scope: "global",
    keys: [","],
    description: "Open settings",
  },
  {
    id: "open-activity-log",
    scope: "global",
    keys: ["l"],
    description: "Open activity log",
  },
  {
    id: "escape",
    scope: "global",
    keys: ["Esc"],
    description: "Close dialogs, drawers, and utility pages",
  },
  {
    id: "search-prs",
    scope: "pull-requests",
    keys: ["/"],
    description: "Focus pull request search",
  },
  {
    id: "next-pr",
    scope: "pull-requests",
    keys: ["j", "or", "↓"],
    description: "Select next pull request",
  },
  {
    id: "previous-pr",
    scope: "pull-requests",
    keys: ["k", "or", "↑"],
    description: "Select previous pull request",
  },
  {
    id: "start-analysis",
    scope: "pull-requests",
    keys: ["a"],
    description: "Start or retry analysis for the selected pull request",
  },
  {
    id: "view-overview",
    scope: "views",
    keys: ["Mod", "1"],
    description: "Open Overview",
  },
  {
    id: "view-review",
    scope: "views",
    keys: ["Mod", "2"],
    description: "Open Review",
  },
  {
    id: "view-insights",
    scope: "views",
    keys: ["Mod", "3"],
    description: "Open Insights",
  },
  {
    id: "view-flows",
    scope: "views",
    keys: ["Mod", "4"],
    description: "Open Flows",
  },
  {
    id: "view-files",
    scope: "views",
    keys: ["Mod", "5"],
    description: "Open Files",
  },
  {
    id: "view-tests",
    scope: "views",
    keys: ["Mod", "6"],
    description: "Open Tests",
  },
  {
    id: "view-threads",
    scope: "views",
    keys: ["Mod", "7"],
    description: "Open Comments",
  },
  {
    id: "view-details",
    scope: "views",
    keys: ["Mod", "8"],
    description: "Open Analysis details",
  },
  {
    id: "flow-type-1",
    scope: "flows",
    keys: ["1"],
    description: "Show system overview flow",
  },
  {
    id: "flow-type-2",
    scope: "flows",
    keys: ["2"],
    description: "Show data flow",
  },
  {
    id: "flow-type-3",
    scope: "flows",
    keys: ["3"],
    description: "Show code dependency flow",
  },
  {
    id: "flow-type-4",
    scope: "flows",
    keys: ["4"],
    description: "Show user-action flow",
  },
  {
    id: "flow-next",
    scope: "flows",
    keys: ["n", "or", "→"],
    description: "Next guided tour step",
  },
  {
    id: "flow-prev",
    scope: "flows",
    keys: ["p", "or", "←"],
    description: "Previous guided tour step",
  },
  {
    id: "flow-zoom-in",
    scope: "flows",
    keys: ["+", "or", "="],
    description: "Zoom in",
  },
  {
    id: "flow-zoom-out",
    scope: "flows",
    keys: ["-"],
    description: "Zoom out",
  },
  {
    id: "flow-zoom-reset",
    scope: "flows",
    keys: ["0"],
    description: "Reset zoom and pan",
  },
  {
    id: "flow-search",
    scope: "flows",
    keys: ["/"],
    description: "Focus flow node search",
  },
  {
    id: "flow-clear-selection",
    scope: "flows",
    keys: ["Esc"],
    description: "Clear selected flow node",
  },
  {
    id: "comment-submit",
    scope: "comments",
    keys: ["Mod", "Enter"],
    description: "Submit the comment composer",
  },
];

/** Reads platform hints from the current browser/Electron renderer when available. */
export function readPlatformHints(): PlatformHints {
  if (typeof navigator === "undefined") return {};
  const userAgentData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData;
  return {
    userAgent: navigator.userAgent,
    platform: userAgentData?.platform || navigator.platform || undefined,
  };
}

/** True for macOS and other Apple devices where ⌘ is the primary shortcut modifier. */
export function isApplePlatform(hints: PlatformHints = readPlatformHints()): boolean {
  const haystack = `${hints.platform ?? ""} ${hints.userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod|ios/i.test(haystack);
}

/** Returns whether the event target is an editable field that should keep keystrokes. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Detects the platform modifier label for shortcut display. */
export function detectModLabel(hints: PlatformHints | string = readPlatformHints()): string {
  const normalized =
    typeof hints === "string" ? { userAgent: hints } : hints;
  return isApplePlatform(normalized) ? "⌘" : "Ctrl";
}

/**
 * True when the platform primary shortcut modifier is held.
 * Apple accepts ⌘ or Ctrl. Windows/Linux accept Ctrl only (never Win/Super).
 */
export function hasPrimaryModifier(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">,
  apple = isApplePlatform(),
): boolean {
  if (apple) return event.metaKey || event.ctrlKey;
  return event.ctrlKey;
}

/** Formats shortcut key tokens for the current platform. */
export function formatShortcutKeys(
  keys: string[],
  modLabel = detectModLabel(),
): string[] {
  return keys.map((key) => (key === "Mod" ? modLabel : key));
}

/** Groups shortcut definitions by scope for help-page rendering. */
export function shortcutsByScope(
  shortcuts: ShortcutDefinition[] = KEYBOARD_SHORTCUTS,
): Array<ShortcutScopeMeta & { shortcuts: ShortcutDefinition[] }> {
  return SHORTCUT_SCOPES.map((scope) => ({
    ...scope,
    shortcuts: shortcuts.filter((item) => item.scope === scope.id),
  })).filter((group) => group.shortcuts.length > 0);
}
