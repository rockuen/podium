import * as vscode from 'vscode';
import type { HUDStdinCache } from '../types/hud';
import type { SessionHistorySnapshot } from '../types/history';
import type { CcgSnapshot } from '../types/ccg';
import { HEX } from './colors';
import { buildSharedWebviewCss } from './webviewTheme';

export interface HUDDashboardSnapshot {
  hud: HUDStdinCache | null;
  history: SessionHistorySnapshot | null;
  ccg: CcgSnapshot | null;
}

export class HUDDashboardPanel {
  static readonly viewType = 'podium.hudDashboard';
  private static current: HUDDashboardPanel | null = null;
  private latest: HUDDashboardSnapshot = { hud: null, history: null, ccg: null };

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    panel.onDidDispose(() => {
      if (HUDDashboardPanel.current === this) HUDDashboardPanel.current = null;
    });

    panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string };
      if (m.type === 'ready') {
        this.push();
        return;
      }
      if (m.type === 'refresh') {
        vscode.commands.executeCommand('podium.refreshHud');
        vscode.commands.executeCommand('podium.refreshHistory');
        vscode.commands.executeCommand('podium.refreshCcg');
      }
    });
  }

  static show(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    snapshot: HUDDashboardSnapshot,
  ): HUDDashboardPanel {
    if (HUDDashboardPanel.current) {
      HUDDashboardPanel.current.updateSnapshot(snapshot);
      HUDDashboardPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
      return HUDDashboardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      HUDDashboardPanel.viewType,
      'Podium · OMC Analytics',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
      },
    );
    const instance = new HUDDashboardPanel(panel, context, output);
    HUDDashboardPanel.current = instance;
    instance.latest = snapshot;
    panel.webview.html = instance.buildHtml();
    return instance;
  }

  static get isOpen(): boolean {
    return HUDDashboardPanel.current !== null;
  }

  static broadcast(partial: Partial<HUDDashboardSnapshot>): void {
    const cur = HUDDashboardPanel.current;
    if (!cur) return;
    cur.updateSnapshot({ ...cur.latest, ...partial });
  }

  private updateSnapshot(snapshot: HUDDashboardSnapshot): void {
    this.latest = snapshot;
    this.push();
  }

  private push(): void {
    this.panel.webview.postMessage({
      type: 'snapshot',
      snapshot: {
        hud: this.latest.hud,
        history: this.latest.history
          ? {
              entries: this.latest.history.entries.map((e) => ({
                sessionId: e.sessionId,
                directory: e.directory,
                modes: e.modes,
                hasCancelSignal: e.hasCancelSignal,
                directoryMtime: e.directoryMtime,
                startTs: parseIsoMs(e.hud?.sessionStartTimestamp),
                updateTs: parseIsoMs(e.hud?.timestamp),
                backgroundTaskCount: e.hud?.backgroundTasks?.length ?? 0,
              })),
              activeSessionId: this.latest.history.activeSessionId,
              scannedAt: this.latest.history.scannedAt,
            }
          : null,
        ccg: this.latest.ccg
          ? {
              pairCount: this.latest.ccg.pairs.length,
              scannedAt: this.latest.ccg.scannedAt,
            }
          : null,
      },
    });
  }

  private buildHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'hud-dashboard.js'),
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
<title>Podium · OMC Analytics</title>
<style>
${buildSharedWebviewCss()}
  html, body { overflow: auto; }
  body { display: flex; flex-direction: column; min-height: 100%; }

  #header { height: 56px; flex: 0 0 56px; background: var(--bg-titlebar); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; padding: 0 24px; }
  #header .head-icon { color: var(--accent-omc); font-size: 20px; line-height: 1; }
  #header .title { font-size: 16px; font-weight: 700; }
  #header .sub { color: var(--text-disabled); font-size: 12px; }
  #header .spacer { flex: 1 1 auto; }
  #header .pill { display: inline-flex; align-items: center; gap: 6px; height: 28px; border-radius: 4px; padding: 0 10px; background: var(--bg-card); border: 1px solid var(--border); font-size: 11px; color: var(--text-primary); cursor: pointer; }
  #header .pill:hover { border-color: var(--accent-omc); color: var(--accent-omc); }
  #header .pill .icon { color: var(--text-secondary); font-size: 12px; }
  #header .pill:hover .icon { color: var(--accent-omc); }

  #body { flex: 1 1 auto; padding: 20px 24px; display: flex; flex-direction: column; gap: 20px; min-height: 0; }

  .stats-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  @media (max-width: 900px) { .stats-row { grid-template-columns: 1fr; } .charts-row { grid-template-columns: 1fr !important; } .charts-row .breakdown { width: auto !important; } }

  .card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
  .card .top { display: flex; align-items: center; gap: 8px; }
  .card .top .title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
  .card .top .spacer { flex: 1 1 auto; }
  .card .top .trend { font-size: 10px; padding: 0 6px; height: 16px; line-height: 16px; border-radius: 3px; background: var(--bg-input); color: var(--text-secondary); font-family: Consolas, monospace; }
  .card .top .trend.up { color: var(--status-success); }
  .card .val { font-size: 32px; font-weight: 800; letter-spacing: -0.5px; color: var(--text-primary); line-height: 1; }
  .card .val.money { color: var(--status-success); }
  .card .sub { font-size: 11px; color: var(--text-disabled); }
  .card .icon-claude { color: var(--accent-claude); }
  .card .icon-codex { color: var(--accent-codex); }
  .card .icon-gemini { color: var(--accent-gemini); }
  .card .icon-omc { color: var(--accent-omc); }

  .charts-row { display: grid; grid-template-columns: 1fr 320px; gap: 14px; }
  .charts-row .hourly { height: 260px; }
  .charts-row .breakdown { height: 260px; }

  .bars { flex: 1 1 auto; display: flex; align-items: flex-end; gap: 4px; padding: 8px 0 24px; position: relative; }
  .bars .bar-wrap { flex: 1 1 0; display: flex; flex-direction: column; align-items: center; gap: 4px; position: relative; }
  .bars .bar { width: 100%; background: linear-gradient(to top, var(--accent-omc), #F97316); border-radius: 3px 3px 0 0; min-height: 2px; transition: height 0.2s ease; opacity: 0.95; }
  .bars .bar:hover { opacity: 1; box-shadow: 0 0 12px var(--accent-omc); }
  .bars .bar.empty { background: var(--bg-panel); opacity: 0.5; }
  .bars .label { font-size: 9px; color: var(--text-disabled); font-family: Consolas, monospace; position: absolute; bottom: -16px; }
  .chart-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .chart-head .title { font-size: 13px; font-weight: 600; }
  .chart-head .sub { font-size: 10px; color: var(--text-disabled); margin-left: auto; font-family: Consolas, monospace; }

  .donut-wrap { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; position: relative; gap: 16px; }
  .donut-svg { width: 140px; height: 140px; }
  .donut-center { position: absolute; left: 0; top: 0; width: 140px; height: 140px; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
  .donut-center .big { font-size: 20px; font-weight: 800; }
  .donut-center .small { font-size: 10px; color: var(--text-disabled); }
  .legend { display: flex; flex-direction: column; gap: 6px; font-size: 11px; }
  .legend .row { display: flex; align-items: center; gap: 8px; }
  .legend .dot { width: 8px; height: 8px; border-radius: 50%; }
  .legend .name { color: var(--text-primary); font-weight: 600; min-width: 50px; }
  .legend .val { color: var(--text-secondary); font-family: Consolas, monospace; }

  .sessions-card { padding: 16px 18px 12px; }
  .sessions-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .sessions-head .title { font-size: 13px; font-weight: 600; }
  .sessions-head .all { color: var(--text-link); font-size: 11px; cursor: pointer; margin-left: auto; }
  .sessions-head .all:hover { text-decoration: underline; }
  .sessions-list { display: flex; flex-direction: column; gap: 4px; }
  .srow { display: grid; grid-template-columns: 14px 1fr 140px 90px 80px 80px; align-items: center; gap: 14px; padding: 0 10px; height: 36px; border-radius: 4px; }
  .srow.active { background: var(--bg-panel); }
  .srow .dot { width: 8px; height: 8px; border-radius: 50%; }
  .srow .name { font-weight: 600; font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow .modes { color: var(--text-secondary); font-family: Consolas, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow .dur, .srow .bg, .srow .updated { color: var(--text-secondary); font-size: 11px; text-align: right; font-family: Consolas, monospace; }
  .srow .updated.fresh { color: var(--status-running); font-weight: 600; }
  .sessions-empty { padding: 24px 0; color: var(--text-disabled); text-align: center; font-size: 12px; }

  .ctx-bar { height: 6px; border-radius: 3px; background: var(--bg-panel); overflow: hidden; position: relative; margin-top: 4px; }
  .ctx-bar .fill { height: 100%; border-radius: 3px; transition: width 0.3s ease; }

  .rl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .rl-item { padding: 10px 12px; background: var(--bg-panel); border-radius: 4px; }
  .rl-item .l { font-size: 10px; color: var(--text-disabled); margin-bottom: 4px; }
  .rl-item .v { font-size: 16px; font-weight: 700; }
  .rl-item .r { font-size: 10px; color: var(--text-secondary); font-family: Consolas, monospace; margin-top: 2px; }

  .empty-state { padding: 48px 24px; text-align: center; color: var(--text-disabled); font-size: 13px; line-height: 1.7; }
  .empty-state strong { display: block; color: var(--text-primary); font-size: 15px; margin-bottom: 8px; }
</style>
</head>
<body>
<div id="header">
  <span class="head-icon">◆</span>
  <span class="title">OMC Analytics</span>
  <span class="sub">· Live</span>
  <span class="spacer"></span>
  <span class="pill" id="refreshBtn"><span class="icon">↻</span><span>Refresh</span></span>
</div>
<div id="body">
  <div class="empty-state"><strong>Loading…</strong>Connecting to OMC state watchers.</div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function parseIsoMs(iso?: string): number {
  if (!iso) return 0;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? 0 : n;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
