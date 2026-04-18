import { HEX } from './colors';

/**
 * Single source of truth for Podium webview styling. Injected into every
 * panel's `<style>` block so palette, spacing, typography, and scrollbar
 * behaviour stay in lockstep.
 *
 * Panels still keep their own panel-specific rules, but they should reference
 * these CSS variables rather than hard-coding colors or sizes.
 */
export function buildSharedWebviewCss(): string {
  return `
  :root {
    /* palette */
    --podium-bg-editor: #0c0c0c;
    --podium-bg-titlebar: #141414;
    --podium-bg-card: #1a1a1a;
    --podium-bg-panel: #101010;
    --podium-bg-input: #1e1e1e;
    --podium-border: #2a2a2a;
    --podium-border-focus: #3a3a3a;
    --podium-border-strong: #3f3f3f;
    --podium-text-primary: #e5e5e5;
    --podium-text-secondary: #9ca3af;
    --podium-text-disabled: #6b7280;
    --podium-text-inverse: #0c0c0c;
    --podium-text-link: #60a5fa;

    /* brand + agent accents (align with HEX in colors.ts) */
    --podium-claude: ${HEX.claude};
    --podium-codex: ${HEX.codex};
    --podium-gemini: ${HEX.gemini};
    --podium-omc: ${HEX.omc};
    --podium-leader: ${HEX.omc};

    /* status */
    --podium-running: ${HEX.statusRunning};
    --podium-success: ${HEX.statusDone};
    --podium-error: ${HEX.statusFailed};
    --podium-cancelled: ${HEX.statusCancelled};
    --podium-idle: ${HEX.statusIdle};

    /* radii */
    --podium-radius-sm: 3px;
    --podium-radius-md: 4px;
    --podium-radius-lg: 8px;
    --podium-radius-full: 999px;

    /* sizing */
    --podium-header-h: 56px;
    --podium-btn-h: 32px;
    --podium-btn-sm-h: 28px;
    --podium-input-h: 36px;
    --podium-chip-h: 22px;

    /* typography */
    --podium-font-sans: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --podium-font-mono: "Cascadia Code", Consolas, "Courier New", ui-monospace, monospace;
    --podium-fs-xs: 10px;
    --podium-fs-sm: 11px;
    --podium-fs-md: 12px;
    --podium-fs-lg: 13px;
    --podium-fs-xl: 14px;
    --podium-fs-2xl: 16px;

    /* legacy aliases — keep existing panel rules working without edits */
    --bg-editor: var(--podium-bg-editor);
    --bg-titlebar: var(--podium-bg-titlebar);
    --bg-card: var(--podium-bg-card);
    --bg-panel: var(--podium-bg-panel);
    --bg-input: var(--podium-bg-input);
    --bg-backdrop: rgba(0, 0, 0, 0.55);
    --bg-button: var(--podium-omc);
    --bg-button-hover: #F97316;
    --border: var(--podium-border);
    --border-focus: var(--podium-border-focus);
    --text-primary: var(--podium-text-primary);
    --text-secondary: var(--podium-text-secondary);
    --text-disabled: var(--podium-text-disabled);
    --text-inverse: var(--podium-text-inverse);
    --text-link: var(--podium-text-link);
    --accent-claude: var(--podium-claude);
    --accent-codex: var(--podium-codex);
    --accent-gemini: var(--podium-gemini);
    --accent-omc: var(--podium-omc);
    --accent-leader: var(--podium-leader);
    --status-running: var(--podium-running);
    --status-success: var(--podium-success);
    --status-error: var(--podium-error);
    --status-cancelled: var(--podium-cancelled);
    --status-idle: var(--podium-idle);
  }

  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    width: 100%;
    background: var(--podium-bg-editor);
    color: var(--podium-text-primary);
    font-family: var(--podium-font-sans);
    font-size: var(--podium-fs-lg);
    line-height: 1.4;
  }

  /* Consistent scrollbar across all Podium webviews (Chromium only,
     which is all we target — Antigravity + VSCode). */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: var(--podium-bg-card);
    border-radius: 5px;
    border: 2px solid transparent;
    background-clip: content-box;
  }
  ::-webkit-scrollbar-thumb:hover {
    background: var(--podium-border-strong);
    background-clip: content-box;
  }
  ::-webkit-scrollbar-corner { background: transparent; }

  ::selection { background: rgba(251, 146, 60, 0.35); color: var(--podium-text-primary); }

  /* Focus ring baseline */
  :focus-visible { outline: 2px solid var(--podium-omc); outline-offset: 2px; }

  /* Keyboard-style shortcut hints — used in modal footers */
  .podium-kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    padding: 0 6px;
    height: 20px;
    line-height: 20px;
    background: var(--podium-bg-input);
    border: 1px solid var(--podium-border);
    border-radius: var(--podium-radius-sm);
    font-family: var(--podium-font-mono);
    font-size: var(--podium-fs-xs);
    color: var(--podium-text-secondary);
  }

  /* Small "pill" labels — used in headers and chips */
  .podium-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--podium-chip-h);
    padding: 0 8px;
    border-radius: var(--podium-radius-full);
    background: var(--podium-bg-card);
    border: 1px solid var(--podium-border);
    font-size: var(--podium-fs-sm);
    font-weight: 600;
    color: var(--podium-text-secondary);
  }
  .podium-pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  `;
}
