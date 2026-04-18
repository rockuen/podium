import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { OMCRuntime, TeamSpec, TeamSlot, AgentModel, summarizeSlots, normalizeSlots, resolveOmcTeamShellHost } from '../core/OMCRuntime';
import { ensurePsmuxTmuxConf, isPsmuxServerRunning } from '../core/PsmuxSetup';
import { checkGeminiAutoApprove } from '../core/GeminiAutoApprove';
import { PodiumManager } from '../core/PodiumManager';
import { TerminalPanel } from './TerminalPanel';
import { HEX } from './colors';
import { buildSharedWebviewCss } from './webviewTheme';
import type { ProviderHealthChecker } from '../core/ProviderHealthChecker';
import type { ProviderHealth } from '../types/provider';

const VALID_MODELS: AgentModel[] = ['claude', 'codex', 'gemini'];

export class SpawnTeamPanel {
  static readonly viewType = 'podium.spawnTeam';
  private static current: SpawnTeamPanel | null = null;
  private spawning = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: OMCRuntime,
    private readonly manager: PodiumManager,
    private readonly output: vscode.OutputChannel,
    private readonly health: ProviderHealthChecker,
  ) {
    panel.webview.html = this.buildHtml();
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m));

    const onHealthUpdate = (h: ProviderHealth) => this.pushHealth(h);
    this.health.on('update', onHealthUpdate);
    // Immediate push with cached snapshot, then trigger a fresh probe.
    const cached = this.health.snapshot();
    if (cached) this.pushHealth(cached);
    void this.health.forceRefresh();

    panel.onDidDispose(() => {
      this.health.off('update', onHealthUpdate);
      if (SpawnTeamPanel.current === this) SpawnTeamPanel.current = null;
      this.output.appendLine('[podium.spawn] panel disposed');
    });
  }

  static show(
    context: vscode.ExtensionContext,
    runtime: OMCRuntime,
    manager: PodiumManager,
    output: vscode.OutputChannel,
    health: ProviderHealthChecker,
  ): SpawnTeamPanel {
    if (SpawnTeamPanel.current) {
      SpawnTeamPanel.current.panel.reveal(vscode.ViewColumn.Active, false);
      void health.forceRefresh();
      return SpawnTeamPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      SpawnTeamPanel.viewType,
      'Podium · Spawn Team',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'orchestration', 'webview')],
      },
    );
    const instance = new SpawnTeamPanel(panel, context, runtime, manager, output, health);
    SpawnTeamPanel.current = instance;
    return instance;
  }

  private pushHealth(health: ProviderHealth): void {
    this.panel.webview.postMessage({ type: 'health', health });
  }

  private async onMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; slots?: unknown; prompt?: unknown; mode?: unknown };

    if (m.type === 'cancel') {
      this.panel.dispose();
      return;
    }

    if (m.type === 'refresh-health') {
      this.output.appendLine('[podium.spawn] health refresh requested');
      void this.health.forceRefresh();
      return;
    }

    if (m.type !== 'submit') return;
    if (this.spawning) {
      this.output.appendLine('[podium.spawn] submit ignored (already spawning)');
      return;
    }

    const rawSlots = Array.isArray(m.slots) ? m.slots : [];
    const parsedSlots: TeamSlot[] = [];
    for (const raw of rawSlots) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as { model?: unknown; count?: unknown };
      const model = String(r.model ?? '') as AgentModel;
      if (!VALID_MODELS.includes(model)) continue;
      const count = Math.max(1, Math.min(10, Math.floor(Number(r.count ?? 1))));
      parsedSlots.push({ model, count });
    }
    const slots = normalizeSlots(parsedSlots);
    const prompt = String(m.prompt ?? '').trim();
    const mode = m.mode === 'in-session' ? 'in-session' : 'shell';

    if (slots.length === 0) {
      this.postStatus('error', 'pick at least one model slot');
      return;
    }
    const totalWorkers = slots.reduce((sum, s) => sum + s.count, 0);
    if (totalWorkers > 10) {
      this.postStatus('error', `total workers ${totalWorkers} exceeds limit (10)`);
      return;
    }
    if (!prompt) {
      this.postStatus('error', 'prompt is required');
      return;
    }

    const spec: TeamSpec = { slots, prompt };
    const cwd = currentCwd();
    const dispatchDelayMs = vscode.workspace
      .getConfiguration('podium')
      .get<number>('teamDispatchDelayMs', 1500);

    // Pre-flight: if a Gemini slot is in the spec but auto-approve config is
    // missing, surface a non-blocking warning so the user isn't confused when
    // the worker starts prompting for PowerShell execution.
    const hasGemini = slots.some((s) => s.model === 'gemini');
    if (hasGemini) {
      const check = checkGeminiAutoApprove(cwd);
      if (check.needed) {
        const bits: string[] = [];
        if (!check.folderTrustEnabled) bits.push('security.folderTrust.enabled=false');
        if (!check.workspaceTrusted) bits.push('workspace not in trustedFolders.json');
        this.output.appendLine(`[podium.spawn] gemini auto-approve WARN: ${bits.join('; ')}`);
        this.postStatus(
          'running',
          `⚠ Gemini auto-approve incomplete (${bits.join(', ')}). Run "Podium: Install Gemini Auto-Approve" — proceeding anyway.`,
        );
        // brief pause so user can read the banner
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    this.spawning = true;
    this.output.appendLine(
      `[podium.spawn] submit mode=${mode} ${JSON.stringify(spec)} cwd="${cwd}"`,
    );

    try {
      if (mode === 'shell') {
        await this.dispatchShell(spec, cwd);
      } else {
        await this.dispatchInSession(spec, cwd, dispatchDelayMs);
      }
      this.postStatus('success', `team dispatched · ${summarizeSlots(spec.slots)}`);
      // Auto-open Conversation Panel for shell-mode spawns. 3 workers + long
      // prompts can take 10–20s to produce state dir — retry a handful of
      // times before giving up.
      if (mode === 'shell') {
        const delays = [3500, 7000, 12000, 20000];
        for (const delay of delays) {
          setTimeout(() => {
            vscode.commands.executeCommand('podium.openLatestTeamConversation').then(
              undefined,
              (err) => this.output.appendLine(`[podium.spawn] auto-open convo failed: ${err}`),
            );
          }, delay);
        }
      }
      setTimeout(() => {
        try {
          this.panel.dispose();
        } catch {
          /* already disposed */
        }
      }, 800);
    } catch (err) {
      this.spawning = false;
      const emsg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[podium.spawn] FAILED: ${emsg}`);
      this.postStatus('error', emsg);
    }
  }

  private async dispatchInSession(spec: TeamSpec, cwd: string, dispatchDelayMs: number): Promise<void> {
    const title = `claude · ${summarizeSlots(spec.slots)}`;
    this.postStatus('running', `spawning claude in ${cwd}…`);
    await TerminalPanel.openClaude(this.context, this.runtime, this.manager, this.output, {
      title,
      cwd,
      teamSpec: spec,
      dispatchDelayMs,
    });
    this.output.appendLine('[podium.spawn] in-session terminal opened');
  }

  private async dispatchShell(spec: TeamSpec, cwd: string): Promise<void> {
    // Prepend a deterministic 48-char ASCII seed to the prompt. OMC slugifies
    // the first N chars of the task description to build the team name, which
    // must match /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/. User prompts that mix
    // Korean/punct/trailing words routinely produce invalid slugs (e.g.
    // "podium-v0-9-15-audit-3-worker-" with a trailing dash → OMC rejects).
    //
    // By prepending a known-good slug-shaped prefix that fills the slug
    // window, the generated team name becomes that prefix verbatim, regardless
    // of what the user's prompt contains.
    const slugSeed = buildSafeTeamSeed();
    const seededPrompt = `${slugSeed}. ${spec.prompt}`;

    // Route the prompt through a temp file rather than inline-escaping it on
    // the command line. Solves:
    //   1. bash's backtick / $ / ! expansion gotchas inside "..." contexts.
    //   2. VSCode terminal.sendText quirks with long + multi-line strings on
    //      Windows Git Bash (chunking / CRLF insertion that broke spawns
    //      before v0.9.18).
    const tmpPath = path.join(os.tmpdir(), `podium-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    try {
      fs.writeFileSync(tmpPath, seededPrompt, 'utf8');
    } catch (err) {
      throw new Error(`Failed to write prompt temp file: ${err instanceof Error ? err.message : err}`);
    }
    const bashPath = tmpPath.replace(/\\/g, '/');
    const slotStr = normalizeSlots(spec.slots).map((s) => `${s.count}:${s.model}`).join(',');
    const cmd = `omc team ${slotStr} "$(cat '${bashPath}')"`;
    this.output.appendLine(`[podium.spawn] slug seed: ${slugSeed}`);
    const bashOverride = vscode.workspace
      .getConfiguration('podium')
      .get<string>('bashPath', '') || undefined;
    const host = resolveOmcTeamShellHost(bashOverride);
    this.output.appendLine(`[podium.spawn] shell cmd: ${cmd}`);
    this.output.appendLine(`[podium.spawn] shell host: ${host.description}`);

    // Surface an invalid bash override as a one-shot warning so the user
    // knows their setting was ignored instead of silently falling back.
    if (host.description.startsWith('override-missing:')) {
      const missingPath = host.description.slice('override-missing:'.length);
      vscode.window.showWarningMessage(
        `Podium: podium.bashPath "${missingPath}" does not exist — auto-detect was used instead. Update the setting or clear it.`,
      );
    }

    // On Windows with a resolved bash, also make sure psmux pane default-shell
    // is bash so OMC's Unix-branch worker start command (env KEY=val bash -lc
    // ...) executes instead of being swallowed by cmd.exe.
    if (process.platform === 'win32' && host.shellPath) {
      try {
        const confResult = ensurePsmuxTmuxConf(host.shellPath);
        if (confResult.wrote) {
          this.output.appendLine(
            `[podium.spawn] wrote ${confResult.configPath}: default-shell=${host.shellPath}`,
          );
        } else if (confResult.alreadyOk) {
          this.output.appendLine(`[podium.spawn] ${confResult.configPath} default-shell already ok`);
        } else if (confResult.conflict) {
          this.output.appendLine(
            `[podium.spawn] ${confResult.configPath} has conflicting default-shell: ${confResult.conflict} — leaving it alone`,
          );
          vscode.window.showWarningMessage(
            `Podium: ${confResult.configPath} sets default-shell to "${confResult.conflict}". Edit it to "${host.shellPath}" for OMC worker init to work on Windows.`,
          );
        }
        if (confResult.wrote) {
          const running = await isPsmuxServerRunning();
          if (running) {
            this.output.appendLine(
              '[podium.spawn] WARN: psmux server already running — config change applies to NEW sessions only. Run "psmux kill-server" (no active teams) to force reload.',
            );
          }
        }
      } catch (err) {
        this.output.appendLine(
          `[podium.spawn] psmux conf setup failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (process.platform === 'win32' && !host.shellPath) {
      this.postStatus(
        'running',
        'no MSYS2 bash found — falling back to default shell (Windows cmd escaping may break omc worker init)',
      );
    } else if (host.shellPath) {
      this.postStatus('running', `launching tmux session via ${path.basename(host.shellPath)} (MSYSTEM=MINGW64)…`);
    } else {
      this.postStatus('running', 'launching tmux session via omc team…');
    }

    const termOptions: vscode.TerminalOptions = {
      name: `Podium · omc team · ${summarizeSlots(spec.slots)}`,
      cwd,
      env: host.env,
    };
    if (host.shellPath) {
      termOptions.shellPath = host.shellPath;
      termOptions.shellArgs = host.shellArgs;
    }
    const term = vscode.window.createTerminal(termOptions);
    term.show(true);
    term.sendText(cmd, true);
  }

  private postStatus(level: 'running' | 'success' | 'error', text: string): void {
    this.panel.webview.postMessage({ type: 'status', level, text });
  }

  private buildHtml(): string {
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'orchestration', 'webview', 'spawn-team.js'),
    );
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Podium · Spawn Team</title>
<style>
${buildSharedWebviewCss()}
  html, body { background: var(--bg-backdrop); overflow: auto; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 40px 20px; }

  .modal { width: 100%; max-width: 620px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); display: flex; flex-direction: column; overflow: hidden; }

  .m-head { display: flex; align-items: center; gap: 10px; padding: 18px 20px 16px; border-bottom: 1px solid var(--border); }
  .m-head .icon { color: var(--accent-omc); font-size: 18px; line-height: 1; }
  .m-head .title { display: flex; flex-direction: column; gap: 2px; }
  .m-head .title .name { font-size: 16px; font-weight: 700; }
  .m-head .title .sub { font-size: 11px; color: var(--text-disabled); font-family: Consolas, "Cascadia Code", monospace; }
  .m-head .spacer { flex: 1 1 auto; }
  .m-head .close { cursor: pointer; color: var(--text-secondary); font-size: 18px; padding: 4px 8px; border-radius: 3px; user-select: none; }
  .m-head .close:hover { color: var(--text-primary); background: var(--bg-input); }

  .m-body { display: flex; flex-direction: column; gap: 18px; padding: 20px; }

  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 12px; font-weight: 600; color: var(--text-primary); display: inline-flex; align-items: center; gap: 6px; }
  .field label .hint { font-size: 10px; color: var(--text-disabled); font-weight: 400; }

  .count-row { display: flex; align-items: center; gap: 10px; }
  .count-row input { width: 72px; height: 36px; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border); border-radius: 4px; padding: 0 10px; font-size: 13px; font-family: Consolas, monospace; }
  .count-row input:focus { outline: none; border-color: var(--accent-omc); }
  .count-row .label { color: var(--text-secondary); font-size: 12px; }

  .chips { display: flex; gap: 10px; flex-wrap: wrap; }
  .chip { display: inline-flex; align-items: center; gap: 8px; padding: 0 6px 0 12px; height: 36px; border-radius: 18px; background: var(--bg-input); border: 1px solid var(--border); cursor: pointer; user-select: none; transition: all 0.15s; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
  .chip:hover { border-color: var(--border-focus); color: var(--text-primary); }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.6; }
  .chip[data-model="claude"] { --chip-accent: var(--accent-claude); }
  .chip[data-model="codex"] { --chip-accent: var(--accent-codex); }
  .chip[data-model="gemini"] { --chip-accent: var(--accent-gemini); }
  .chip.selected { background: color-mix(in srgb, var(--chip-accent) 15%, transparent); border-color: var(--chip-accent); color: var(--chip-accent); }
  .chip.selected .dot { opacity: 1; }
  .chip .stepper { display: none; align-items: center; gap: 2px; margin-left: 2px; padding-left: 8px; border-left: 1px solid color-mix(in srgb, var(--chip-accent, var(--border)) 40%, transparent); }
  .chip.selected .stepper { display: inline-flex; }
  .chip .stepper button { width: 20px; height: 20px; border-radius: 3px; border: none; background: color-mix(in srgb, var(--chip-accent) 20%, transparent); color: var(--chip-accent); cursor: pointer; font-size: 14px; line-height: 1; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
  .chip .stepper button:hover { background: color-mix(in srgb, var(--chip-accent) 35%, transparent); }
  .chip .stepper .val { min-width: 16px; text-align: center; font-family: Consolas, monospace; font-size: 12px; font-weight: 700; color: var(--chip-accent); }
  .chip-hint { font-size: 10px; color: var(--text-disabled); margin-top: 4px; }
  .chip.unavailable { opacity: 0.42; cursor: not-allowed; pointer-events: none; }
  .chip.unavailable.selected { background: var(--bg-input); border-color: var(--border); color: var(--text-disabled); }
  .chip .health-dot { width: 6px; height: 6px; border-radius: 50%; margin-left: -2px; flex: 0 0 auto; }
  .chip .health-dot.ok { background: var(--status-success); box-shadow: 0 0 4px color-mix(in srgb, var(--status-success) 60%, transparent); }
  .chip .health-dot.missing { background: var(--status-error); }
  .chip .health-dot.unknown { background: var(--text-disabled); }

  .health-strip { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 6px 10px; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 4px; font-size: 11px; color: var(--text-secondary); }
  .health-strip .label { color: var(--text-disabled); }
  .health-strip .state { flex: 1 1 auto; font-family: Consolas, monospace; }
  .health-strip .state.ok { color: var(--status-success); }
  .health-strip .state.warn { color: var(--status-running); }
  .health-strip .state.error { color: var(--status-error); }
  .health-strip .refresh { cursor: pointer; color: var(--text-disabled); padding: 2px 6px; border-radius: 3px; user-select: none; font-size: 11px; }
  .health-strip .refresh:hover { color: var(--text-primary); background: var(--bg-input); }
  .health-strip .refresh.spin { animation: hs-spin 0.8s linear infinite; }
  @keyframes hs-spin { to { transform: rotate(360deg); } }

  .mode-toggle { display: inline-flex; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; padding: 2px; gap: 2px; }
  .mode-toggle .mbtn { padding: 0 12px; height: 28px; display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; font-size: 11px; font-weight: 600; color: var(--text-secondary); border-radius: 3px; }
  .mode-toggle .mbtn:hover { color: var(--text-primary); }
  .mode-toggle .mbtn.active { background: var(--accent-omc); color: var(--text-inverse); }
  .mode-toggle .mbtn .badge { font-size: 9px; font-family: Consolas, monospace; padding: 0 4px; border-radius: 2px; background: rgba(0,0,0,0.18); }
  .mode-toggle .mbtn:not(.active) .badge { background: var(--bg-card); color: var(--text-disabled); }
  .mode-hint { font-size: 10px; color: var(--text-disabled); margin-top: 4px; }

  .prompt-box { background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; padding: 0; }
  .prompt-box:focus-within { border-color: var(--accent-omc); }
  .prompt-box textarea { width: 100%; min-height: 120px; resize: vertical; background: transparent; border: none; padding: 10px 12px; color: var(--text-primary); font-family: Consolas, "Cascadia Code", monospace; font-size: 12px; line-height: 1.5; outline: none; }

  .cli-preview { display: flex; align-items: center; gap: 8px; padding: 10px 20px; background: var(--bg-panel); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .cli-preview .term-icon { color: var(--text-disabled); font-size: 12px; }
  .cli-preview .cmd { flex: 1 1 auto; color: var(--text-secondary); font-family: Consolas, "Cascadia Code", monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cli-preview .copy { cursor: pointer; color: var(--text-disabled); font-size: 12px; padding: 2px 6px; border-radius: 3px; user-select: none; }
  .cli-preview .copy:hover { color: var(--text-primary); background: var(--bg-input); }

  .status-banner { margin: 0 20px; padding: 10px 12px; border-radius: 4px; font-size: 12px; display: none; align-items: center; gap: 8px; }
  .status-banner.show { display: flex; }
  .status-banner.running { background: color-mix(in srgb, var(--status-running) 12%, transparent); color: var(--status-running); border: 1px solid color-mix(in srgb, var(--status-running) 30%, transparent); }
  .status-banner.success { background: color-mix(in srgb, var(--status-success) 12%, transparent); color: var(--status-success); border: 1px solid color-mix(in srgb, var(--status-success) 30%, transparent); }
  .status-banner.error { background: color-mix(in srgb, var(--status-error) 12%, transparent); color: var(--status-error); border: 1px solid color-mix(in srgb, var(--status-error) 30%, transparent); }
  .status-banner .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .m-foot { display: flex; align-items: center; gap: 8px; padding: 14px 20px 16px; border-top: 1px solid var(--border); }
  .m-foot .hint { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-disabled); }
  .m-foot .hint .kbd { padding: 0 6px; height: 20px; line-height: 20px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 3px; font-family: Consolas, monospace; font-size: 10px; }
  .m-foot .spacer { flex: 1 1 auto; }
  .m-foot button { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 16px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; border: 1px solid transparent; user-select: none; }
  .m-foot .cancel-btn { background: var(--bg-card); color: var(--text-primary); border-color: var(--border); }
  .m-foot .cancel-btn:hover { border-color: var(--border-focus); }
  .m-foot .spawn-btn { background: var(--bg-button); color: var(--text-inverse); padding: 0 14px 0 14px; }
  .m-foot .spawn-btn:hover { background: var(--bg-button-hover); }
  .m-foot .spawn-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .m-foot .spawn-btn .badge { display: inline-flex; align-items: center; padding: 0 6px; height: 18px; border-radius: 9px; background: rgba(255, 255, 255, 0.2); font-size: 10px; font-family: Consolas, monospace; }
</style>
</head>
<body>
  <div class="modal">
    <div class="m-head">
      <span class="icon">◆</span>
      <div class="title">
        <div class="name">Spawn OMC Team</div>
        <div class="sub">/team N:model "prompt"</div>
      </div>
      <div class="spacer"></div>
      <div class="close" id="podium-close">×</div>
    </div>

    <div class="m-body">
      <div class="field">
        <label>Dispatch mode</label>
        <div class="mode-toggle" id="mode-toggle">
          <div class="mbtn active" data-mode="shell"><span>Shell</span><span class="badge">omc team</span></div>
          <div class="mbtn" data-mode="in-session"><span>In-session</span><span class="badge">/team</span></div>
        </div>
        <div class="mode-hint" id="mode-hint">Shell: opens a terminal and runs <code>omc team …</code> → tmux session + Sessions tree.</div>
      </div>

      <div class="field">
        <label>Models <span class="hint">· tap to add, use −/+ for count</span></label>
        <div class="chips" id="chips">
          <div class="chip selected" data-model="claude">
            <span class="dot"></span><span>Claude</span>
            <span class="health-dot unknown" id="health-dot-claude"></span>
            <span class="stepper"><button type="button" data-step="-1">−</button><span class="val">2</span><button type="button" data-step="1">+</button></span>
          </div>
          <div class="chip" data-model="codex">
            <span class="dot"></span><span>Codex</span>
            <span class="health-dot unknown" id="health-dot-codex"></span>
            <span class="stepper"><button type="button" data-step="-1">−</button><span class="val">1</span><button type="button" data-step="1">+</button></span>
          </div>
          <div class="chip" data-model="gemini">
            <span class="dot"></span><span>Gemini</span>
            <span class="health-dot unknown" id="health-dot-gemini"></span>
            <span class="stepper"><button type="button" data-step="-1">−</button><span class="val">1</span><button type="button" data-step="1">+</button></span>
          </div>
        </div>
        <div class="chip-hint">Pick one or mix — e.g. Claude ×2 + Gemini ×1 spawns 3 workers in one team.</div>
        <div class="health-strip">
          <span class="label">health:</span>
          <span class="state" id="health-state">checking…</span>
          <span class="refresh" id="health-refresh" title="Re-run omc doctor --team-routing">↻</span>
        </div>
      </div>

      <div class="field">
        <label>Prompt</label>
        <div class="prompt-box">
          <textarea id="prompt" placeholder="e.g., review the auth module — security focus, surface top 3 issues"></textarea>
        </div>
      </div>
    </div>

    <div class="cli-preview">
      <span class="term-icon">▸</span>
      <span class="cmd" id="cli">/team 2:claude "…"</span>
      <span class="copy" id="copy-cli" title="Copy command">⧉</span>
    </div>

    <div class="status-banner" id="status"></div>

    <div class="m-foot">
      <div class="hint"><span class="kbd">Esc</span><span>to cancel</span><span style="margin-left: 12px;">·</span><span class="kbd">⌘/Ctrl+↵</span><span>to spawn</span></div>
      <div class="spacer"></div>
      <button class="cancel-btn" id="podium-cancel">Cancel</button>
      <button class="spawn-btn" id="podium-spawn"><span>▶</span><span>Spawn Team</span><span class="badge" id="spawn-count">×2</span></button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function buildSafeTeamSeed(): string {
  // Template designed to satisfy OMC's team-name regex for ANY user prompt:
  //   /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/
  // 48 ascii chars ending in alphanumeric. Uniqueness from timestamp + random.
  const base = 'podium-team-manual-spawn';
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 12);
  const combined = `${base}-${ts}${rand}`;
  const cleaned = combined
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return cleaned.length >= 2 ? cleaned : `podium-team-${ts}`;
}

function currentCwd(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  return process.cwd();
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
