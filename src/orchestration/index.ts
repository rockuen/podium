// src/orchestration/index.ts
//
// M2.F — Full orchestration activation ported from Podium extension.ts.
//
// Mapping:
//   podium.*                 -> claudeCodeLauncher.*
//   podium.<xxx>             (config)   -> claudeCodeLauncher.orchestration.<xxx>
//   podium.sessionTree       (view)     -> claudeCodeLauncher.teamsOrchestration
//   podium.hudPanel          (view)     -> claudeCodeLauncher.hudPanel
//   podium.missionsPanel     (view)     -> claudeCodeLauncher.missionsPanel
//   podium.historyPanel      (view)     -> claudeCodeLauncher.historyPanel
//   CCG                                 -> deferred to M3 (CcgTreeProvider /
//                                          CcgArtifactWatcher / CcgViewerPanel
//                                          are NOT imported here)
//   podium.* command shim                -> registered only if rockuen.podium is
//                                          NOT installed (avoid duplicate
//                                          registerCommand errors)

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

import { OMCRuntime, summarizeSlots, type TeamSpec, type AgentModel } from './core/OMCRuntime';
import { SessionDetector } from './core/SessionDetector';
import { PodiumManager } from './core/PodiumManager';
import { ProviderHealthChecker } from './core/ProviderHealthChecker';
import { StateWatcher } from './core/StateWatcher';
import { MissionWatcher } from './core/MissionWatcher';
import { SessionHistoryWatcher } from './core/SessionHistoryWatcher';
import { HookReceiver } from './core/HookReceiver';
import { TokenStore } from './core/TokenStore';
import {
  isPodiumGatewayRegistered,
  openclawConfigPath,
  registerPodiumAsGateway,
} from './core/OpenclawRegistrar';
import { ensureTeamWorkerPermissions } from './core/PermissionsSetup';
import { installGeminiAutoApprove } from './core/GeminiAutoApprove';

import type { IMultiplexerBackend } from './backends/IMultiplexerBackend';
import { TmuxBackend } from './backends/TmuxBackend';
import { PsmuxBackend } from './backends/PsmuxBackend';

import { SessionNode, SessionTreeProvider as TeamsTreeProvider } from './ui/TeamsTreeProvider';
import { TerminalPanel } from './ui/TerminalPanel';
import { SpawnTeamPanel } from './ui/SpawnTeamPanel';
import { MultiPaneTerminalPanel } from './ui/MultiPaneTerminalPanel';
import { HUDStatusBarItem } from './ui/HUDStatusBarItem';
import { HUDTreeProvider } from './ui/HUDTreeProvider';
import { HUDDashboardPanel } from './ui/HUDDashboardPanel';
import { MissionsTreeProvider } from './ui/MissionsTreeProvider';
import { SessionHistoryProvider } from './ui/SessionHistoryProvider';
import { TeamConversationPanel } from './ui/TeamConversationPanel';

import type { MissionSnapshot } from './core/MissionWatcher';
import type { SessionHistorySnapshot } from './types/history';
import type { HUDStdinCache } from './types/hud';
import type { OMCOpenClawPayload } from './types/events';

export interface OrchestrationAPI {
  dispose(): void;
}

const CFG_NS = 'claudeCodeLauncher.orchestration';

export async function activate(ctx: vscode.ExtensionContext): Promise<OrchestrationAPI> {
  const output = vscode.window.createOutputChannel('Claude Launcher - Orchestration');
  ctx.subscriptions.push(output);
  output.appendLine('[orch] activating...');

  const config = vscode.workspace.getConfiguration(CFG_NS);
  const prefix = config.get<string>('sessionPrefix', 'omc-team-');
  const claudeOverride = config.get<string>('claudeCommand', '') || undefined;

  const backend = await resolveBackend(config.get<string>('backend', 'auto'), output);
  const detector = new SessionDetector(backend, prefix);
  const initialFilter = config.get<string>('sessionFilter', '') || '';
  if (initialFilter) detector.setNameFilter(initialFilter);

  const runtime = new OMCRuntime(claudeOverride);
  const manager = new PodiumManager();
  ctx.subscriptions.push(manager);

  const providerHealth = new ProviderHealthChecker((msg) => output.appendLine(msg));
  providerHealth.setCwd(currentCwd());
  providerHealth.start();
  ctx.subscriptions.push({ dispose: () => providerHealth.stop() });

  // ─── Teams tree ───
  const teamsProvider = new TeamsTreeProvider(detector);
  const teamsView = vscode.window.createTreeView('claudeCodeLauncher.teamsOrchestration', {
    treeDataProvider: teamsProvider,
    showCollapseAll: true,
  });
  ctx.subscriptions.push(teamsView);

  const pollingMs = Math.max(1000, config.get<number>('pollingIntervalMs', 5000));
  const pollTimer = setInterval(() => teamsProvider.refresh(), pollingMs);
  ctx.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  // ─── HUD ───
  const hudProvider = new HUDTreeProvider();
  const hudView = vscode.window.createTreeView('claudeCodeLauncher.hudPanel', {
    treeDataProvider: hudProvider,
  });
  ctx.subscriptions.push(hudView);
  const hudStatus = new HUDStatusBarItem();
  ctx.subscriptions.push(hudStatus);

  const stateWatcher = new StateWatcher((msg) => output.appendLine(msg));
  stateWatcher.on('hud', (hud: HUDStdinCache | null) => {
    hudStatus.update(hud);
    hudProvider.update(hud);
    HUDDashboardPanel.broadcast({ hud });
  });
  ctx.subscriptions.push({ dispose: () => stateWatcher.stop() });
  const initialRoot = currentCwd();
  stateWatcher.start(initialRoot);

  // ─── Missions ───
  const missionProvider = new MissionsTreeProvider();
  const missionView = vscode.window.createTreeView('claudeCodeLauncher.missionsPanel', {
    treeDataProvider: missionProvider,
  });
  ctx.subscriptions.push(missionView);
  const missionWatcher = new MissionWatcher((msg) => output.appendLine(msg));
  missionWatcher.on('snapshot', (snap: MissionSnapshot) => {
    missionProvider.update(snap);
  });
  ctx.subscriptions.push({ dispose: () => missionWatcher.stop() });
  missionWatcher.start(initialRoot);

  // ─── Session History ───
  const historyProvider = new SessionHistoryProvider();
  const historyView = vscode.window.createTreeView('claudeCodeLauncher.historyPanel', {
    treeDataProvider: historyProvider,
  });
  ctx.subscriptions.push(historyView);
  const historyWatcher = new SessionHistoryWatcher((msg) => output.appendLine(msg));
  historyWatcher.on('snapshot', (snap: SessionHistorySnapshot) => {
    historyProvider.update(snap);
    HUDDashboardPanel.broadcast({ history: snap });
  });
  ctx.subscriptions.push({ dispose: () => historyWatcher.stop() });
  historyWatcher.start(initialRoot);

  // ─── Hook Receiver (OpenClaw gateway) ───
  const tokenStore = new TokenStore(ctx.secrets);
  let receiver: HookReceiver | null = null;
  const receiverEnabled = config.get<boolean>('hookReceiver.enabled', true);
  const receiverPort = Math.max(1024, config.get<number>('hookReceiver.port', 49531));
  if (receiverEnabled) {
    try {
      const token = await tokenStore.getOrCreate();
      receiver = new HookReceiver({
        port: receiverPort,
        getToken: () => token,
        logger: (msg) => output.appendLine(msg),
      });
      receiver.on('hook', (payload: OMCOpenClawPayload) => {
        output.appendLine(
          `[orch.hook] event="${payload.event}" phase="${payload.signal?.phase ?? '-'}"`,
        );
        teamsProvider.refresh();
      });
      await receiver.start();
      output.appendLine(`[orch] hook receiver ready at ${receiver.url}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`[orch] hook receiver failed: ${msg}`);
      receiver = null;
    }
  } else {
    output.appendLine('[orch] hook receiver disabled');
  }
  ctx.subscriptions.push({ dispose: () => void receiver?.stop() });

  // ─── Podium Mode enter/exit ───
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.podium.enter', async () => {
      await vscode.commands.executeCommand(
        'setContext',
        'claudeCodeLauncher.podiumModeActive',
        true,
      );
      try {
        const sessions = await detector.detect();
        await vscode.commands.executeCommand(
          'setContext',
          'claudeCodeLauncher.hasAnyTeam',
          sessions.length > 0,
        );
        output.appendLine(`[orch] podium mode ENTER (${sessions.length} team(s) detected)`);
        vscode.window.showInformationMessage(
          sessions.length > 0
            ? `Podium Mode activated — ${sessions.length} team(s) detected.`
            : 'Podium Mode activated — no teams found yet.',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[orch] detect error: ${msg}`);
        vscode.window.showWarningMessage(
          'Podium Mode activated but backend unavailable. Install tmux or psmux.',
        );
      }
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.podium.exit', async () => {
      await vscode.commands.executeCommand(
        'setContext',
        'claudeCodeLauncher.podiumModeActive',
        false,
      );
      await vscode.commands.executeCommand(
        'setContext',
        'claudeCodeLauncher.hasAnyTeam',
        false,
      );
      output.appendLine('[orch] podium mode EXIT');
    }),
  );

  // ─── Session commands ───
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.session.filter', async () => {
      const cfg = vscode.workspace.getConfiguration(CFG_NS);
      const current = cfg.get<string>('sessionFilter', '') || '';
      const next = await vscode.window.showInputBox({
        prompt: 'Filter orchestration sessions by name substring (empty = show all)',
        value: current,
        placeHolder: 'e.g. haiku, codex, ui-redesign',
      });
      if (next === undefined) return;
      await cfg.update('sessionFilter', next, vscode.ConfigurationTarget.Workspace);
      detector.setNameFilter(next);
      teamsProvider.refresh();
      vscode.window.showInformationMessage(
        next ? `Orchestration: filtering by "${next}"` : 'Orchestration: filter cleared',
      );
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.session.clearFilter', async () => {
      await vscode.workspace
        .getConfiguration(CFG_NS)
        .update('sessionFilter', '', vscode.ConfigurationTarget.Workspace);
      detector.setNameFilter('');
      teamsProvider.refresh();
      vscode.window.showInformationMessage('Orchestration: session filter cleared');
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.session.openDir', async (item: unknown) => {
      const snap = historyProvider.getSnapshot();
      if (!snap) return;
      const entry = snap.entries.find(
        (e) => (item as { entry?: { sessionId?: string } })?.entry?.sessionId === e.sessionId,
      );
      if (!entry) {
        vscode.window.showWarningMessage('Claude: no session selected.');
        return;
      }
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.directory));
    }),
  );

  // ─── Team commands ───
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.team.create', () => {
      output.appendLine('[orch] team.create invoked');
      SpawnTeamPanel.show(ctx, runtime, manager, output, providerHealth);
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.team.createIntegrated', async () => {
      output.appendLine('[orch] team.createIntegrated invoked');
      const spec = await promptTeamSpec();
      if (!spec) return;
      const resolved = runtime.resolveClaudeCli();
      const sessionId = randomUUID();
      const shellArgs = [...resolved.args, '--session-id', sessionId];
      const cwd = currentCwd();
      const term = vscode.window.createTerminal({
        name: `Podium · ${summarizeSlots(spec.slots)}`,
        shellPath: resolved.shell,
        shellArgs,
        cwd,
        env: { FORCE_COLOR: '1', OMC_OPENCLAW: '1' },
      });
      term.show();
      const delay = vscode.workspace
        .getConfiguration(CFG_NS)
        .get<number>('teamDispatchDelayMs', 1500);
      setTimeout(() => {
        const cmd = runtime.formatTeamCommand(spec);
        term.sendText(cmd, true);
      }, Math.max(0, delay));
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.team.quickCreate', async () => {
      output.appendLine('[orch] team.quickCreate invoked');
      const spec = await promptTeamSpec();
      if (!spec) return;
      const cwd = currentCwd();
      const title = `claude · ${summarizeSlots(spec.slots)}`;
      const delay = vscode.workspace
        .getConfiguration(CFG_NS)
        .get<number>('teamDispatchDelayMs', 1500);
      await TerminalPanel.openClaude(ctx, runtime, manager, output, {
        title,
        cwd,
        teamSpec: spec,
        dispatchDelayMs: delay,
      });
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.team.attach', async (item: unknown) => {
      if (!(item instanceof SessionNode)) {
        vscode.window.showWarningMessage(
          'Claude: right-click a session in the Teams view to attach.',
        );
        return;
      }
      const sessionName = item.detected.session.name;
      await TerminalPanel.attach(ctx, runtime, manager, output, {
        sessionName,
        cwd: currentCwd(),
        multiplexerBinary: binaryFor(backend),
      });
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.team.missions.focus', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.claude-code-launcher');
      await vscode.commands.executeCommand('claudeCodeLauncher.missionsPanel.focus');
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.team.missions.refresh', () => {
      missionWatcher.forceRefresh();
    }),
  );

  // ─── Podium Mode multi-pane + dashboard ───
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.podium.grid', async (item: unknown) => {
      let sessionName: string | undefined;
      if (item instanceof SessionNode) {
        sessionName = item.detected.session.name;
      } else {
        const all = await backend.listSessions();
        const filtered = all.filter((s) => s.name.startsWith(prefix));
        if (filtered.length === 0) {
          vscode.window.showInformationMessage('Claude: no OMC sessions found. Spawn a team first.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          filtered.map((s) => ({
            label: s.name,
            description: `${s.windowCount} window(s)${s.attached ? ' · attached' : ''}`,
          })),
          { placeHolder: 'Select a session to view all panes' },
        );
        if (!picked) return;
        sessionName = picked.label;
      }
      if (!sessionName) return;
      const poll = vscode.workspace
        .getConfiguration(CFG_NS)
        .get<number>('multipane.pollIntervalMs', 1000);
      await MultiPaneTerminalPanel.open(ctx, backend, output, sessionName, poll);
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.podium.dashboard', () => {
      output.appendLine('[orch] podium.dashboard invoked');
      // ccg: null — Claude-Codex-Gemini watcher deferred to M3
      HUDDashboardPanel.show(ctx, output, {
        hud: stateWatcher.snapshot(),
        history: historyWatcher.snapshot(),
        ccg: null,
      });
    }),
  );

  // ─── HUD / Conversation / History commands ───
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.hud.focus', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.claude-code-launcher');
      await vscode.commands.executeCommand('claudeCodeLauncher.hudPanel.focus');
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.hud.refresh', () => {
      stateWatcher.forceRefresh();
    }),
    vscode.commands.registerCommand(
      'claudeCodeLauncher.conversation.focus',
      async (item: unknown) => {
        let sessionName: string | undefined;
        if (item instanceof SessionNode) {
          sessionName = item.detected.session.name;
        } else {
          const all = await backend.listSessions();
          const filtered = all.filter((s) => s.name.startsWith(prefix));
          if (filtered.length === 0) {
            vscode.window.showInformationMessage('Claude: no OMC team sessions found.');
            return;
          }
          const picked = await vscode.window.showQuickPick(
            filtered.map((s) => ({
              label: s.name,
              description: `${s.windowCount} window(s)${s.attached ? ' · attached' : ''}`,
            })),
            { placeHolder: 'Pick a team to inspect messages' },
          );
          if (!picked) return;
          sessionName = picked.label;
        }
        if (!sessionName) return;
        const cwd = currentCwd();
        const stripped = sessionName.replace(/^omc-team-/, '');
        const canonical = stripped.replace(/-[a-z0-9]{8}$/, '');
        const canonicalDir = path.join(cwd, '.omc', 'state', 'team', canonical);
        const suffixedDir = path.join(cwd, '.omc', 'state', 'team', stripped);
        let teamName = canonical;
        if (!fs.existsSync(canonicalDir) && fs.existsSync(suffixedDir)) teamName = stripped;
        TeamConversationPanel.show(ctx, output, cwd, teamName);
      },
    ),
    vscode.commands.registerCommand('claudeCodeLauncher.conversation.openLatest', () => {
      const cwd = currentCwd();
      const teamsDir = path.join(cwd, '.omc', 'state', 'team');
      if (!fs.existsSync(teamsDir)) {
        output.appendLine('[orch.convo] no .omc/state/team dir yet');
        return;
      }
      const entries = fs
        .readdirSync(teamsDir)
        .map((name: string) => {
          const full = path.join(teamsDir, name);
          try {
            const stat = fs.statSync(full);
            return stat.isDirectory() ? { name, mtime: stat.mtimeMs } : null;
          } catch {
            return null;
          }
        })
        .filter((e): e is { name: string; mtime: number } => e !== null)
        .sort((a, b) => b.mtime - a.mtime);
      if (entries.length === 0) {
        output.appendLine('[orch.convo] no team state dirs found');
        return;
      }
      TeamConversationPanel.show(ctx, output, cwd, entries[0].name);
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.history.focus', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.claude-code-launcher');
      await vscode.commands.executeCommand('claudeCodeLauncher.historyPanel.focus');
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.history.refresh', () => {
      historyWatcher.forceRefresh();
    }),
  );

  // ─── System commands (Gateway / Permissions / Gemini) ───
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.system.registerGateway', async () => {
      if (!receiver || !receiver.url) {
        vscode.window.showErrorMessage(
          'Hook receiver is not running. Enable "claudeCodeLauncher.orchestration.hookReceiver.enabled" and reload.',
        );
        return;
      }
      const token = await tokenStore.getOrCreate();
      try {
        const result = registerPodiumAsGateway(receiver.url, token);
        output.appendLine(`[orch] OpenClaw config written -> ${result.configPath}`);
        const ans = await vscode.window.showInformationMessage(
          `Podium registered as OpenClaw gateway at ${result.url}. Set OMC_OPENCLAW=1 before starting claude.`,
          'Open config',
          'Copy URL',
          'OK',
        );
        if (ans === 'Open config') {
          vscode.commands.executeCommand('vscode.open', vscode.Uri.file(result.configPath));
        } else if (ans === 'Copy URL') {
          await vscode.env.clipboard.writeText(result.url);
          vscode.window.showInformationMessage('Claude: hook URL copied.');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[orch] registerGateway failed: ${msg}`);
        vscode.window.showErrorMessage(`Claude: could not write OpenClaw config — ${msg}`);
      }
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.system.copyGatewayUrl', async () => {
      if (!receiver?.url) {
        vscode.window.showWarningMessage('Hook receiver is not running.');
        return;
      }
      await vscode.env.clipboard.writeText(receiver.url);
      vscode.window.showInformationMessage(`Claude: copied ${receiver.url}`);
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.system.rotateGatewayToken', async () => {
      await tokenStore.rotate();
      output.appendLine('[orch] hook receiver token rotated');
      const ans = await vscode.window.showInformationMessage(
        'Token rotated. Re-run "Register OpenClaw Gateway" to pick up the new token.',
        'Register now',
      );
      if (ans === 'Register now') {
        vscode.commands.executeCommand('claudeCodeLauncher.system.registerGateway');
      }
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.system.openGatewayConfig', () => {
      const p = openclawConfigPath();
      const registered = isPodiumGatewayRegistered();
      output.appendLine(`[orch] openclaw config path=${p} registered=${registered}`);
      vscode.window.showInformationMessage(
        `OpenClaw config -> ${p} (${registered ? 'registered' : 'not registered'})`,
      );
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.system.installWorkerPermissions', () => {
      output.appendLine('[orch.perms] installWorkerPermissions invoked');
      const result = ensureTeamWorkerPermissions(currentCwd());
      if (result.error) {
        output.appendLine(`[orch.perms] ERROR: ${result.error}`);
        vscode.window.showErrorMessage(`Claude: permissions setup failed — ${result.error}`);
        return;
      }
      if (result.wrote) {
        output.appendLine(
          `[orch.perms] wrote ${result.settingsPath}; added: ${result.added.join(', ')}`,
        );
        vscode.window.showInformationMessage(
          `Claude: added ${result.added.length} permission(s) to .claude/settings.json.`,
        );
      } else {
        vscode.window.showInformationMessage(
          'Claude: all team-worker permissions already present.',
        );
      }
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.system.installGeminiAutoApprove', () => {
      output.appendLine('[orch.gemini] installGeminiAutoApprove invoked');
      const result = installGeminiAutoApprove(currentCwd());
      if (result.error) {
        output.appendLine(`[orch.gemini] ERROR: ${result.error}`);
        vscode.window.showErrorMessage(`Claude: Gemini auto-approve setup failed — ${result.error}`);
        return;
      }
      const actions: string[] = [];
      if (result.settingsAdded.folderTrustEnabled) actions.push('folderTrust enabled');
      if (result.settingsAdded.allowedEntries.length > 0) {
        actions.push(`${result.settingsAdded.allowedEntries.length} tools.allowed entries`);
      }
      if (result.trustedFolderAdded) {
        actions.push(`trusted workspace "${path.basename(result.trustedFolderAdded)}"`);
      }
      vscode.window.showInformationMessage(
        actions.length === 0
          ? 'Claude: Gemini auto-approve already configured.'
          : `Claude: Gemini auto-approve applied — ${actions.join(' · ')}. Restart Gemini workers.`,
      );
    }),
  );

  // ─── Config change + workspace folder listeners ───
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CFG_NS}.sessionPrefix`)) {
        const next = vscode.workspace
          .getConfiguration(CFG_NS)
          .get<string>('sessionPrefix', 'omc-team-');
        detector.setPrefix(next);
        teamsProvider.refresh();
      }
      if (e.affectsConfiguration(`${CFG_NS}.sessionFilter`)) {
        const next =
          vscode.workspace.getConfiguration(CFG_NS).get<string>('sessionFilter', '') || '';
        detector.setNameFilter(next);
        teamsProvider.refresh();
      }
      if (e.affectsConfiguration(`${CFG_NS}.claudeCommand`)) {
        const next =
          vscode.workspace.getConfiguration(CFG_NS).get<string>('claudeCommand', '') || undefined;
        runtime.setClaudeCommand(next);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const next = currentCwd();
      output.appendLine(`[orch] workspace changed -> ${next}`);
      stateWatcher.start(next);
      missionWatcher.start(next);
      historyWatcher.start(next);
      providerHealth.setCwd(next);
    }),
  );

  // ─── podium.* shim (only if rockuen.podium not installed, avoid duplicate) ───
  const podiumInstalled = !!vscode.extensions.getExtension('rockuen.podium');
  if (!podiumInstalled) {
    const shims: Array<[string, string]> = [
      ['podium.openClaudeTerminal',         'claudeCodeLauncher.open'],
      ['podium.attachSession',              'claudeCodeLauncher.resumeSession'],
      ['podium.refresh',                    'claudeCodeLauncher.refreshSessions'],
      ['podium.killSession',                'claudeCodeLauncher.trashSession'],
      ['podium.searchSessions',             'claudeCodeLauncher.session.filter'],
      ['podium.clearSessionFilter',         'claudeCodeLauncher.session.clearFilter'],
      ['podium.openSessionDir',             'claudeCodeLauncher.session.openDir'],
      ['podium.spawnTeamWebview',           'claudeCodeLauncher.team.create'],
      ['podium.spawnTeamIntegrated',        'claudeCodeLauncher.team.createIntegrated'],
      ['podium.spawnTeam',                  'claudeCodeLauncher.team.quickCreate'],
      ['podium.showMissions',               'claudeCodeLauncher.team.missions.focus'],
      ['podium.refreshMissions',            'claudeCodeLauncher.team.missions.refresh'],
      ['podium.viewAllPanes',               'claudeCodeLauncher.podium.grid'],
      ['podium.showHudDashboard',           'claudeCodeLauncher.podium.dashboard'],
      ['podium.showHud',                    'claudeCodeLauncher.hud.focus'],
      ['podium.refreshHud',                 'claudeCodeLauncher.hud.refresh'],
      ['podium.showTeamConversation',       'claudeCodeLauncher.conversation.focus'],
      ['podium.openLatestTeamConversation', 'claudeCodeLauncher.conversation.openLatest'],
      ['podium.showHistory',                'claudeCodeLauncher.history.focus'],
      ['podium.refreshHistory',             'claudeCodeLauncher.history.refresh'],
      ['podium.registerOpenclawGateway',    'claudeCodeLauncher.system.registerGateway'],
      ['podium.copyHookReceiverUrl',        'claudeCodeLauncher.system.copyGatewayUrl'],
      ['podium.rotateHookReceiverToken',    'claudeCodeLauncher.system.rotateGatewayToken'],
      ['podium.showOpenclawConfigPath',     'claudeCodeLauncher.system.openGatewayConfig'],
      ['podium.installTeamPermissions',     'claudeCodeLauncher.system.installWorkerPermissions'],
      ['podium.installGeminiAutoApprove',   'claudeCodeLauncher.system.installGeminiAutoApprove'],
    ];
    const warned = new Set<string>();
    for (const [legacy, next] of shims) {
      ctx.subscriptions.push(
        vscode.commands.registerCommand(legacy, async (...args: unknown[]) => {
          if (!warned.has(legacy)) {
            warned.add(legacy);
            output.appendLine(`[deprecated] ${legacy} -> ${next}`);
          }
          return vscode.commands.executeCommand(next, ...args);
        }),
      );
    }
    output.appendLine(`[orch] podium.* shim layer registered (${shims.length} aliases)`);
  } else {
    output.appendLine('[orch] rockuen.podium detected; podium.* shim skipped');
  }

  output.appendLine(
    `[orch] ready (backend=${backend.name}, prefix="${prefix}", pollingMs=${pollingMs})`,
  );

  return {
    dispose: () => {
      // Disposables handled via ctx.subscriptions
    },
  };
}

// ─── Helpers ───
async function resolveBackend(
  choice: string,
  output: vscode.OutputChannel,
): Promise<IMultiplexerBackend> {
  const isWindows = process.platform === 'win32';
  if (choice === 'tmux') return new TmuxBackend();
  if (choice === 'psmux') return new PsmuxBackend();
  const primary: IMultiplexerBackend = isWindows ? new PsmuxBackend() : new TmuxBackend();
  try {
    if (await primary.isAvailable()) {
      output.appendLine(`[orch] backend: ${primary.name} (auto)`);
      return primary;
    }
  } catch {
    /* ignore */
  }
  output.appendLine(`[orch] primary backend "${primary.name}" unavailable; trying fallback`);
  const fallback: IMultiplexerBackend = isWindows ? new TmuxBackend() : new PsmuxBackend();
  try {
    if (await fallback.isAvailable()) {
      output.appendLine(`[orch] backend: ${fallback.name} (fallback)`);
      return fallback;
    }
  } catch {
    /* ignore */
  }
  output.appendLine('[orch] no multiplexer binary found; commands will fail until installed');
  return primary;
}

function binaryFor(b: IMultiplexerBackend): string {
  return b.name === 'psmux' ? 'psmux' : 'tmux';
}

function currentCwd(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  return process.cwd();
}

async function promptTeamSpec(): Promise<TeamSpec | undefined> {
  const model = (await vscode.window.showQuickPick(
    [
      { label: 'claude', description: 'Anthropic Claude' },
      { label: 'codex', description: 'OpenAI Codex' },
      { label: 'gemini', description: 'Google Gemini' },
    ],
    {
      placeHolder: 'Select model for the team (mixed models: use Webview form)',
      matchOnDescription: true,
    },
  )) as { label: AgentModel } | undefined;
  if (!model) return undefined;

  const countStr = await vscode.window.showInputBox({
    prompt: 'Number of workers (1-10)',
    value: '2',
    validateInput: (v) => {
      if (!/^\d+$/.test(v)) return 'Enter an integer';
      const n = Number(v);
      if (n < 1 || n > 10) return 'Range: 1-10';
      return null;
    },
  });
  if (!countStr) return undefined;

  const prompt = await vscode.window.showInputBox({
    prompt: `Prompt for the ${model.label}×${countStr} team`,
    placeHolder: 'e.g., write a haiku about tmux',
    ignoreFocusOut: true,
  });
  if (prompt === undefined || prompt.trim() === '') return undefined;

  return {
    slots: [{ model: model.label, count: Number(countStr) }],
    prompt: prompt.trim(),
  };
}
