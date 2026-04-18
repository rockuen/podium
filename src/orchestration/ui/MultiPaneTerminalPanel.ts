import * as vscode from 'vscode';
import type { IMultiplexerBackend, TmuxPane } from '../backends/IMultiplexerBackend';
import { HEX, detectAgent, agentDisplayName, type AgentKind } from './colors';
import { buildSharedWebviewCss } from './webviewTheme';

const XTERM_CSS = `
.xterm { cursor: text; position: relative; user-select: none; -ms-user-select: none; -webkit-user-select: none; font-feature-settings: "liga" 0; }
.xterm.focus, .xterm:focus { outline: none; }
.xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
.xterm .xterm-helper-textarea { position: absolute; opacity: 0; left: -9999em; top: 0; width: 0; height: 0; z-index: -5; }
.xterm .xterm-viewport { background-color: transparent; overflow-y: scroll; cursor: default; position: absolute; right: 0; left: 0; top: 0; bottom: 0; }
.xterm .xterm-screen { position: relative; }
.xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.xterm .xterm-scroll-area { visibility: hidden; }
.xterm-char-measure-element { display: inline-block; visibility: hidden; position: absolute; top: 0; left: -9999em; line-height: normal; }
.xterm .xterm-accessibility, .xterm .xterm-message { position: absolute; left: 0; top: 0; bottom: 0; right: 0; z-index: 10; color: transparent; pointer-events: none; }
.xterm-dim { opacity: 0.5; }
.xterm-underline-1 { text-decoration: underline; }
.xterm-strikethrough { text-decoration: line-through; }
`;

interface PaneWirePayload {
  paneId: string;
  title: string;
  command: string;
  windowIndex: number;
  pid: number | null;
  agent: AgentKind;
  agentColor: string;
  agentLabel: string;
}

export class MultiPaneTerminalPanel {
  static readonly viewType = 'podium.multiPaneTerminal';

  private pollTimer: NodeJS.Timeout | null = null;
  private panes: TmuxPane[] = [];
  private disposed = false;
  private tickInFlight = false;
  private captureInFlight = false;
  /** Last content successfully posted per pane — used to dedupe and stop
   * stomping xterm scrollback/selection with identical writes. */
  private lastSent = new Map<string, string>();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly backend: IMultiplexerBackend,
    private readonly sessionName: string,
    private readonly output: vscode.OutputChannel,
    private readonly pollIntervalMs: number,
  ) {
    panel.onDidDispose(() => {
      this.disposed = true;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      this.output.appendLine(`[podium.multipane] panel disposed for "${this.sessionName}"`);
    });
  }

  static async open(
    context: vscode.ExtensionContext,
    backend: IMultiplexerBackend,
    output: vscode.OutputChannel,
    sessionName: string,
    pollIntervalMs: number = 1000,
  ): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      MultiPaneTerminalPanel.viewType,
      `Podium · ${sessionName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'orchestration', 'webview')],
      },
    );
    const instance = new MultiPaneTerminalPanel(
      panel,
      context,
      backend,
      sessionName,
      output,
      pollIntervalMs,
    );
    await instance.start();
  }

  private async start(): Promise<void> {
    this.panel.webview.html = this.buildHtml();
    this.panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as {
        type?: string;
        paneId?: string;
        keys?: unknown;
        literal?: unknown;
      };
      if (m.type === 'ready') {
        this.output.appendLine(
          `[podium.multipane] webview ready for "${this.sessionName}"`,
        );
        await this.pushInit();
        return;
      }
      if (m.type === 'kill' && typeof m.paneId === 'string') {
        const target = m.paneId;
        try {
          await this.backend.killPane(target);
          this.output.appendLine(`[podium.multipane] killed pane ${target}`);
        } catch (err) {
          this.output.appendLine(`[podium.multipane] killPane failed: ${err}`);
          vscode.window.showWarningMessage(
            `Podium: could not kill pane ${target} — ${err instanceof Error ? err.message : err}`,
          );
        }
        await this.tick();
        return;
      }
      if (m.type === 'send-key' && typeof m.paneId === 'string' && Array.isArray(m.keys)) {
        const keys = m.keys.filter((k): k is string => typeof k === 'string' && k.length > 0);
        if (keys.length === 0) return;
        const literal = m.literal === true;
        try {
          await this.backend.sendKeys(m.paneId, keys, literal);
          this.output.appendLine(
            `[podium.multipane] sendKeys ${m.paneId} literal=${literal} keys=${JSON.stringify(keys)}`,
          );
        } catch (err) {
          this.output.appendLine(`[podium.multipane] sendKeys failed: ${err}`);
        }
        // Trigger fast capture so user sees the result immediately.
        await this.captureAll(this.panes);
        return;
      }
      if (
        m.type === 'resize' &&
        typeof m.paneId === 'string' &&
        typeof (m as { cols?: unknown }).cols === 'number' &&
        typeof (m as { rows?: unknown }).rows === 'number'
      ) {
        const cols = (m as { cols: number }).cols;
        const rows = (m as { rows: number }).rows;
        try {
          await this.backend.resizePane(m.paneId, cols, rows);
        } catch (err) {
          this.output.appendLine(`[podium.multipane] resizePane failed: ${err}`);
        }
      }
    });

    this.output.appendLine(
      `[podium.multipane] opening for session "${this.sessionName}" (poll ${this.pollIntervalMs}ms)`,
    );

    await this.pushInit();
    this.pollTimer = setInterval(() => void this.tick(), this.pollIntervalMs);
  }

  private async pushInit(): Promise<void> {
    let panes: TmuxPane[];
    try {
      panes = await this.backend.listPanes(this.sessionName);
    } catch (err) {
      this.output.appendLine(`[podium.multipane] listPanes failed: ${err}`);
      return;
    }
    this.panes = panes;
    this.panel.webview.postMessage({
      type: 'init',
      session: this.sessionName,
      panes: panes.map(toWire),
    });
    await this.captureAll(panes);
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      let current: TmuxPane[];
      try {
        current = await this.backend.listPanes(this.sessionName);
      } catch {
        return;
      }

      const currentSig = current.map((p) => p.paneId + ':' + p.currentCommand).join('|');
      const knownSig = this.panes.map((p) => p.paneId + ':' + p.currentCommand).join('|');
      if (currentSig !== knownSig) {
        // Drop cached content for panes that have disappeared so a re-spawn
        // with the same id (unlikely but possible) starts fresh.
        const newIds = new Set(current.map((p) => p.paneId));
        for (const id of Array.from(this.lastSent.keys())) {
          if (!newIds.has(id)) this.lastSent.delete(id);
        }
        this.panes = current;
        this.panel.webview.postMessage({
          type: 'panes-changed',
          panes: current.map(toWire),
        });
      }

      await this.captureAll(current);
    } finally {
      this.tickInFlight = false;
    }
  }

  private async captureAll(panes: TmuxPane[]): Promise<void> {
    // Serialize captureAll runs. Overlapping runs could emit pane-updates out
    // of order — a slow earlier capture arriving after a fresh one would
    // overwrite the newer snapshot with stale content. The in-flight guard
    // also keeps CPU cost bounded when send-key / kill paths trigger a fast
    // capture while the regular poll is still working.
    if (this.captureInFlight) return;
    this.captureInFlight = true;
    try {
      for (const pane of panes) {
        if (this.disposed) return;
        try {
          // Capture with 2000 lines of scrollback so users can review prior
          // output after the pane scrolls. xterm's own scrollback (5000) holds
          // the result and its mouse-wheel scrolling surfaces it.
          const content = await this.backend.capturePane(pane.paneId, 2000);
          const prev = this.lastSent.get(pane.paneId);
          if (prev === content) continue; // unchanged — skip webview write
          this.lastSent.set(pane.paneId, content);
          this.panel.webview.postMessage({
            type: 'pane-update',
            paneId: pane.paneId,
            content,
          });
        } catch {
          // swallow per-pane errors; other panes continue
        }
      }
    } finally {
      this.captureInFlight = false;
    }
  }

  private buildHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'orchestration', 'webview', 'multipane.js'),
    );
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${this.panel.webview.cspSource} data:`,
      `img-src ${this.panel.webview.cspSource} data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Podium Multi-Pane</title>
<style>
${buildSharedWebviewCss()}
  /* Multi-pane specific legacy aliases */
  :root {
    --podium-bg: var(--podium-bg-editor);
    --podium-pane-bg: var(--podium-bg-input);
    --podium-pane-border: #2d2d2d;
    --podium-header-bg: var(--podium-bg-card);
    --podium-text: #d4d4d4;
    --podium-dim: #858585;
    --podium-brand: var(--podium-omc);
  }
  html, body { overflow: hidden; }
  #header { height: 32px; display: flex; align-items: center; padding: 0 12px; background: var(--podium-header-bg); border-bottom: 1px solid var(--podium-pane-border); font-size: 12px; gap: 10px; }
  #header .brand-icon { width: 6px; height: 6px; border-radius: 50%; background: var(--podium-brand); }
  #header .title { font-weight: 600; letter-spacing: 0.2px; color: var(--podium-text); }
  #header .session { color: var(--podium-brand); font-family: Consolas, monospace; font-size: 11px; }
  #header .count { color: var(--podium-dim); margin-left: auto; font-size: 11px; }
  #header .status { font-size: 10px; color: var(--podium-running); font-family: monospace; transition: color 0.2s; }

  #grid { position: absolute; top: 32px; left: 0; right: 0; bottom: 0; display: grid; gap: 6px; padding: 6px; box-sizing: border-box; background: var(--podium-bg); }

  .pane {
    position: relative;
    background: var(--podium-pane-bg);
    border: 1px solid var(--podium-pane-border);
    border-left-width: 3px;
    border-left-color: var(--pane-accent, var(--podium-idle));
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-radius: 4px;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  /* Active pane (clicked) takes full-border accent + soft glow to match the
     Pencil mockup's emphasis behaviour. Keeps the 3px left stripe so the
     agent colour stays readable when many panes are active-candidates. */
  .pane.active {
    border-color: var(--pane-accent, var(--podium-idle));
    border-width: 1.5px;
    border-left-width: 3px;
    box-shadow: 0 0 0 1px var(--pane-accent, transparent),
                0 0 18px -4px var(--pane-accent, transparent);
  }
  .pane-header {
    flex: 0 0 26px;
    padding: 0 10px 0 8px;
    background: linear-gradient(to right, rgba(255,255,255,0.02), transparent);
    color: var(--podium-dim);
    font-size: 11px;
    border-bottom: 1px solid var(--podium-pane-border);
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    white-space: nowrap;
  }
  .pane-header .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--pane-accent, var(--podium-idle));
    box-shadow: 0 0 6px var(--pane-accent, transparent);
    flex: 0 0 auto;
  }
  .pane-header .agent {
    color: var(--pane-accent, var(--podium-text));
    font-weight: 600;
    font-family: Consolas, monospace;
  }
  .pane-header .name { color: var(--podium-text); font-family: Consolas, monospace; font-size: 10.5px; }
  .pane-header .id { color: #5a5a5a; font-family: Consolas, monospace; font-size: 10px; }
  .pane-header .cmd { color: var(--podium-dim); font-family: Consolas, monospace; font-size: 10px; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; }
  .pane-header .close { cursor: pointer; color: #555; font-size: 14px; line-height: 1; padding: 0 4px; transition: color 0.15s; user-select: none; }
  .pane-header .close:hover { color: ${HEX.statusFailed}; }

  .pane-body { flex: 1 1 auto; min-height: 0; overflow: hidden; position: relative; }
  .pane-body > .xterm { position: absolute; inset: 4px; }

  .pane-footer {
    flex: 0 0 30px;
    border-top: 1px solid var(--podium-pane-border);
    padding: 0 6px;
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgba(0,0,0,0.22);
  }
  .pane-footer button {
    height: 22px;
    min-width: 24px;
    padding: 0 7px;
    border: 1px solid var(--podium-border);
    background: var(--podium-bg-card);
    color: var(--podium-text-secondary);
    font-family: var(--podium-font-mono);
    font-size: 10.5px;
    font-weight: 600;
    border-radius: var(--podium-radius-sm);
    cursor: pointer;
    line-height: 1;
    user-select: none;
    transition: all 0.12s;
  }
  .pane-footer button:hover { background: var(--podium-bg-input); color: var(--podium-text-primary); border-color: var(--pane-accent, var(--podium-border-focus)); }
  .pane-footer button.accent { color: var(--pane-accent, var(--podium-text-secondary)); }
  .pane-footer input {
    flex: 1 1 auto;
    min-width: 48px;
    height: 22px;
    background: var(--podium-bg-editor);
    color: var(--podium-text-primary);
    border: 1px solid var(--podium-border);
    border-radius: var(--podium-radius-sm);
    padding: 0 7px;
    font-family: var(--podium-font-mono);
    font-size: 11px;
    outline: none;
  }
  .pane-footer input:focus { border-color: var(--pane-accent, var(--podium-border-focus)); }
  .pane-footer .send {
    height: 22px;
    padding: 0 10px;
    border: 1px solid var(--pane-accent, var(--podium-border-focus));
    background: color-mix(in srgb, var(--pane-accent, var(--podium-border)) 12%, transparent);
    color: var(--pane-accent, var(--podium-text-primary));
    border-radius: var(--podium-radius-sm);
    font-family: var(--podium-font-mono);
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    user-select: none;
    transition: all 0.12s;
  }
  .pane-footer .send:hover { background: color-mix(in srgb, var(--pane-accent, var(--podium-border)) 22%, transparent); }

  .empty {
    color: var(--podium-dim);
    padding: 32px;
    text-align: center;
    font-size: 12px;
    line-height: 1.6;
  }
  .empty strong { color: var(--podium-text); display: block; margin-bottom: 4px; font-size: 13px; }

  ${XTERM_CSS}
</style>
</head>
<body>
<div id="header">
  <span class="brand-icon"></span>
  <span class="title">Podium</span>
  <span class="session" id="sess"></span>
  <span class="count" id="cnt"></span>
  <span class="status" id="status">●</span>
</div>
<div id="grid"><div class="empty" id="emptyMsg"><strong>Waiting for panes…</strong>Spawn an OMC team or manually create panes to see them stream here.</div></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function toWire(p: TmuxPane): PaneWirePayload {
  const agent = detectAgent(p.currentCommand, p.title);
  const colorByAgent: Record<AgentKind, string> = {
    claude: HEX.claude,
    codex: HEX.codex,
    gemini: HEX.gemini,
    shell: HEX.statusIdle,
    unknown: HEX.statusIdle,
  };
  return {
    paneId: p.paneId,
    title: p.title,
    command: p.currentCommand,
    windowIndex: p.windowIndex,
    pid: p.pid,
    agent,
    agentColor: colorByAgent[agent],
    agentLabel: agentDisplayName(agent),
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
