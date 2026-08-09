import { describe, expect, it } from "vitest";
import {
  KEYBOARD_SHORTCUTS,
  SHORTCUT_SCOPES,
  detectModLabel,
  formatShortcutKeys,
  hasPrimaryModifier,
  isApplePlatform,
  isTypingTarget,
  shortcutsByScope,
} from "../src/keyboard-shortcuts";

describe("keyboard shortcuts registry", () => {
  it("lists every shortcut under a known scope", () => {
    const scopeIds = new Set(SHORTCUT_SCOPES.map((scope) => scope.id));
    expect(KEYBOARD_SHORTCUTS.length).toBeGreaterThan(0);
    for (const shortcut of KEYBOARD_SHORTCUTS) {
      expect(scopeIds.has(shortcut.scope)).toBe(true);
      expect(shortcut.keys.length).toBeGreaterThan(0);
      expect(shortcut.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("groups shortcuts without dropping entries", () => {
    const groups = shortcutsByScope();
    const groupedCount = groups.reduce(
      (total, group) => total + group.shortcuts.length,
      0,
    );
    expect(groupedCount).toBe(KEYBOARD_SHORTCUTS.length);
  });

  it("detects Apple vs Windows/Linux modifier labels", () => {
    expect(
      isApplePlatform({
        platform: "macOS",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      }),
    ).toBe(true);
    expect(
      isApplePlatform({
        platform: "Windows",
        userAgent: "Mozilla/5.0 (Windows NT 10.0)",
      }),
    ).toBe(false);
    expect(
      isApplePlatform({
        platform: "Linux",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      }),
    ).toBe(false);
    expect(
      detectModLabel({
        platform: "macOS",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)",
      }),
    ).toBe("⌘");
    expect(
      detectModLabel({
        platform: "Windows",
        userAgent: "Mozilla/5.0 (Windows NT 10.0)",
      }),
    ).toBe("Ctrl");
    expect(
      detectModLabel({
        platform: "Linux",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      }),
    ).toBe("Ctrl");
    expect(formatShortcutKeys(["Mod", "Enter"], "Ctrl")).toEqual([
      "Ctrl",
      "Enter",
    ]);
    expect(formatShortcutKeys(["Mod", "1"], "⌘")).toEqual(["⌘", "1"]);
  });

  it("uses Ctrl on Windows/Linux and ignores the Win/Super meta key", () => {
    expect(
      hasPrimaryModifier({ metaKey: false, ctrlKey: true }, false),
    ).toBe(true);
    expect(
      hasPrimaryModifier({ metaKey: true, ctrlKey: false }, false),
    ).toBe(false);
    expect(
      hasPrimaryModifier({ metaKey: true, ctrlKey: false }, true),
    ).toBe(true);
    expect(
      hasPrimaryModifier({ metaKey: false, ctrlKey: true }, true),
    ).toBe(true);
  });

  it("treats form fields as typing targets", () => {
    const input = document.createElement("input");
    const button = document.createElement("button");
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(button)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
