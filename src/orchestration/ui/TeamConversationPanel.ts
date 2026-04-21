import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { TeamConversationWatcher } from '../core/TeamConversationWatcher';
import {
  readTeamDisplay,
  updateTeamDisplay,
  writeTeamDisplay,
  type TeamDisplay,
} from '../core/TeamDisplayStore';
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
      if (m.type === 'rename') {
        await this.promptRename();
        return;
      }
      if (m.type === 'leader-inject') {
        const mm = msg as { text?: string };
        const text = typeof mm.text === 'string' ? mm.text : '';
        await this.handleLeaderInject(text);
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
    const initialDisplay = readTeamDisplay(root, teamName);
    const label = initialDisplay?.displayName?.trim() || teamName;
    const panel = vscode.window.createWebviewPanel(
      TeamConversationPanel.viewType,
      label,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'orchestration', 'webview')],
      },
    );
    panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    const watcher = new TeamConversationWatcher((msg) => output.appendLine(msg));
    watcher.start(root, teamName);
    const instance = new TeamConversationPanel(panel, context, watcher, output, teamName, root);
    TeamConversationPanel.instances.set(teamName, instance);
    panel.webview.html = instance.buildHtml();
    return instance;
  }

  static renameTeam(context: vscode.ExtensionContext, output: vscode.OutputChannel, root: string, teamName: string): Thenable<void> {
    const existing = TeamConversationPanel.instances.get(teamName);
    if (existing) {
      return Promise.resolve(existing.promptRename());
    }
    return Promise.resolve().then(async () => {
      const current = readTeamDisplay(root, teamName);
      const seed = current?.displayName ?? teamName;
      const next = await vscode.window.showInputBox({
        value: seed,
        prompt: 'Rename team display label',
        placeHolder: 'Short label shown in the Conversation tab',
      });
      if (next === undefined) return;
      const trimmed = next.trim();
      if (!trimmed) return;
      try {
        if (current) {
          updateTeamDisplay(root, teamName, { displayName: trimmed, renamedAt: Date.now() });
        } else {
          writeTeamDisplay(root, teamName, {
            displayName: trimmed,
            initialPrompt: '',
            createdAt: Date.now(),
            renamedAt: Date.now(),
          });
        }
        output.appendLine(`[podium.convo] renamed "${teamName}" -> "${trimmed}"`);
      } catch (err) {
        const emsg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[podium.convo] rename failed: ${emsg}`);
        vscode.window.showErrorMessage(`Podium: rename failed — ${emsg}`);
      }
    });
  }

  private async promptRename(): Promise<void> {
    const current = readTeamDisplay(this.root, this.teamName);
    const seed = current?.displayName ?? this.panel.title;
    const next = await vscode.window.showInputBox({
      value: seed,
      prompt: 'Rename team display label',
      placeHolder: 'Short label shown in the Conversation tab',
    });
    if (next === undefined) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    try {
      let nextDisplay: TeamDisplay | null = null;
      if (current) {
        nextDisplay = updateTeamDisplay(this.root, this.teamName, {
          displayName: trimmed,
          renamedAt: Date.now(),
        });
      } else {
        nextDisplay = {
          displayName: trimmed,
          initialPrompt: '',
          createdAt: Date.now(),
          renamedAt: Date.now(),
        };
        writeTeamDisplay(this.root, this.teamName, nextDisplay);
      }
      this.panel.title = trimmed;
      this.output.appendLine(`[podium.convo] renamed "${this.teamName}" -> "${trimmed}"`);
      // The FileSystemWatcher in TeamConversationWatcher will reload the
      // sidecar and push a refreshed snapshot; force a scan now so the webview
      // header updates even if the fs event is slow on Windows.
      this.watcher.forceRefresh();
    } catch (err) {
      const emsg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[podium.convo] rename failed: ${emsg}`);
      vscode.window.showErrorMessage(`Podium: rename failed — ${emsg}`);
    }
  }

  private push(snap: ConversationSnapshot): void {
    const label = snap.displayName?.trim() || snap.teamName;
    if (this.panel.title !== label) this.panel.title = label;
    this.panel.webview.postMessage({ type: 'snapshot', snapshot: snap });
  }

  /**
   * Send a message from the user to the team's leader pane via tmux send-keys.
   * Reads tmux_session + leader_pane_id from config.json. Falls back to
   * writing a mailbox entry if tmux targeting fails so the message still
   * appears in the conversation feed.
   */
  private async handleLeaderInject(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text) return;

    const teamDir = path.join(this.root, '.omc', 'state', 'team', this.teamName);
    const configPath = path.join(teamDir, 'config.json');
    if (!fs.existsSync(configPath)) {
      this.panel.webview.postMessage({
        type: 'leader-inject-result',
        ok: false,
        error: 'Team not ready yet — config.json missing.',
      });
      vscode.window.showErrorMessage('Podium: team config.json not found — is the team still alive?');
      return;
    }

    let tmuxSession = '';
    let leaderPaneId = '';
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        tmux_session?: string;
        leader_pane_id?: string;
      };
      tmuxSession = String(cfg.tmux_session ?? '').trim();
      leaderPaneId = String(cfg.leader_pane_id ?? '').trim();
    } catch (err) {
      this.output.appendLine(`[podium.inject] read config.json failed: ${err instanceof Error ? err.message : err}`);
    }

    if (!tmuxSession) {
      this.panel.webview.postMessage({
        type: 'leader-inject-result',
        ok: false,
        error: 'No tmux_session in config.json.',
      });
      vscode.window.showErrorMessage('Podium: cannot reach leader — team tmux session is not recorded.');
      return;
    }

    const muxBin = process.platform === 'win32' ? 'psmux' : 'tmux';
    // Target the leader pane directly when we have its pane_id; otherwise
    // target the first pane of the session:window (":0"). Both resolve under
    // tmux's targeting grammar.
    const target = leaderPaneId || tmuxSession;

    try {
      // v2.6.24: join lines with Win32-input-mode Shift+Enter KEY_EVENT ANSI
      // sequence (down + up). Claude readline sees a real Shift+Enter key
      // event and keeps newline-in-buffer. Final bare Enter submits.
      // Replaces v2.6.23's raw LF approach — Claude readline treated raw LF
      // bytes as submit (same as CR), dropping everything after the first
      // line. See pty/autoSend.js for the full spec reference.
      const SHIFT_ENTER_KEY_EVENT =
        '\x1b[13;28;10;1;16;1_' + '\x1b[13;28;10;0;16;1_';
      const payload = text.split(/\r?\n/).join(SHIFT_ENTER_KEY_EVENT);
      await execFilePromise(muxBin, ['send-keys', '-l', '-t', target, payload]);
      await execFilePromise(muxBin, ['send-keys', '-t', target, 'Enter']);
      this.output.appendLine(`[podium.inject] sent (${text.length} chars) → ${target}`);
      this.panel.webview.postMessage({ type: 'leader-inject-result', ok: true });
      // Also drop a mailbox entry so the message shows up in the conversation
      // feed alongside real worker↔leader traffic.
      this.appendUserMailboxEntry(teamDir, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[podium.inject] send-keys FAILED: ${msg}`);
      // Fallback: still drop a mailbox entry even when send-keys fails, so
      // the user's message is at least captured and visible in the panel.
      this.appendUserMailboxEntry(teamDir, text);
      this.panel.webview.postMessage({
        type: 'leader-inject-result',
        ok: false,
        error: `send-keys failed: ${msg.slice(0, 120)}`,
      });
      vscode.window.showErrorMessage(`Podium: leader inject failed — ${msg.slice(0, 200)}`);
    }
  }

  private appendUserMailboxEntry(teamDir: string, body: string): void {
    const mailboxDir = path.join(teamDir, 'mailbox');
    try {
      if (!fs.existsSync(mailboxDir)) fs.mkdirSync(mailboxDir, { recursive: true });
      const filePath = path.join(mailboxDir, 'user-inject.json');
      let existing: { messages: unknown[] } = { messages: [] };
      if (fs.existsSync(filePath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { messages?: unknown[] };
          if (Array.isArray(raw.messages)) existing = { messages: raw.messages };
        } catch {
          /* corrupt file — start fresh */
        }
      }
      const msg = {
        message_id: randomUUID(),
        from_worker: 'user',
        to_worker: 'leader-fixed',
        body,
        created_at: new Date().toISOString(),
        notified_at: null,
      };
      existing.messages.push(msg);
      // Atomic write — same pattern as the rest of the codebase.
      const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(existing, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
      this.watcher.forceRefresh();
    } catch (err) {
      this.output.appendLine(
        `[podium.inject] mailbox append failed (non-fatal): ${err instanceof Error ? err.message : err}`,
      );
    }
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

    const initialDisplay = readTeamDisplay(this.root, this.teamName);
    const initialLabel = initialDisplay?.displayName?.trim() || this.teamName;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(initialLabel)}</title>
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

  /* Chat alignment: leader (and source-initial) on the left, workers on the right. */
  .msg { display: flex; flex-direction: column; gap: 6px; max-width: min(720px, 90%); }
  .msg.from-leader { align-self: flex-start; align-items: flex-start; }
  .msg.from-worker { align-self: flex-end; align-items: flex-end; }
  .msg .meta { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--text-disabled); font-family: Consolas, monospace; }
  /* Mirror meta order so timestamp hugs the outer edge of the bubble. */
  .msg.from-leader .meta { flex-direction: row; }
  .msg.from-worker .meta { flex-direction: row-reverse; }
  .msg.from-worker .meta .time { margin-left: 0; margin-right: auto; }
  .msg .who { font-weight: 700; }
  .msg .arrow { color: var(--text-disabled); }
  .msg .target { color: var(--text-secondary); }
  .msg .time { margin-left: auto; cursor: help; }
  .msg .bubble { position: relative; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg-card)); line-height: 1.55; font-size: 13px; word-wrap: break-word; white-space: pre-wrap; color: var(--text-primary); }
  .msg .bubble::before { content: ''; position: absolute; top: 12px; width: 3px; height: 20px; background: var(--worker-accent, var(--accent)); border-radius: 2px; }
  .msg.from-leader .bubble { border-top-left-radius: 2px; border-left: 3px solid var(--worker-accent, var(--accent)); background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel)); }
  .msg.from-leader .bubble::before { left: -6px; }
  .msg.from-worker .bubble { border-top-right-radius: 2px; border-left: 3px solid var(--worker-accent, var(--accent)); }
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

  .msg.source-initial { align-self: stretch; max-width: 100%; }
  .msg.source-initial .bubble { border-style: dashed; background: color-mix(in srgb, var(--text-disabled) 6%, var(--bg-panel)); }
  .msg.source-initial .initial-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--text-secondary); font-family: Consolas, monospace; letter-spacing: 0.02em; }

  /* v2.6.12: user→leader inject. Distinct accent so it does not get confused
     with leader or worker messages in the feed. */
  .msg.provider-user { --accent: var(--accent-omc); }
  .msg.from-user { align-self: flex-start; align-items: flex-start; }
  .msg.from-user .meta { flex-direction: row; }
  .msg.from-user .bubble { border-top-left-radius: 2px; border-left: 3px solid var(--accent-omc); background: color-mix(in srgb, var(--accent-omc) 12%, var(--bg-panel)); }
  .msg.from-user .bubble::before { left: -6px; }

  #composer { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 8px; padding: 10px 16px 14px; border-top: 1px solid var(--border); background: var(--bg-panel); }
  #composer .stack { flex: 1 1 auto; display: flex; flex-direction: column; gap: 4px; }
  #composer textarea { width: 100%; resize: none; min-height: 36px; max-height: 140px; padding: 8px 10px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); font-family: Consolas, "Cascadia Code", monospace; font-size: 12px; line-height: 1.5; outline: none; }
  #composer textarea:focus { border-color: var(--accent-omc); }
  #composer .hint { font-size: 10px; color: var(--text-disabled); min-height: 12px; }
  #composer .hint.err { color: var(--status-error); }
  #composer .hint.ok { color: var(--status-success); }
  #composer button { flex: 0 0 auto; height: 36px; padding: 0 16px; border-radius: 4px; border: none; background: var(--bg-button); color: var(--text-inverse); cursor: pointer; font-size: 12px; font-weight: 600; }
  #composer button:hover { background: var(--bg-button-hover); }
  #composer button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>
<div id="header">
  <div class="title-row">
    <div class="name" id="display-name">${escapeHtml(initialLabel)}</div>
    <div class="sub" id="display-sub">${escapeHtml(this.teamName)}</div>
  </div>
  <div class="workers" id="workers"></div>
  <div class="spacer"></div>
  <div class="count" id="count">0 messages</div>
  <div class="refresh" id="rename" title="Rename this conversation">✎</div>
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
<div id="composer">
  <div class="stack">
    <textarea id="leader-inject" placeholder="Message to leader… (Enter to send · Shift+Enter for newline)" rows="1"></textarea>
    <div class="hint" id="leader-inject-hint">Inject via tmux send-keys into the team's leader pane.</div>
  </div>
  <button id="leader-send">Send</button>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function buildMarkdownTranscript(snap: ConversationSnapshot | null): string {
  if (!snap) return '# Team Conversation\n\n(no snapshot available)\n';
  const lines: string[] = [];
  const title = snap.displayName?.trim() || snap.teamName;
  lines.push(`# ${title}`);
  if (snap.displayName && snap.displayName.trim() && snap.displayName.trim() !== snap.teamName) {
    lines.push(`*team: ${snap.teamName}*`);
  }
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
  if (snap.initialPrompt && snap.initialPrompt.trim()) {
    lines.push('## 📝 Initial Prompt');
    lines.push('');
    lines.push(snap.initialPrompt);
    lines.push('');
  }
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

function execFilePromise(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(msg));
        return;
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}
