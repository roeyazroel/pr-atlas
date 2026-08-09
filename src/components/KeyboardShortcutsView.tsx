import { ArrowLeft, CircleHelp } from "lucide-react";
import {
  detectModLabel,
  formatShortcutKeys,
  shortcutsByScope,
  type ShortcutDefinition,
} from "../keyboard-shortcuts";

export interface KeyboardShortcutsViewProps {
  onClose?: () => void;
}

/** Renders a single shortcut row with platform-aware key caps. */
function ShortcutRow({
  shortcut,
  modLabel,
}: {
  shortcut: ShortcutDefinition;
  modLabel: string;
}) {
  const keys = formatShortcutKeys(shortcut.keys, modLabel);
  return (
    <li className="shortcut-row">
      <span className="shortcut-description">{shortcut.description}</span>
      <span
        className="shortcut-keys"
        aria-label={keys.filter((key) => key !== "or").join(" or ")}
      >
        {keys.map((key, index) =>
          key === "or" ? (
            <span className="shortcut-key-or" key={`${shortcut.id}-or-${index}`}>
              or
            </span>
          ) : (
            <kbd key={`${shortcut.id}-${key}`}>{key}</kbd>
          ),
        )}
      </span>
    </li>
  );
}

/** Full-page reference of every keyboard shortcut in the workspace. */
export default function KeyboardShortcutsView({
  onClose,
}: KeyboardShortcutsViewProps) {
  const modLabel = detectModLabel();
  const groups = shortcutsByScope();

  return (
    <main className="shortcuts-page" aria-labelledby="shortcuts-title">
      <header className="settings-page-header">
        <div className="settings-page-intro">
          <div className="eyebrow">Workspace</div>
          <h1 id="shortcuts-title">Keyboard shortcuts</h1>
          <p>
            Move through pull requests, jump between sections, and control the
            flow canvas without leaving the keyboard.
          </p>
        </div>
        {onClose && (
          <button
            className="secondary-button"
            type="button"
            aria-label="Return to pull requests"
            onClick={onClose}
          >
            <ArrowLeft size={13} aria-hidden="true" /> Pull requests
          </button>
        )}
      </header>

      <div className="shortcuts-workbench">
        <nav className="settings-rail" aria-label="Shortcut sections">
          <div className="eyebrow">Reference</div>
          {groups.map((group) => (
            <a key={group.id} href={`#shortcuts-${group.id}`}>
              {group.title}
            </a>
          ))}
        </nav>

        <div className="settings-content shortcuts-content">
          <div className="shortcuts-legend" role="note">
            <CircleHelp size={16} aria-hidden="true" />
            <p>
              Modifier shortcuts use <kbd>Ctrl</kbd> on Windows and Linux, and{" "}
              <kbd>⌘</kbd> on macOS. This computer shows <kbd>{modLabel}</kbd>.
              Shortcuts are ignored while typing in search fields, comments, and
              other inputs (except <kbd>Esc</kbd>).
            </p>
          </div>

          {groups.map((group) => (
            <section
              key={group.id}
              id={`shortcuts-${group.id}`}
              className="settings-panel shortcuts-panel"
              aria-labelledby={`shortcuts-${group.id}-heading`}
            >
              <div className="settings-panel-heading">
                <div>
                  <div className="eyebrow">Shortcuts</div>
                  <h2 id={`shortcuts-${group.id}-heading`}>{group.title}</h2>
                </div>
              </div>
              <p className="shortcuts-panel-summary">{group.summary}</p>
              <ul className="shortcut-list" aria-label={`${group.title} shortcuts`}>
                {group.shortcuts.map((shortcut) => (
                  <ShortcutRow
                    key={shortcut.id}
                    shortcut={shortcut}
                    modLabel={modLabel}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}
