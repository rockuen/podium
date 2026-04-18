import * as vscode from 'vscode';
import * as path from 'path';
import type { CcgArtifact, CcgPair } from '../types/ccg';
import { HEX } from './colors';
import { buildSharedWebviewCss } from './webviewTheme';

export interface CcgViewerDeps {
  getPair: (id: string) => CcgPair | null;
  onRerun: (pair: CcgPair) => Promise<void>;
}

interface PairPayload {
  id: string;
  title: string;
  createdAt: number;
  originalTask: string;
  codex: ArtifactPayload | null;
  gemini: ArtifactPayload | null;
  claude: ArtifactPayload | null;
}

interface ArtifactPayload {
  provider: 'codex' | 'gemini' | 'claude';
  createdAt: number;
  exitCode: number | null;
  finalPrompt: string;
  rawOutput: string;
  filePath: string;
  fileName: string;
}

export class CcgViewerPanel {
  static readonly viewType = 'podium.ccgViewer';
  private static current: CcgViewerPanel | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly deps: CcgViewerDeps,
    private readonly output: vscode.OutputChannel,
    private currentPairId: string | null,
  ) {
    panel.onDidDispose(() => {
      if (CcgViewerPanel.current === this) CcgViewerPanel.current = null;
    });

    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; text?: string; pairId?: string };
      if (m.type === 'ready') {
        this.pushCurrent();
        return;
      }
      if (m.type === 'copy' && typeof m.text === 'string') {
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage('Podium: CCG output copied', 2000);
        return;
      }
      if (m.type === 'open-source' && typeof m.text === 'string') {
        try {
          const doc = await vscode.workspace.openTextDocument(m.text);
          await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
        } catch (err) {
          vscode.window.showWarningMessage(
            `Podium: could not open ${m.text} — ${err instanceof Error ? err.message : err}`,
          );
        }
        return;
      }
      if (m.type === 'rerun' && typeof m.pairId === 'string') {
        const pair = this.deps.getPair(m.pairId);
        if (!pair) return;
        try {
          await this.deps.onRerun(pair);
        } catch (err) {
          this.output.appendLine(`[podium.ccg] rerun failed: ${err}`);
        }
      }
    });
  }

  static show(
    context: vscode.ExtensionContext,
    deps: CcgViewerDeps,
    output: vscode.OutputChannel,
    pairId: string,
  ): void {
    if (CcgViewerPanel.current) {
      CcgViewerPanel.current.currentPairId = pairId;
      CcgViewerPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
      CcgViewerPanel.current.pushCurrent();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      CcgViewerPanel.viewType,
      'Podium · CCG Viewer',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'orchestration', 'webview')],
      },
    );
    const instance = new CcgViewerPanel(panel, context, deps, output, pairId);
    CcgViewerPanel.current = instance;
    panel.webview.html = instance.buildHtml();
  }

  static refreshIfOpen(): void {
    CcgViewerPanel.current?.pushCurrent();
  }

  static updatePairId(pairId: string): void {
    if (CcgViewerPanel.current) {
      CcgViewerPanel.current.currentPairId = pairId;
      CcgViewerPanel.current.pushCurrent();
    }
  }

  private pushCurrent(): void {
    const pair = this.currentPairId ? this.deps.getPair(this.currentPairId) : null;
    this.panel.webview.postMessage({
      type: 'pair',
      pair: pair ? toPayload(pair) : null,
    });
  }

  private buildHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'orchestration', 'webview', 'ccg-viewer.js'),
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
<title>Podium · CCG Viewer</title>
<style>
${buildSharedWebviewCss()}
  html, body { overflow: hidden; }
  body { display: flex; flex-direction: column; }

  #header { height: 56px; flex: 0 0 56px; background: var(--bg-titlebar); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; padding: 0 24px; }
  #header .head-icon { color: var(--accent-omc); font-size: 18px; line-height: 1; }
  #header .title { display: flex; flex-direction: column; gap: 2px; flex: 0 1 auto; min-width: 0; }
  #header .title .name { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #header .title .sub { font-size: 10px; color: var(--text-disabled); font-family: Consolas, "Cascadia Code", monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #header .spacer { flex: 1 1 auto; }
  #header .badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 12px; padding: 0 10px; height: 24px; background: #1e2e1e; font-size: 11px; font-weight: 600; color: var(--status-success); }
  #header .badge .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--status-success); }
  #header .badge.fail { background: #2e1e1e; color: var(--status-error); }
  #header .badge.fail .dot { background: var(--status-error); }

  #summary { padding: 12px 24px; background: var(--bg-card); border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; gap: 12px; min-height: 44px; }
  #summary .sum-icon { color: var(--accent-claude); font-size: 16px; flex: 0 0 auto; line-height: 1.4; }
  #summary .sum-text { font-size: 12px; line-height: 1.4; color: var(--text-primary); }

  #body { flex: 1 1 auto; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; padding: 16px; min-height: 0; }
  @media (max-width: 1100px) { #body { grid-template-columns: 1fr 1fr; } .claude-col { grid-column: span 2; } }
  @media (max-width: 700px) { #body { grid-template-columns: 1fr; } .claude-col { grid-column: auto; } }

  .col { display: flex; flex-direction: column; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; min-height: 0; }
  .col.codex-col { --accent: var(--accent-codex); }
  .col.gemini-col { --accent: var(--accent-gemini); }
  .col.claude-col { --accent: var(--accent-claude); border: 1.5px solid var(--accent-claude); }

  .col-head { height: 44px; flex: 0 0 44px; padding: 0 14px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
  .col-head .icon { color: var(--accent); font-size: 16px; line-height: 1; }
  .col-head .name { font-weight: 700; font-size: 13px; }
  .col-head .spacer { flex: 1 1 auto; }
  .col-head .tag { display: inline-flex; align-items: center; height: 18px; border-radius: 9px; padding: 0 8px; background: var(--bg-input); font-size: 10px; color: var(--text-secondary); font-family: Consolas, monospace; }
  .claude-col .col-head { background: #2a1f3d; border-bottom: 1px solid var(--accent-claude); }
  .claude-col .col-head .tag { background: var(--accent-claude); color: #1a1a1a; font-weight: 700; }

  .col-body { flex: 1 1 auto; overflow-y: auto; padding: 12px 14px; }
  .col-body .prompt { font-size: 10px; color: var(--text-disabled); font-family: Consolas, monospace; padding: 8px 10px; background: var(--bg-panel); border-radius: 4px; border-left: 3px solid var(--border); margin-bottom: 10px; white-space: pre-wrap; word-break: break-word; }
  .col-body .md { font-size: 12px; line-height: 1.55; color: var(--text-primary); word-break: break-word; }
  .col-body .md h1, .col-body .md h2, .col-body .md h3 { margin: 14px 0 6px; font-weight: 700; color: var(--text-primary); }
  .col-body .md h1 { font-size: 15px; }
  .col-body .md h2 { font-size: 14px; }
  .col-body .md h3 { font-size: 13px; color: var(--accent); }
  .col-body .md p { margin: 6px 0; }
  .col-body .md ul, .col-body .md ol { margin: 6px 0; padding-left: 20px; }
  .col-body .md li { margin: 3px 0; }
  .col-body .md strong { font-weight: 700; color: var(--text-primary); }
  .col-body .md em { font-style: italic; color: var(--text-secondary); }
  .col-body .md code { background: var(--bg-input); color: var(--accent); padding: 1px 5px; border-radius: 3px; font-family: Consolas, "Cascadia Code", monospace; font-size: 11px; }
  .col-body .md pre { background: var(--bg-panel); padding: 10px 12px; border-radius: 4px; overflow-x: auto; margin: 8px 0; border-left: 3px solid var(--border); }
  .col-body .md pre code { background: transparent; color: var(--text-primary); padding: 0; font-size: 11px; }

  .col-foot { border-top: 1px solid var(--border); padding: 10px 14px 12px; display: flex; gap: 8px; flex: 0 0 auto; }
  .col-foot button { flex: 1 1 0; height: 30px; border-radius: 4px; font-size: 11px; font-weight: 600; cursor: pointer; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-primary); display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .col-foot button:hover { border-color: var(--accent); color: var(--accent); }
  .col-foot button.primary { background: var(--accent); color: #0c0c0c; border-color: var(--accent); }
  .col-foot button.primary:hover { opacity: 0.9; color: #0c0c0c; }

  .empty-placeholder { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 24px; color: var(--text-disabled); font-size: 12px; text-align: center; line-height: 1.6; }
  .empty-placeholder strong { color: var(--text-secondary); display: block; margin-bottom: 4px; font-size: 13px; }

  .no-pair { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 32px; color: var(--text-disabled); font-size: 13px; text-align: center; line-height: 1.7; }
  .no-pair strong { display: block; color: var(--text-primary); font-size: 15px; margin-bottom: 8px; }
  .no-pair code { background: var(--bg-input); color: var(--accent-omc); padding: 2px 6px; border-radius: 3px; font-family: Consolas, monospace; font-size: 12px; }
</style>
</head>
<body>
<div id="app">
  <div class="no-pair"><div><strong>CCG Viewer</strong>Select a CCG session from the <em>CCG</em> sidebar to inspect Codex + Gemini responses side-by-side.<br/>Run a new comparison with <code>/ccg "your question"</code>.</div></div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function toPayload(pair: CcgPair): PairPayload {
  return {
    id: pair.id,
    title: pair.title,
    createdAt: pair.createdAt,
    originalTask: pair.codex?.originalTask || pair.gemini?.originalTask || pair.claude?.originalTask || '',
    codex: pair.codex ? toArtifactPayload(pair.codex) : null,
    gemini: pair.gemini ? toArtifactPayload(pair.gemini) : null,
    claude: pair.claude ? toArtifactPayload(pair.claude) : null,
  };
}

function toArtifactPayload(a: CcgArtifact): ArtifactPayload {
  return {
    provider: a.provider,
    createdAt: a.createdAt,
    exitCode: a.exitCode,
    finalPrompt: a.finalPrompt,
    rawOutput: a.rawOutput,
    filePath: a.filePath,
    fileName: path.basename(a.filePath),
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
