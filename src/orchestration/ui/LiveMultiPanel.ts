import * as vscode from 'vscode';
import type { IPty } from 'node-pty';
import { spawnAgent, type AgentKind } from '../core/agentSpawn';
import { HEX } from './colors';

// Phase 1 · v2.7.0 — Live multi-pane panel. Each pane owns a node-pty on the
// extension side; xterm.js on the webview streams pty output and echoes
// input back via postMessage. No psmux, no polling.
//
// This is the prototype surface the v2.7 orchestrator will build on top of:
//   PodiumOrchestrator → creates LiveMultiPanel
//                     → addPane() per worker
//                     → subscribes to onData of each pane's pty
//                     → routes messages between panes via write()

const XTERM_CSS = `
.xterm { cursor: text; position: relative; user-select: none; -ms-user-select: none; -webkit-user-select: none; font-feature-settings: "liga" 0; }
.xterm.focus, .xterm:focus { outline: none; }
.xterm .xterm-helpers { position: absolute; top: 0; z-index: 5; }
.xterm .xterm-helper-textarea { position: absolute; opacity: 0; left: -9999em; top: 0; width: 0; height: 0; z-index: -5; white-space: nowrap; overflow: hidden; resize: none; }
.xterm .composition-view { background: #000; color: #FFF; display: none; position: absolute; white-space: nowrap; z-index: 1; }
.xterm .composition-view.active { display: block; }
.xterm .xterm-viewport { background-color: #000; overflow-y: scroll; cursor: default; position: absolute; right: 0; left: 0; top: 0; bottom: 0; }
.xterm .xterm-screen { position: relative; }
.xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.xterm .xterm-scroll-area { visibility: hidden; }
.xterm-char-measure-element { display: inline-block; visibility: hidden; position: absolute; top: 0; left: -9999em; line-height: normal; }
.xterm-screen .xterm-decoration-container .xterm-decoration { z-index: 6; position: absolute; }
`;

export interface LivePaneSpec {
  paneId: string;
  label: string;
  agent: AgentKind | 'shell';
  extraArgs?: readonly string[];
  autoSessionId?: boolean;
  /**
   * v2.7.19 · Explicit Claude session ID. Overrides `autoSessionId` so the
   * caller (e.g. the orchestrate command) can generate UUIDs up front and
   * persist them in a team snapshot. Ignored for codex/gemini/shell.
   */
  sessionId?: string;
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

interface LivePaneRuntime {
  spec: LivePaneSpec;
  pty: IPty;
  sessionId: string | undefined;
  onDataDisposable: { dispose(): void };
  onExitDisposable: { dispose(): void };
}

export interface PaneDataEvent {
  paneId: string;
  data: string;
}
export interface PaneExitEvent {
  paneId: string;
  exitCode: number;
}

/**
 * v0.3.1 · Orchestrator-facing contract for any multi-pane host.
 *
 * Originally this was `LiveMultiPanel`'s concrete class surface — extracted
 * to an interface so `LegacyPanelBridge` (which wraps N separate
 * `createPanel` webviews, one per agent) can also serve as an orchestrator
 * target without bringing its own xterm renderer. PodiumOrchestrator is
 * now typed against this interface, so either host works interchangeably.
 */
export interface OrchestratorPanel {
  readonly onPaneData: vscode.Event<PaneDataEvent>;
  readonly onPaneExit: vscode.Event<PaneExitEvent>;
  writeToPane(paneId: string, data: string): void;
  hasPane(paneId: string): boolean;
  removePane(paneId: string): void;
  addPane(spec: LivePaneSpec): void;
}

export class LiveMultiPanel {
  static readonly viewType = 'podium.liveMultipane';

  private readonly panes = new Map<string, LivePaneRuntime>();
  private ready = false;
  private readonly pendingMessages: unknown[] = [];
  // v2.7.27: Track lifecycle explicitly. Once `disposeAll()` runs (either from
  // the VSCode tab close or from `killAll`), further `addPane`/`writeToPane`/
  // `removePane` calls become no-ops and an `onDidDispose` consumer (the
  // orchestrate commands) can clean up the registry. Without this flag,
  // `addWorker` on a stale orchestrator would still spawn a pty process that
  // nobody tracks and immediately orphan it.
  private _disposed = false;

  // Orchestrator-facing events. Fired after the webview post, so subscribers
  // see raw pty output in order.
  private readonly paneDataEmitter = new vscode.EventEmitter<PaneDataEvent>();
  private readonly paneExitEmitter = new vscode.EventEmitter<PaneExitEvent>();
  // v2.7.27: Fires exactly once when the webview is disposed (either via the
  // tab close button or because `killAll` tore down the panel). Consumers
  // MUST subscribe to this rather than `onPaneExit` to detect user-driven
  // close — `disposeAll` intentionally dismantles `paneExitEmitter` before
  // pty.kill()'s onExit can fire, so that event path is unreachable in the
  // tab-close case.
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  public readonly onPaneData = this.paneDataEmitter.event;
  public readonly onPaneExit = this.paneExitEmitter.event;
  public readonly onDidDispose = this.disposeEmitter.event;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly output: vscode.OutputChannel,
  ) {
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    panel.onDidDispose(() => this.disposeAll());
  }

  /** v2.7.27 · Whether this panel's webview has been torn down. */
  get isDisposed(): boolean {
    return this._disposed;
  }

  static create(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    title: string,
  ): LiveMultiPanel {
    const panel = vscode.window.createWebviewPanel(
      LiveMultiPanel.viewType,
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'orchestration', 'webview')],
      },
    );
    panel.webview.html = buildHtml(panel, context);
    return new LiveMultiPanel(panel, output);
  }

  /** Spawn a CLI pane and register it for live streaming. */
  addPane(spec: LivePaneSpec): void {
    if (this._disposed) {
      // v2.7.27 · The webview is gone; do NOT spawn a pty because nobody
      // would reap its onExit event or route its output. Registry cleanup
      // should have already removed any orchestrator pointing here — the
      // `onDidDispose` subscription in the orchestrate command handler does
      // that. If a caller still reaches this, their reference is stale.
      this.output.appendLine(`[live] addPane "${spec.paneId}" ignored — panel disposed`);
      return;
    }
    if (this.panes.has(spec.paneId)) {
      this.output.appendLine(`[live] duplicate paneId "${spec.paneId}" — ignored`);
      return;
    }

    const cols = spec.cols ?? 120;
    const rows = spec.rows ?? 32;
    let pty: IPty;
    let sessionId: string | undefined;
    try {
      if (spec.agent === 'shell') {
        throw new Error(
          'LiveMultiPanel.addPane: shell panes not yet supported (will be added for codex/gemini bootstrap in a later phase).',
        );
      }
      const spawned = spawnAgent({
        agent: spec.agent,
        extraArgs: spec.extraArgs,
        sessionId: spec.sessionId,
        cols,
        rows,
        cwd: spec.cwd,
        env: spec.env,
        autoSessionId: spec.autoSessionId,
      });
      pty = spawned.pty;
      sessionId = spawned.sessionId;
      this.output.appendLine(
        `[live] spawn "${spec.paneId}" agent=${spec.agent} desc="${spawned.resolved.description}" pid=${pty.pid}${sessionId ? ` sid=${sessionId}` : ''}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[live] spawn failed for "${spec.paneId}" — ${msg}`);
      vscode.window.showErrorMessage(`Podium: couldn't spawn ${spec.agent} — ${msg}`);
      return;
    }

    const onData = pty.onData((data) => {
      this.postToWebview({ type: 'pty-data', paneId: spec.paneId, data });
      this.paneDataEmitter.fire({ paneId: spec.paneId, data });
    });
    const onExit = pty.onExit(({ exitCode }) => {
      this.output.appendLine(`[live] pane "${spec.paneId}" exited code=${exitCode}`);
      this.postToWebview({ type: 'pty-exit', paneId: spec.paneId, exitCode });
      this.paneExitEmitter.fire({ paneId: spec.paneId, exitCode });
    });

    this.panes.set(spec.paneId, {
      spec,
      pty,
      sessionId,
      onDataDisposable: onData,
      onExitDisposable: onExit,
    });

    this.postToWebview({
      type: 'add-pane',
      meta: {
        paneId: spec.paneId,
        label: spec.label,
        agent: spec.agent,
        agentColor: agentAccent(spec.agent),
      },
    });
  }

  /** Inject text into a specific pane's pty stdin (orchestrator use). */
  writeToPane(paneId: string, data: string): void {
    if (this._disposed) return;
    const rt = this.panes.get(paneId);
    if (!rt) return;
    try {
      rt.pty.write(data);
    } catch (err) {
      this.output.appendLine(
        `[live] write to "${paneId}" failed — ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * v2.7.25 · Does a pane with this id currently exist?
   * Used by `PodiumOrchestrator.addWorker` to verify that `addPane` succeeded
   * before mutating the worker Map (pane-first rollback ordering, ADR-1).
   */
  hasPane(paneId: string): boolean {
    return this.panes.has(paneId);
  }

  removePane(paneId: string): void {
    if (this._disposed) return;
    const rt = this.panes.get(paneId);
    if (!rt) return;
    try {
      rt.pty.kill();
    } catch {
      /* already dead */
    }
    rt.onDataDisposable.dispose();
    rt.onExitDisposable.dispose();
    this.panes.delete(paneId);
    this.postToWebview({ type: 'remove-pane', paneId });
  }

  /**
   * v2.7.27 · Programmatic tear-down. Same effect as the user closing the
   * webview tab (disposeAll runs via `onDidDispose`). Safe to call more than
   * once — the `_disposed` guard makes subsequent calls no-op.
   */
  dispose(): void {
    if (this._disposed) return;
    try {
      this.panel.dispose();
    } catch {
      // panel already disposed by VSCode; disposeAll still needs to run via
      // our onDidDispose subscription — but if that subscription was lost,
      // fall through to explicit cleanup below.
    }
    if (!this._disposed) this.disposeAll();
  }

  reveal(column?: vscode.ViewColumn, preserveFocus?: boolean): void {
    this.panel.reveal(column ?? vscode.ViewColumn.Active, preserveFocus ?? false);
  }

  /**
   * v0.3.3 · Switch pane layout orientation. 'horizontal' (default) keeps
   * multi-pane grids side-by-side — good for wide panels. 'vertical'
   * transposes them so panes stack top-to-bottom — good when this panel
   * is itself the right column of a split (Summon Team's workers host).
   */
  setOrientation(orientation: 'horizontal' | 'vertical'): void {
    this.postToWebview({ type: 'set-orientation', value: orientation });
  }

  private onMessage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const m = raw as {
      type?: string;
      paneId?: string;
      data?: unknown;
      cols?: unknown;
      rows?: unknown;
      text?: unknown;
    };
    if (m.type === 'ready') {
      this.ready = true;
      for (const pending of this.pendingMessages) {
        void this.panel.webview.postMessage(pending);
      }
      this.pendingMessages.length = 0;
      return;
    }
    if (m.type === 'input' && typeof m.paneId === 'string' && typeof m.data === 'string') {
      this.writeToPane(m.paneId, m.data);
      return;
    }
    if (m.type === 'resize' && typeof m.paneId === 'string') {
      const cols = Number(m.cols);
      const rows = Number(m.rows);
      if (cols > 0 && rows > 0) {
        const rt = this.panes.get(m.paneId);
        if (rt) {
          try {
            rt.pty.resize(cols, rows);
          } catch (err) {
            this.output.appendLine(
              `[live] resize "${m.paneId}" ${cols}x${rows} failed — ${err instanceof Error ? err.message : err}`,
            );
          }
        }
      }
      return;
    }
    if (m.type === 'copy-selection' && typeof m.text === 'string' && m.text) {
      vscode.env.clipboard.writeText(m.text).then(undefined, (err) => {
        this.output.appendLine(`[live] clipboard write failed — ${err}`);
      });
      return;
    }
  }

  private postToWebview(msg: unknown): void {
    if (!this.ready) {
      this.pendingMessages.push(msg);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  private disposeAll(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const [, rt] of this.panes) {
      try {
        rt.pty.kill();
      } catch {
        /* already dead */
      }
      rt.onDataDisposable.dispose();
      rt.onExitDisposable.dispose();
    }
    this.panes.clear();
    // v2.7.27: fire onDidDispose BEFORE disposing the emitters so consumers
    // (orchestrate command registry cleanup) can react synchronously.
    try {
      this.disposeEmitter.fire();
    } catch (err) {
      this.output.appendLine(
        `[live] disposeEmitter.fire threw — ${err instanceof Error ? err.message : err}`,
      );
    }
    this.disposeEmitter.dispose();
    this.paneDataEmitter.dispose();
    this.paneExitEmitter.dispose();
  }
}

function agentAccent(agent: AgentKind | 'shell'): string {
  if (agent === 'claude') return HEX.claude;
  if (agent === 'codex') return HEX.codex;
  if (agent === 'gemini') return HEX.gemini;
  return HEX.omc;
}

function buildHtml(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): string {
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'out', 'orchestration', 'webview', 'live-multipane.js'),
  );
  const nonce = makeNonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${panel.webview.cspSource} data:`,
    `img-src ${panel.webview.cspSource} data:`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Podium · Live Team</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100vh; background: #0f0f10; color: #d4d4d4; overflow: hidden; font-family: "Inter", "Segoe UI", sans-serif; }
  #grid { display: grid; gap: 6px; padding: 6px; width: 100%; height: 100vh; box-sizing: border-box; grid-template-rows: 1fr; grid-template-columns: 1fr; }
  .pane { display: flex; flex-direction: column; background: #000; border: 1px solid #2a2a2d; border-radius: 4px; overflow: hidden; min-height: 0; min-width: 0; }
  .pane.active { border-color: var(--pane-accent, #7aa2f7); box-shadow: 0 0 0 1px var(--pane-accent, #7aa2f7); }
  .pane-header { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: #151518; font-size: 11px; color: #bbb; border-bottom: 1px solid #2a2a2d; }
  .pane-header .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--pane-accent, #7aa2f7); display: inline-block; }
  .pane-header .agent { font-weight: 600; color: var(--pane-accent, #7aa2f7); letter-spacing: 0.5px; }
  .pane-header .name { color: #ddd; }
  .pane-header .id { color: #666; margin-left: auto; }
  .pane-body { flex: 1; min-height: 0; padding: 4px; }
  #emptyMsg { display: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #666; font-size: 13px; }
  ${XTERM_CSS}
</style>
</head>
<body>
  <div id="grid"></div>
  <div id="emptyMsg">No panes yet</div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
