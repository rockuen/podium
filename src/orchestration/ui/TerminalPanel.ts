import * as vscode from 'vscode';
import type { IPty } from 'node-pty';
import { OMCRuntime, TeamSpec } from '../core/OMCRuntime';
import { PodiumManager } from '../core/PodiumManager';

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
.xterm.enable-mouse-events { cursor: default; }
.xterm.xterm-cursor-pointer, .xterm .xterm-cursor-pointer { cursor: pointer; }
.xterm.column-select.focus { cursor: crosshair; }
.xterm .xterm-accessibility, .xterm .xterm-message { position: absolute; left: 0; top: 0; bottom: 0; right: 0; z-index: 10; color: transparent; pointer-events: none; }
.xterm .xterm-accessibility-tree { user-select: text; white-space: pre; }
.xterm-dim { opacity: 0.5; }
.xterm-underline-1 { text-decoration: underline; }
.xterm-strikethrough { text-decoration: line-through; }
.xterm-screen .xterm-decoration-container .xterm-decoration { z-index: 6; position: absolute; }
.xterm-screen .xterm-decoration-container .xterm-decoration.xterm-decoration-top-layer { z-index: 7; }
.xterm-decoration-overview-ruler { z-index: 8; position: absolute; top: 0; right: 0; pointer-events: none; }
.xterm-decoration-top { z-index: 2; position: relative; }
`;

export interface SpawnClaudeOptions {
  readonly title: string;
  readonly cwd: string;
  readonly teamSpec?: TeamSpec;
  readonly dispatchDelayMs: number;
}

export interface AttachOptions {
  readonly sessionName: string;
  readonly cwd: string;
  readonly multiplexerBinary: string;
}

export class TerminalPanel {
  static readonly viewType = 'podium.terminal';

  static async openClaude(
    context: vscode.ExtensionContext,
    runtime: OMCRuntime,
    manager: PodiumManager,
    output: vscode.OutputChannel,
    opts: SpawnClaudeOptions,
  ): Promise<void> {
    output.appendLine(`[podium] TerminalPanel.openClaude entered title="${opts.title}" cwd="${opts.cwd}"`);
    let proc;
    try {
      output.appendLine('[podium] TerminalPanel.openClaude -> spawnClaude');
      proc = runtime.spawnClaude({ cwd: opts.cwd, cols: 120, rows: 32 });
      output.appendLine(`[podium] TerminalPanel.openClaude <- spawnClaude pid=${proc.pid}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`[podium] spawnClaude failed: ${msg}`);
      vscode.window.showErrorMessage(msg);
      return;
    }
    output.appendLine('[podium] TerminalPanel.openClaude -> createPanel');
    const panel = createPanel(context, opts.title);
    output.appendLine('[podium] TerminalPanel.openClaude <- createPanel');
    wirePanel(context, panel, proc, output);
    output.appendLine('[podium] TerminalPanel.openClaude wirePanel done');
    const id = `claude-${proc.pid}`;
    manager.register({ id, title: opts.title, pty: proc, panel });
    const desc = (proc as unknown as { _description?: string })._description ?? 'unknown';
    output.appendLine(
      `[podium] spawned claude pid=${proc.pid} via ${desc} cwd="${opts.cwd}"`,
    );
    if (opts.teamSpec) {
      const cmd = runtime.formatTeamCommand(opts.teamSpec);
      setTimeout(() => {
        try {
          output.appendLine(`[podium] dispatch /team: ${cmd}`);
          proc.write(cmd + '\r');
        } catch (err) {
          output.appendLine(`[podium] dispatch failed: ${err}`);
        }
      }, Math.max(0, opts.dispatchDelayMs));
    }
  }

  static async attach(
    context: vscode.ExtensionContext,
    runtime: OMCRuntime,
    manager: PodiumManager,
    output: vscode.OutputChannel,
    opts: AttachOptions,
  ): Promise<void> {
    const title = `attach · ${opts.sessionName}`;
    const existing = manager.findByTitle(title);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = createPanel(context, title);
    const proc = runtime.attachMultiplexerSession(opts.multiplexerBinary, opts.sessionName, {
      cwd: opts.cwd,
      cols: 120,
      rows: 32,
    });
    wirePanel(context, panel, proc, output);
    const id = `attach-${opts.sessionName}-${proc.pid}`;
    manager.register({ id, title, pty: proc, panel });
    output.appendLine(
      `[podium] attached "${opts.sessionName}" via ${opts.multiplexerBinary} pid=${proc.pid}`,
    );
  }
}

function createPanel(context: vscode.ExtensionContext, title: string): vscode.WebviewPanel {
  return vscode.window.createWebviewPanel(
    TerminalPanel.viewType,
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'orchestration', 'webview')],
    },
  );
}

function wirePanel(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  proc: IPty,
  output: vscode.OutputChannel,
): void {
  panel.webview.html = buildHtml(panel, context);
  const startedAt = Date.now();

  const onData = proc.onData((data) => {
    panel.webview.postMessage({ type: 'pty-data', data });
  });
  const onExit = proc.onExit(({ exitCode }) => {
    const elapsedMs = Date.now() - startedAt;
    output.appendLine(`[podium] pty exit pid=${proc.pid} code=${exitCode} after ${elapsedMs}ms`);
    panel.webview.postMessage({ type: 'pty-exit', exitCode });
    if (elapsedMs < 2500) {
      const desc = (proc as unknown as { _description?: string })._description ?? 'unknown';
      vscode.window.showWarningMessage(
        `Podium: terminal process exited immediately (exit=${exitCode}, ${elapsedMs}ms, src=${desc}). Check Output → Podium for details.`,
      );
    }
  });

  const onMessage = panel.webview.onDidReceiveMessage((msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; data?: unknown; cols?: unknown; rows?: unknown; text?: unknown };
    if (m.type === 'input' && typeof m.data === 'string') {
      try {
        proc.write(m.data);
      } catch (err) {
        output.appendLine(`[podium] write failed: ${err}`);
      }
    } else if (m.type === 'resize') {
      const cols = Number(m.cols);
      const rows = Number(m.rows);
      if (cols > 0 && rows > 0) {
        try {
          proc.resize(cols, rows);
        } catch (err) {
          output.appendLine(`[podium] resize failed: ${err}`);
        }
      }
    } else if (m.type === 'copy-selection' && typeof m.text === 'string' && m.text) {
      // v2.6.28: auto-copy webview drag selection on mouseup so Claude TUI
      // redraw doesn't cost the user their highlight. Visible selection may
      // clear on the next frame but clipboard content is already set.
      vscode.env.clipboard.writeText(m.text).then(undefined, (err) => {
        output.appendLine(`[podium] clipboard write failed: ${err}`);
      });
    }
  });

  panel.onDidDispose(() => {
    onData.dispose();
    onExit.dispose();
    onMessage.dispose();
    try {
      proc.kill();
    } catch {
      // already exited
    }
  });
}

function buildHtml(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): string {
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'out', 'orchestration', 'webview', 'terminal.js'),
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
<title>Podium Terminal</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; color: #fff; overflow: hidden; }
  #terminal { width: 100%; height: 100vh; padding: 4px; box-sizing: border-box; }
  ${XTERM_CSS}
</style>
</head>
<body>
  <div id="terminal"></div>
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
