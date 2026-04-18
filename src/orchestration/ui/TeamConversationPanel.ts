import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TeamConversationWatcher } from '../core/TeamConversationWatcher';
import type { ConversationSnapshot, MailboxMessage, WorkerProvider } from '../types/conversation';
import { HEX } from './colors';
import { buildSharedWebviewCss } from './webviewTheme';

export class TeamConversationPanel {
  static readonly viewType = 'podium.teamConversation';
  private static instances = new Map<string, TeamConversationPanel>();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly watcher: TeamConversationWatcher,
    private readonly output: vscode.OutputChannel,
    private readonly teamName: string,
    private readonly root: string,
  ) {
    const onSnap = (snap: ConversationSnapshot) => this.push(snap);
    this.watcher.on('snapshot', onSnap);

    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string };
      if (m.type === 'ready') {
        const snap = this.watcher.snapshot();
        if (snap) this.push(snap);
        return;
      }
      if (m.type === 'refresh') {
        this.watcher.forceRefresh();
        return;
      }
      if (m.type === 'copy-transcript') {
        const md = buildMarkdownTranscript(this.watcher.snapshot());
        await vscode.env.clipboard.writeText(md);
        vscode.window.setStatusBarMessage(
          `Podium: transcript copied (${(this.watcher.snapshot()?.messages.length ?? 0)} messages)`,
          3000,
        );
        this.output.appendLine(`[podium.convo] copied transcript for "${this.teamName}"`);
        return;
      }
      if (m.type === 'save-transcript') {
        try {
          const saved = await this.saveTranscript();
          if (saved) {
            const doc = await vscode.workspace.openTextDocument(saved);
            await vscode.window.showTextDocument(doc, { preview: false });
            this.output.appendLine(`[podium.convo] saved transcript → ${saved}`);
          }
        } catch (err) {
          const emsg = err instanceof Error ? err.message : String(err);
          this.output.appendLine(`[podium.convo] save failed: ${emsg}`);
          vscode.window.showErrorMessage(`Podium: transcript save failed — ${emsg}`);
        }
        return;
      }
    });

    panel.onDidDispose(() => {
      this.watcher.off('snapshot', onSnap);
      this.watcher.stop();
      TeamConversationPanel.instances.delete(this.teamName);
      this.output.appendLine(`[podium.convo] panel disposed for "${this.teamName}"`);
    });
  }

  static show(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    root: string,
    teamName: string,
  ): TeamConversationPanel {
    const existing = TeamConversationPanel.instances.get(teamName);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active, false);
      existing.watcher.forceRefresh();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      TeamConversationPanel.viewType,
      `Conversation · ${teamName}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'orchestration', 'webview')],
      },
    );
    const watcher = new TeamConversationWatcher((msg) => output.appendLine(msg));
    watcher.start(root, teamName);
    const instance = new TeamConversationPanel(panel, context, watcher, output, teamName, root);
    TeamConversationPanel.instances.set(teamName, instance);
    panel.webview.html = instance.buildHtml();
    return instance;
  }

  private push(snap: ConversationSnapshot): void {
    this.panel.webview.postMessage({ type: 'snapshot', snapshot: snap });
  }

  private async saveTranscript(): Promise<string | null> {
    const snap = this.watcher.snapshot();
    if (!snap) return null;
    const md = buildMarkdownTranscript(snap);
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace(/T/, '_')
      .replace(/Z$/, '');
    const fileName = `${this.teamName}-${ts}.md`;
    const dir = path.join(this.root, '.omc', 'artifacts', 'conversations');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, md, 'utf8');
    return filePath;
  }

  private buildHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'orchestration', 'webview', 'team-conversation.js'),
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
<title>Conversation · ${escapeHtml(this.teamName)}</title>
<style>
${buildSharedWebviewCss()}
  html, body { overflow: hidden; }
  body { display: flex; flex-direction: column; }

  #header { height: 56px; flex: 0 0 56px; background: var(--bg-titlebar); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; padding: 0 20px; }
  #header .title-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 0 1 auto; }
  #header .name { font-size: 14px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #header .sub { font-size: 11px; color: var(--text-disabled); font-family: Consolas, "Cascadia Code", monospace; }
  #header .workers { flex: 0 1 auto; display: flex; align-items: center; gap: 6px; margin-left: 10px; overflow: hidden; }
  #header .spacer { flex: 1 1 auto; }
  #header .count { font-size: 11px; color: var(--text-secondary); font-family: Consolas, monospace; }
  #header .pill { display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; height: 22px; border-radius: 11px; font-size: 10px; font-weight: 600; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-secondary); }
  #header .pill .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  #header .pill.claude { color: var(--accent-claude); border-color: var(--accent-claude); }
  #header .pill.codex { color: var(--accent-codex); border-color: var(--accent-codex); }
  #header .pill.gemini { color: var(--accent-gemini); border-color: var(--accent-gemini); }
  #header .pill.leader { color: var(--accent-leader); border-color: var(--accent-leader); }
  #header .refresh { cursor: pointer; color: var(--text-disabled); padding: 4px 8px; border-radius: 3px; user-select: none; font-size: 12px; }
  #header .refresh:hover { color: var(--text-primary); background: var(--bg-card); }

  #feed { flex: 1 1 auto; overflow-y: auto; padding: 20px 24px 24px; display: flex; flex-direction: column; gap: 14px; }
  #feed::-webkit-scrollbar { width: 10px; }
  #feed::-webkit-scrollbar-track { background: transparent; }
  #feed::-webkit-scrollbar-thumb { background: var(--bg-card); border-radius: 5px; }

  .msg { display: flex; flex-direction: column; gap: 6px; max-width: min(720px, 90%); }
  .msg.from-leader { align-self: flex-start; }
  .msg.from-worker { align-self: flex-end; }
  .msg .meta { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--text-disabled); font-family: Consolas, monospace; }
  .msg .who { font-weight: 700; }
  .msg .arrow { color: var(--text-disabled); }
  .msg .target { color: var(--text-secondary); }
  .msg .time { margin-left: auto; cursor: help; }
  .msg .bubble { position: relative; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg-card)); line-height: 1.55; font-size: 13px; word-wrap: break-word; white-space: pre-wrap; color: var(--text-primary); }
  .msg .bubble::before { content: ''; position: absolute; top: 12px; width: 3px; height: 20px; background: var(--accent); border-radius: 2px; }
  .msg.from-leader .bubble { border-top-left-radius: 2px; }
  .msg.from-leader .bubble::before { left: -6px; }
  .msg.from-worker .bubble { border-top-right-radius: 2px; }
  .msg.from-worker .bubble::before { right: -6px; }

  .msg.provider-claude { --accent: var(--accent-claude); }
  .msg.provider-codex { --accent: var(--accent-codex); }
  .msg.provider-gemini { --accent: var(--accent-gemini); }
  .msg.provider-leader { --accent: var(--accent-leader); }
  .msg.provider-unknown { --accent: var(--text-secondary); }

  .msg .bubble code { background: rgba(0,0,0,0.3); color: var(--accent); padding: 1px 5px; border-radius: 3px; font-family: Consolas, "Cascadia Code", monospace; font-size: 11.5px; white-space: pre; }
  .msg .bubble pre { background: rgba(0,0,0,0.35); padding: 10px 12px; border-radius: 4px; overflow-x: auto; margin: 6px 0; font-size: 11.5px; line-height: 1.45; white-space: pre; }
  .msg .bubble strong { font-weight: 700; }

  .empty-state { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; padding: 40px; color: var(--text-disabled); font-size: 13px; line-height: 1.7; text-align: center; }
  .empty-state strong { display: block; color: var(--text-primary); font-size: 15px; margin-bottom: 8px; }
  .empty-state code { background: var(--bg-input); color: var(--accent-omc); padding: 2px 6px; border-radius: 3px; font-family: Consolas, monospace; font-size: 12px; }

  .delivery-marker { align-self: center; font-size: 10px; color: var(--text-disabled); font-family: Consolas, monospace; padding: 2px 10px; border: 1px solid var(--border); border-radius: 11px; background: var(--bg-panel); }
</style>
</head>
<body>
<div id="header">
  <div class="title-row">
    <div class="name">${escapeHtml(this.teamName)}</div>
    <div class="sub">.omc/state/team/${escapeHtml(this.teamName)}/mailbox</div>
  </div>
  <div class="workers" id="workers"></div>
  <div class="spacer"></div>
  <div class="count" id="count">0 messages</div>
  <div class="refresh" id="copy-transcript" title="Copy full transcript as markdown to clipboard">⧉</div>
  <div class="refresh" id="save-transcript" title="Save transcript to .omc/artifacts/conversations/*.md">⬇</div>
  <div class="refresh" id="refresh" title="Re-scan mailbox files">↻</div>
</div>
<div id="feed">
  <div class="empty-state">
    <div>
      <strong>Waiting for messages</strong>
      No mailbox entries yet. Once workers ACK or leader dispatches tasks, messages will appear here live.
    </div>
  </div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function buildMarkdownTranscript(snap: ConversationSnapshot | null): string {
  if (!snap) return '# Team Conversation\n\n(no snapshot available)\n';
  const lines: string[] = [];
  lines.push(`# Team Conversation · ${snap.teamName}`);
  lines.push('');
  const workerList = Object.keys(snap.workers)
    .sort()
    .map((n) => `${displayWorkerName(n, snap.workers[n].provider)}${
      snap.workers[n].provider !== 'unknown' && snap.workers[n].provider !== 'leader'
        ? ` _(${snap.workers[n].provider})_`
        : ''
    }`)
    .join(', ');
  lines.push(`- Workers: ${workerList || '(none yet)'}`);
  lines.push(`- Snapshot: ${new Date(snap.scannedAt).toISOString()}`);
  lines.push(`- Messages: ${snap.messages.length}`);
  lines.push(`- State root: \`${snap.root}\``);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (snap.messages.length === 0) {
    lines.push('_(no mailbox messages yet)_');
    lines.push('');
    return lines.join('\n');
  }

  for (const m of snap.messages) {
    const fromProvider = snap.workers[m.from_worker]?.provider ?? guessProvider(m.from_worker);
    const toProvider = snap.workers[m.to_worker]?.provider ?? guessProvider(m.to_worker);
    const from = displayWorkerName(m.from_worker, fromProvider);
    const to = displayWorkerName(m.to_worker, toProvider);
    lines.push(`## ${from} → ${to}`);
    lines.push('');
    const meta: string[] = [];
    meta.push(`created: ${m.created_at}`);
    if (m.notified_at) meta.push(`notified: ${m.notified_at}`);
    if (m.delivered_at) meta.push(`delivered: ${m.delivered_at}`);
    meta.push(`id: \`${m.message_id}\``);
    if (m.from_worker !== from || m.to_worker !== to) {
      meta.push(`omc: \`${m.from_worker}\` → \`${m.to_worker}\``);
    }
    lines.push(`_${meta.join(' · ')}_`);
    lines.push('');
    lines.push(m.body);
    lines.push('');
  }

  return lines.join('\n');
}

function displayWorkerName(name: string, provider: WorkerProvider): string {
  if (/^leader/i.test(name)) return 'leader';
  const match = name.match(/^worker-(\d+)$/i);
  if (match && (provider === 'claude' || provider === 'codex' || provider === 'gemini')) {
    return `${provider}-${match[1]}`;
  }
  return name;
}

function guessProvider(workerName: string): WorkerProvider {
  if (/^leader/i.test(workerName)) return 'leader';
  return 'unknown';
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
