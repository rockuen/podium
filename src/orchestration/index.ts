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

import { OMCRuntime } from './core/OMCRuntime';
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

import {
  SessionTreeProvider as TeamsTreeProvider,
  PodiumLiveTeamNode,
  WorkerTreeItem,
} from './ui/TeamsTreeProvider';
import { LiveMultiPanel } from './ui/LiveMultiPanel';
import { MAX_RUNTIME_WORKERS, PodiumOrchestrator } from './core/PodiumOrchestrator';
import { buildLeaderExtraArgs } from './core/leaderProtocol';
import { pickClaudeSession, isClaudeSessionResumable } from './core/sessionPicker';
import {
  makeSnapshotId,
  pickSnapshot,
  promptSnapshotName,
  resolveSnapshotPath,
  saveSnapshot,
  type TeamSnapshot,
} from './core/teamSnapshot';
import type { CapturedSnapshot } from './core/PodiumOrchestrator';
import { HUDStatusBarItem } from './ui/HUDStatusBarItem';
import { HUDTreeProvider } from './ui/HUDTreeProvider';
import { HUDDashboardPanel } from './ui/HUDDashboardPanel';
import { MissionsTreeProvider } from './ui/MissionsTreeProvider';
import { SessionHistoryProvider } from './ui/SessionHistoryProvider';
import { TeamConversationPanel } from './ui/TeamConversationPanel';

import { CcgArtifactWatcher } from './core/CcgArtifactWatcher';
import { CcgTreeProvider } from './ui/CcgTreeProvider';
import { CcgViewerPanel } from './ui/CcgViewerPanel';

import type { MissionSnapshot } from './core/MissionWatcher';
import type { SessionHistorySnapshot } from './types/history';
import type { HUDStdinCache } from './types/hud';
import type { OMCOpenClawPayload } from './types/events';
import type { CcgPair, CcgSnapshot } from './types/ccg';

export interface OrchestrationAPI {
  dispose(): void;
}

const CFG_NS = 'claudeCodeLauncher.orchestration';

export async function activate(ctx: vscode.ExtensionContext): Promise<OrchestrationAPI> {
  const output = vscode.window.createOutputChannel('Podium - Orchestration');
  ctx.subscriptions.push(output);
  output.appendLine('[orch] activating...');

  const config = vscode.workspace.getConfiguration(CFG_NS);
  const claudeOverride = config.get<string>('claudeCommand', '') || undefined;

  const runtime = new OMCRuntime(claudeOverride);
  const manager = new PodiumManager();
  ctx.subscriptions.push(manager);

  const providerHealth = new ProviderHealthChecker((msg) => output.appendLine(msg));
  providerHealth.setCwd(currentCwd());
  providerHealth.start();
  ctx.subscriptions.push({ dispose: () => providerHealth.stop() });

  // ─── Podium orchestrator registry (hoisted for TeamsTreeProvider wiring) ───
  // v2.7.25 · The registry needs to be constructed before `TeamsTreeProvider`
  // so the tree can render live `PodiumLiveTeamNode`s. The dispose hook stays
  // attached to `ctx.subscriptions` exactly as before; only the declaration
  // site moved up.
  const orchestratorRegistry = new Map<string, PodiumOrchestrator>();
  ctx.subscriptions.push({
    dispose() {
      for (const o of orchestratorRegistry.values()) o.dispose();
      orchestratorRegistry.clear();
    },
  });

  // ─── Teams tree ───
  const teamsProvider = new TeamsTreeProvider(orchestratorRegistry);
  const teamsView = vscode.window.createTreeView('claudeCodeLauncher.teamsOrchestration', {
    treeDataProvider: teamsProvider,
    showCollapseAll: true,
  });
  ctx.subscriptions.push(teamsView);

  const pollingMs = Math.max(1000, config.get<number>('pollingIntervalMs', 5000));
  const pollTimer = setInterval(() => teamsProvider.refresh(), pollingMs);
  ctx.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  // ─── Step 8 helpers · sessionKey-routed orchestrator lookup ───
  // v2.7.25 · Used by the 3 dynamic worker commands (add/remove/rename).
  // `lookupOrchestratorByKey` is the primary path for tree-context invocations
  // where the `sessionKey` is already known; `pickOrchestratorViaQuickPick`
  // is the Command Palette fallback when no tree item was clicked.
  function lookupOrchestratorByKey(sessionKey: string): PodiumOrchestrator | undefined {
    return orchestratorRegistry.get(sessionKey);
  }

  function warnMissingTeam(sessionKey: string): void {
    vscode.window.showWarningMessage(
      `Podium: team ${sessionKey} is no longer running. Close and reopen the Teams view if it looks stale.`,
    );
  }

  async function pickOrchestratorViaQuickPick(): Promise<
    { sessionKey: string; orch: PodiumOrchestrator } | undefined
  > {
    const entries = [...orchestratorRegistry.entries()];
    if (entries.length === 0) {
      vscode.window.showInformationMessage('Podium: no running teams to select from.');
      return undefined;
    }
    if (entries.length === 1) {
      return { sessionKey: entries[0][0], orch: entries[0][1] };
    }
    const items = entries.map(([key, orch]) => ({
      label: key,
      description: `${orch.listWorkers().length} worker(s)`,
      sessionKey: key,
      orch,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Podium: select team',
      placeHolder: 'Multiple Podium teams are running — pick one',
    });
    if (!picked) return undefined;
    return { sessionKey: picked.sessionKey, orch: picked.orch };
  }

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

  // ─── CCG (Claude-Codex-Gemini) ───
  const ccgProvider = new CcgTreeProvider();
  const ccgView = vscode.window.createTreeView('claudeCodeLauncher.ccgPanel', {
    treeDataProvider: ccgProvider,
  });
  ctx.subscriptions.push(ccgView);
  const ccgWatcher = new CcgArtifactWatcher((msg) => output.appendLine(msg));
  ccgWatcher.on('snapshot', (snap: CcgSnapshot) => {
    ccgProvider.update(snap);
    CcgViewerPanel.refreshIfOpen();
    HUDDashboardPanel.broadcast({ ccg: snap });
  });
  ctx.subscriptions.push({ dispose: () => ccgWatcher.stop() });
  ccgWatcher.start(initialRoot);

  const ccgDeps = {
    getPair: (id: string): CcgPair | null => ccgProvider.findPair(id),
    onRerun: async (pair: CcgPair) => {
      const promptText = pair.codex?.originalTask ?? pair.gemini?.originalTask ?? pair.title;
      const text = promptText.replace(/\s+/g, ' ').trim().slice(0, 600);
      await vscode.env.clipboard.writeText(`/ccg "${text}"`);
      vscode.window.showInformationMessage(
        'Claude: /ccg command copied. Paste it into a Claude Code terminal to re-run.',
      );
    },
  };

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
      output.appendLine('[orch] podium mode ENTER');
      vscode.window.showInformationMessage('Podium Mode activated.');
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

  // ─── Missions view ───
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.team.missions.focus', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.claude-code-launcher');
      await vscode.commands.executeCommand('claudeCodeLauncher.missionsPanel.focus');
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.team.missions.refresh', () => {
      missionWatcher.forceRefresh();
    }),
  );

  // ─── Phase 1 · v2.7.0 — Live Multi-Pane test command ───
  // Opens a LiveMultiPanel seeded with two Claude panes side by side. Lets
  // us verify node-pty streaming, per-pane input routing, and UTF-8 before
  // we layer the v2.7 orchestrator on top.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.podium.liveTest', async () => {
      output.appendLine('[orch.liveTest] invoked');
      const cwd = currentCwd();
      const panel = LiveMultiPanel.create(ctx, output, 'Podium · Live Test (2 Claudes)');
      panel.addPane({
        paneId: 'claude-1',
        label: 'claude-1 (leader)',
        agent: 'claude',
        cwd,
        autoSessionId: true,
      });
      panel.addPane({
        paneId: 'claude-2',
        label: 'claude-2 (worker)',
        agent: 'claude',
        cwd,
        autoSessionId: true,
      });
      panel.reveal();
    }),
  );

  // ─── Phase 2 · v2.7.2 — Orchestrated team (leader + 2 workers) ───
  // Spawns a 3-pane team with a PodiumOrchestrator attached. The leader is
  // typed into normally; whenever its stream contains `@worker-1: ...` or
  // `@worker-2: ...`, the orchestrator injects the payload into that worker
  // once the worker's prompt is visible and its output has gone quiet.
  // v2.7.25: `orchestratorRegistry` now lives at the top of `activate()` so
  // `TeamsTreeProvider` can render live worker nodes.

  // v2.7.19 · Auto-save snapshot hook factory.
  // Invoked by PodiumOrchestrator on dissolve or first pane-exit; writes a
  // TeamSnapshot entry to the OneDrive-synced claudeTeams.json (capped at 10
  // newest). Returns a non-async callback so orchestrator can fire-and-forget.
  const makeAutoSnapshotHook = (
    outputChannel: vscode.OutputChannel,
    defaultName: string,
  ) => (snap: CapturedSnapshot, source: 'dissolve' | 'pane-exit') => {
    const file = resolveSnapshotPath();
    const team: TeamSnapshot = {
      id: makeSnapshotId(),
      name: `auto · ${defaultName} (${source})`,
      createdAt: new Date().toISOString(),
      source,
      cwd: snap.cwd,
      leader: {
        paneId: snap.leader.paneId,
        agent: snap.leader.agent,
        sessionId: snap.leader.sessionId ?? '',
        label: snap.leader.label,
      },
      workers: snap.workers
        .filter((w) => w.sessionId)
        .map((w) => ({ paneId: w.paneId, agent: w.agent, sessionId: w.sessionId!, label: w.id })),
    };
    saveSnapshot(file, team)
      .then(() =>
        outputChannel.appendLine(`[orch.snapshot] auto-saved (${source}) → ${file}`),
      )
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[orch.snapshot] auto-save FAILED — ${msg}`);
      });
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.podium.orchestrate', async () => {
      output.appendLine('[orch.orchestrate] invoked');
      const cwd = currentCwd();
      const panel = LiveMultiPanel.create(
        ctx,
        output,
        'Podium · Orchestrated Team (leader + 2 workers)',
      );

      // v2.7.19: pre-generate UUIDs so we can snapshot & restore.
      const leaderSid = randomUUID();
      const worker1Sid = randomUUID();
      const worker2Sid = randomUUID();

      panel.addPane({
        paneId: 'leader',
        label: 'leader (claude)',
        agent: 'claude',
        cwd,
        sessionId: leaderSid,
        extraArgs: buildLeaderExtraArgs(),
      });
      panel.addPane({
        paneId: 'worker-1',
        label: 'worker-1 (claude)',
        agent: 'claude',
        cwd,
        sessionId: worker1Sid,
      });
      panel.addPane({
        paneId: 'worker-2',
        label: 'worker-2 (claude)',
        agent: 'claude',
        cwd,
        sessionId: worker2Sid,
      });

      const orch = new PodiumOrchestrator(panel, output);
      orch.attach({
        leader: { paneId: 'leader', agent: 'claude', sessionId: leaderSid, label: 'leader (claude)' },
        workers: [
          { id: 'worker-1', paneId: 'worker-1', agent: 'claude', sessionId: worker1Sid },
          { id: 'worker-2', paneId: 'worker-2', agent: 'claude', sessionId: worker2Sid },
        ],
        dispatchDebounceMs: 1200,
        cwd,
        onAutoSnapshot: makeAutoSnapshotHook(output, `team ${new Date().toLocaleString()}`),
      });

      const sessionKey = `orch-${Date.now()}`;
      orchestratorRegistry.set(sessionKey, orch);

      panel.onPaneExit(() => {
        // Any pane exit implies the team is broken; tear down the orchestrator.
        const existing = orchestratorRegistry.get(sessionKey);
        if (existing) {
          existing.dispose();
          orchestratorRegistry.delete(sessionKey);
          teamsProvider.refresh();
        }
      });
      // v2.7.27: user-driven webview close path. disposeAll() tears down
      // paneExitEmitter before pty.kill()'s onExit can fire, so the onPaneExit
      // subscription above is unreachable for tab-close. This handler is the
      // only path that keeps orchestratorRegistry + tree view consistent when
      // the user closes the team tab manually.
      panel.onDidDispose(() => {
        const existing = orchestratorRegistry.get(sessionKey);
        if (existing) {
          existing.dispose();
          orchestratorRegistry.delete(sessionKey);
          teamsProvider.refresh();
          output.appendLine(`[orch] panel disposed → ${sessionKey} removed from registry`);
        }
      });

      panel.reveal();
      vscode.window.showInformationMessage(
        'Podium orchestrator attached. Type into the leader pane and say e.g. "@worker-1: ..." to route.',
      );
    }),
  );

  // ─── Phase 3.4 · v2.7.12 — Resume an existing Claude session as leader ───
  // Variant of `podium.orchestrate`: scans ~/.claude/projects/<cwd>/ for
  // prior sessions, lets the user pick one, then spawns the leader pane
  // with `--resume <uuid>` on top of the normal Podium leader flags. The
  // leader's conversation carries over; the routing protocol and Task-tool
  // block are applied fresh via `--disallowedTools` + `--append-system-prompt`,
  // which Claude re-asserts on every process launch.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.podium.orchestrate.resume', async () => {
      output.appendLine('[orch.orchestrate.resume] invoked');
      const cwd = currentCwd();
      const sessionId = await pickClaudeSession(cwd);
      if (!sessionId) {
        output.appendLine('[orch.orchestrate.resume] cancelled — no session picked');
        return;
      }
      output.appendLine(`[orch.orchestrate.resume] resuming session=${sessionId}`);

      const panel = LiveMultiPanel.create(
        ctx,
        output,
        `Podium · Resumed Team (leader=${sessionId.slice(0, 8)} + 2 workers)`,
      );

      // v2.7.19: resume keeps the leader's session ID; workers get fresh UUIDs.
      const worker1Sid = randomUUID();
      const worker2Sid = randomUUID();

      panel.addPane({
        paneId: 'leader',
        label: `leader (claude, resumed ${sessionId.slice(0, 8)})`,
        agent: 'claude',
        cwd,
        autoSessionId: false,
        extraArgs: buildLeaderExtraArgs({ resumeSessionId: sessionId }),
      });
      panel.addPane({
        paneId: 'worker-1',
        label: 'worker-1 (claude)',
        agent: 'claude',
        cwd,
        sessionId: worker1Sid,
      });
      panel.addPane({
        paneId: 'worker-2',
        label: 'worker-2 (claude)',
        agent: 'claude',
        cwd,
        sessionId: worker2Sid,
      });

      const orch = new PodiumOrchestrator(panel, output);
      orch.attach({
        leader: { paneId: 'leader', agent: 'claude', sessionId, label: `leader (resumed ${sessionId.slice(0, 8)})` },
        workers: [
          { id: 'worker-1', paneId: 'worker-1', agent: 'claude', sessionId: worker1Sid },
          { id: 'worker-2', paneId: 'worker-2', agent: 'claude', sessionId: worker2Sid },
        ],
        dispatchDebounceMs: 1200,
        cwd,
        onAutoSnapshot: makeAutoSnapshotHook(output, `resumed ${sessionId.slice(0, 8)}`),
      });

      const sessionKey = `orch-resume-${Date.now()}`;
      orchestratorRegistry.set(sessionKey, orch);

      panel.onPaneExit(() => {
        const existing = orchestratorRegistry.get(sessionKey);
        if (existing) {
          existing.dispose();
          orchestratorRegistry.delete(sessionKey);
          teamsProvider.refresh();
        }
      });
      // v2.7.27: webview close path — see orchestrate command's identical block.
      panel.onDidDispose(() => {
        const existing = orchestratorRegistry.get(sessionKey);
        if (existing) {
          existing.dispose();
          orchestratorRegistry.delete(sessionKey);
          teamsProvider.refresh();
          output.appendLine(`[orch] panel disposed → ${sessionKey} removed from registry`);
        }
      });

      panel.reveal();
      vscode.window.showInformationMessage(
        `Podium orchestrator attached (resumed ${sessionId.slice(0, 8)}). Leader has prior context; delegate with @worker-N: directives.`,
      );
    }),
  );

  // ─── Phase 4.A · v2.7.19 — Team Snapshot: save ───
  // Manually record the current team's session IDs + metadata to the
  // OneDrive-synced claudeTeams.json so the user can reopen it later via
  // `podium.snapshot.load`. Auto-save also runs on dissolve / pane-exit.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.podium.snapshot.save', async (arg?: unknown) => {
      let target: PodiumOrchestrator | undefined;
      if (arg instanceof PodiumLiveTeamNode) {
        target = lookupOrchestratorByKey(arg.sessionKey);
      }
      if (!target) {
        const active = [...orchestratorRegistry.values()];
        if (active.length === 0) {
          vscode.window.showInformationMessage(
            'Podium: no active team to snapshot. Start a team first.',
          );
          return;
        }
        target = active[active.length - 1];
      }
      let snap: CapturedSnapshot;
      try {
        snap = target.captureSnapshot();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Podium snapshot capture failed: ${msg}`);
        return;
      }
      const defaultName = `Team ${new Date().toLocaleString()}`;
      const name = await promptSnapshotName(defaultName);
      if (!name) {
        output.appendLine('[orch.snapshot.save] cancelled — no name');
        return;
      }
      const file = resolveSnapshotPath();
      const team: TeamSnapshot = {
        id: makeSnapshotId(),
        name,
        createdAt: new Date().toISOString(),
        source: 'manual',
        cwd: snap.cwd,
        leader: {
          paneId: snap.leader.paneId,
          agent: snap.leader.agent,
          sessionId: snap.leader.sessionId ?? '',
          label: snap.leader.label,
        },
        workers: snap.workers
          .filter((w) => w.sessionId)
          .map((w) => ({ paneId: w.paneId, agent: w.agent, sessionId: w.sessionId!, label: w.id })),
      };
      try {
        await saveSnapshot(file, team);
        output.appendLine(`[orch.snapshot.save] saved "${name}" → ${file}`);
        vscode.window.showInformationMessage(`Podium snapshot saved: "${name}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Podium snapshot save failed: ${msg}`);
      }
    }),
  );

  // ─── Phase 4.A · v2.7.19 — Team Snapshot: load/restore ───
  // Picker over saved teams. Spawns a new LiveMultiPanel with each pane
  // `--resume`'d to its saved session, applying the Podium protocol fresh
  // to the leader. Workers keep their prior conversations.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.podium.snapshot.load', async () => {
      output.appendLine('[orch.snapshot.load] invoked');
      const file = resolveSnapshotPath();
      const snap = await pickSnapshot(file);
      if (!snap) {
        output.appendLine('[orch.snapshot.load] cancelled — no snapshot picked');
        return;
      }
      if (!snap.leader.sessionId) {
        vscode.window.showErrorMessage('Snapshot has no leader session — cannot restore.');
        return;
      }
      output.appendLine(
        `[orch.snapshot.load] restoring "${snap.name}" leader=${snap.leader.sessionId.slice(0, 8)} workers=${snap.workers.length}`,
      );
      const cwd = snap.cwd;
      const panel = LiveMultiPanel.create(
        ctx,
        output,
        `Podium · Restored: ${snap.name}`,
      );

      // v2.7.26 · per-pane resume probe. Claude CLI only writes a
      // `~/.claude/projects/<cwd>/<uuid>.jsonl` AFTER the first user submit,
      // so a pane that was spawned in the original session but never received
      // a message has no file on disk. `--resume <uuid>` would then fail with
      // "No conversation found with session ID …" and exit code=1. Instead,
      // for non-resumable panes we spawn fresh with the same UUID via
      // `--session-id` so the snapshot ledger keeps its pane identity intact.
      const leaderResumable = isClaudeSessionResumable(cwd, snap.leader.sessionId);
      if (leaderResumable) {
        panel.addPane({
          paneId: snap.leader.paneId,
          label: `leader (restored ${snap.leader.sessionId.slice(0, 8)})`,
          agent: snap.leader.agent,
          cwd,
          autoSessionId: false,
          extraArgs: buildLeaderExtraArgs({ resumeSessionId: snap.leader.sessionId }),
        });
      } else {
        output.appendLine(
          `[orch.snapshot.load] leader has no JSONL transcript (${snap.leader.sessionId.slice(0, 8)}); spawning fresh with same session-id + Podium protocol`,
        );
        panel.addPane({
          paneId: snap.leader.paneId,
          label: `leader (fresh ${snap.leader.sessionId.slice(0, 8)})`,
          agent: snap.leader.agent,
          cwd,
          sessionId: snap.leader.sessionId,
          extraArgs: buildLeaderExtraArgs(),
        });
      }
      let resumedCount = 0;
      let freshCount = 0;
      for (const w of snap.workers) {
        const resumable = isClaudeSessionResumable(cwd, w.sessionId);
        if (resumable) {
          resumedCount += 1;
          panel.addPane({
            paneId: w.paneId,
            label: `${w.label ?? w.paneId} (restored ${w.sessionId.slice(0, 8)})`,
            agent: w.agent,
            cwd,
            autoSessionId: false,
            extraArgs: ['--resume', w.sessionId],
          });
        } else {
          freshCount += 1;
          output.appendLine(
            `[orch.snapshot.load] worker ${w.paneId} has no JSONL transcript (${w.sessionId.slice(0, 8)}); spawning fresh with same session-id`,
          );
          panel.addPane({
            paneId: w.paneId,
            label: `${w.label ?? w.paneId} (fresh ${w.sessionId.slice(0, 8)})`,
            agent: w.agent,
            cwd,
            sessionId: w.sessionId,
          });
        }
      }
      output.appendLine(
        `[orch.snapshot.load] workers: ${resumedCount} resumed · ${freshCount} fresh (never used in original session)`,
      );

      const orch = new PodiumOrchestrator(panel, output);
      orch.attach({
        leader: {
          paneId: snap.leader.paneId,
          agent: snap.leader.agent,
          sessionId: snap.leader.sessionId,
          label: snap.leader.label,
        },
        workers: snap.workers.map((w) => ({
          id: w.label ?? w.paneId,
          paneId: w.paneId,
          agent: w.agent,
          sessionId: w.sessionId,
        })),
        dispatchDebounceMs: 1200,
        cwd,
        onAutoSnapshot: makeAutoSnapshotHook(output, snap.name),
        // v2.7.29: wall-clock SAFETY CAP only. The grace is primarily closed
        // by `leaderIdle.msSinceOutput >= 1s` (Ink repaint settled) — see
        // PodiumOrchestrator.route(). 15s protects against a broken or very
        // slow leader; most restores close via the idle gate in 2–4s.
        restoreGraceMs: 15000,
      });

      const sessionKey = `orch-restore-${Date.now()}`;
      orchestratorRegistry.set(sessionKey, orch);

      panel.onPaneExit(() => {
        const existing = orchestratorRegistry.get(sessionKey);
        if (existing) {
          existing.dispose();
          orchestratorRegistry.delete(sessionKey);
        }
      });

      // v2.7.27: webview close path — see orchestrate command's identical block.
      panel.onDidDispose(() => {
        const existing = orchestratorRegistry.get(sessionKey);
        if (existing) {
          existing.dispose();
          orchestratorRegistry.delete(sessionKey);
          teamsProvider.refresh();
          output.appendLine(`[orch] panel disposed → ${sessionKey} removed from registry`);
        }
      });

      panel.reveal();
      vscode.window.showInformationMessage(
        `Podium restored "${snap.name}" (${snap.workers.length} workers). Prior context loaded; delegate with @worker-N: directives.`,
      );
    }),
  );

  // ─── Phase 4.A · v2.7.21 — Team Snapshot: rename ───
  // Picks an existing snapshot, prompts for a new name, and re-saves.
  // `saveSnapshot` dedupes by id so the renamed entry replaces the old one
  // and gets bumped to the front of the list (treated as "most recent").
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.podium.snapshot.rename', async () => {
      output.appendLine('[orch.snapshot.rename] invoked');
      const file = resolveSnapshotPath();
      const snap = await pickSnapshot(file);
      if (!snap) {
        output.appendLine('[orch.snapshot.rename] cancelled — no snapshot picked');
        return;
      }
      const newName = await promptSnapshotName(snap.name);
      if (!newName || newName === snap.name) {
        output.appendLine('[orch.snapshot.rename] cancelled — no name change');
        return;
      }
      try {
        await saveSnapshot(file, { ...snap, name: newName });
        output.appendLine(`[orch.snapshot.rename] "${snap.name}" → "${newName}"`);
        vscode.window.showInformationMessage(`Podium snapshot renamed: "${newName}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Podium snapshot rename failed: ${msg}`);
      }
    }),
  );

  // ─── Phase 4.B · v2.7.25 — Dynamic worker: add ───
  // Adds a `claude` worker to an already-attached PodiumOrchestrator at
  // runtime. Resolves the target team from (a) a `PodiumLiveTeamNode` when
  // invoked from the tree, (b) a string `sessionKey` when invoked with an
  // explicit argument, or (c) a QuickPick over `orchestratorRegistry`.
  // Scope-fenced to `claude` agent only in v2.7.25 per plan Principle 5.
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'claudeCodeLauncher.podium.worker.add',
      async (arg?: unknown) => {
        let sessionKey: string;
        if (arg instanceof PodiumLiveTeamNode) {
          sessionKey = arg.sessionKey;
        } else if (typeof arg === 'string') {
          sessionKey = arg;
        } else {
          const picked = await pickOrchestratorViaQuickPick();
          if (!picked) return;
          sessionKey = picked.sessionKey;
        }
        const orch = lookupOrchestratorByKey(sessionKey);
        if (!orch) {
          warnMissingTeam(sessionKey);
          return;
        }
        // v2.7.25: runtime add UI surfaces claude only (codex/gemini deferred).
        const currentWorkers = orch.listWorkers();
        if (currentWorkers.length >= MAX_RUNTIME_WORKERS) {
          vscode.window.showErrorMessage(
            `Podium: team ${sessionKey} already at the ${MAX_RUNTIME_WORKERS}-worker cap.`,
          );
          return;
        }
        // Compute next free worker id (worker-1, worker-2, ... skipping taken ones).
        const usedIds = new Set(currentWorkers.map((w) => w.cfg.id));
        let n = 1;
        while (usedIds.has(`worker-${n}`)) n += 1;
        const id = `worker-${n}`;
        const sessionId = randomUUID();
        try {
          await orch.addWorker({ id, paneId: id, agent: 'claude', sessionId });
          output.appendLine(`[orch.cmd] addWorker ${id} → ${sessionKey} ok`);
          teamsProvider.refresh();
          vscode.window.showInformationMessage(
            `Podium: ${id} added to ${sessionKey}. Route with @${id}: ...`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          output.appendLine(`[orch.cmd] addWorker FAILED — ${msg}`);
          vscode.window.showErrorMessage(`Podium: addWorker failed — ${msg}`);
        }
      },
    ),
  );

  // ─── Phase 4.B · v2.7.25 — Dynamic worker: remove ───
  // Drop + Notify (no modal confirm per plan Q2). Accepts a `WorkerTreeItem`
  // from the tree context menu, or falls back to a two-step team+worker
  // QuickPick from the Command Palette.
  async function removeWorkerInternal(sessionKey: string, workerId: string): Promise<void> {
    const orch = lookupOrchestratorByKey(sessionKey);
    if (!orch) {
      warnMissingTeam(sessionKey);
      return;
    }
    try {
      await orch.removeWorker(workerId);
      output.appendLine(`[orch.cmd] removeWorker ${workerId} from ${sessionKey} ok`);
      teamsProvider.refresh();
      vscode.window.showInformationMessage(`Podium: ${workerId} removed from ${sessionKey}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`[orch.cmd] removeWorker FAILED — ${msg}`);
      vscode.window.showErrorMessage(`Podium: removeWorker failed — ${msg}`);
    }
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'claudeCodeLauncher.podium.worker.remove',
      async (arg?: unknown) => {
        if (arg instanceof WorkerTreeItem) {
          await removeWorkerInternal(arg.sessionKey, arg.workerId);
          return;
        }
        // Command Palette entry: two-step picker.
        const teamPicked = await pickOrchestratorViaQuickPick();
        if (!teamPicked) return;
        const workers = teamPicked.orch.listWorkers();
        if (workers.length === 0) {
          vscode.window.showInformationMessage(
            `Podium: team ${teamPicked.sessionKey} has no workers.`,
          );
          return;
        }
        const workerPicked = await vscode.window.showQuickPick(
          workers.map((w) => ({
            label: w.cfg.label ?? w.cfg.id,
            description: w.cfg.id,
            workerId: w.cfg.id,
          })),
          { title: 'Podium: remove worker', placeHolder: 'Pick worker to remove' },
        );
        if (!workerPicked) return;
        await removeWorkerInternal(teamPicked.sessionKey, workerPicked.workerId);
      },
    ),
  );

  // ─── Phase 4.B · v2.7.25 — Dynamic worker: rename ───
  // Display-only rename — `worker.cfg.id` (routing key) is invariant.
  // Accepts a `WorkerTreeItem` from the tree context menu, or falls back
  // to a two-step team+worker QuickPick from the Command Palette.
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      'claudeCodeLauncher.podium.worker.rename',
      async (arg?: unknown) => {
        let sessionKey: string;
        let workerId: string;
        let currentLabel: string;
        if (arg instanceof WorkerTreeItem) {
          sessionKey = arg.sessionKey;
          workerId = arg.workerId;
          currentLabel = arg.cfg.label ?? arg.cfg.id;
        } else {
          // Command Palette entry: team + worker picker.
          const teamPicked = await pickOrchestratorViaQuickPick();
          if (!teamPicked) return;
          const workers = teamPicked.orch.listWorkers();
          if (workers.length === 0) {
            vscode.window.showInformationMessage(
              `Podium: team ${teamPicked.sessionKey} has no workers.`,
            );
            return;
          }
          const workerPicked = await vscode.window.showQuickPick(
            workers.map((w) => ({
              label: w.cfg.label ?? w.cfg.id,
              description: w.cfg.id,
              workerId: w.cfg.id,
              currentLabel: w.cfg.label ?? w.cfg.id,
            })),
            { title: 'Podium: rename worker', placeHolder: 'Pick worker to rename' },
          );
          if (!workerPicked) return;
          sessionKey = teamPicked.sessionKey;
          workerId = workerPicked.workerId;
          currentLabel = workerPicked.currentLabel;
        }
        const newLabel = await vscode.window.showInputBox({
          title: `Rename ${workerId}`,
          prompt: 'Enter a new display name (routing key stays the same)',
          value: currentLabel,
          validateInput: (v) => (v.trim().length === 0 ? 'Name cannot be empty' : undefined),
        });
        if (newLabel === undefined) return;
        const orch = lookupOrchestratorByKey(sessionKey);
        if (!orch) {
          warnMissingTeam(sessionKey);
          return;
        }
        try {
          orch.renameWorker(workerId, newLabel.trim());
          output.appendLine(
            `[orch.cmd] renameWorker ${workerId} → "${newLabel.trim()}" in ${sessionKey}`,
          );
          teamsProvider.refresh();
          vscode.window.showInformationMessage(
            `Podium: ${workerId} is now "${newLabel.trim()}".`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          output.appendLine(`[orch.cmd] renameWorker FAILED — ${msg}`);
          vscode.window.showErrorMessage(`Podium: renameWorker failed — ${msg}`);
        }
      },
    ),
  );

  // ─── Phase 3 · v2.7.8 — Dissolve the active orchestrator's workers ───
  // Kills every worker pane, asks `claude --bare -p --model haiku` for a
  // short summary of their transcripts, then injects that summary into the
  // leader's stdin. The leader stays alive and continues the conversation.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.podium.dissolve', async (arg?: unknown) => {
      output.appendLine('[orch.dissolve-cmd] invoked');
      let target: PodiumOrchestrator | undefined;
      if (arg instanceof PodiumLiveTeamNode) {
        target = lookupOrchestratorByKey(arg.sessionKey);
      }
      if (!target) {
        const active = [...orchestratorRegistry.values()];
        if (active.length === 0) {
          vscode.window.showInformationMessage('Podium: no active orchestrator to dissolve.');
          return;
        }
        // No tree-node context → dissolve the most recent team.
        target = active[active.length - 1];
      }

      // v2.7.21 · Warn before summarizing workers that haven't gone idle.
      // Dissolve captures the transcript tail — if a worker is still emitting
      // or hasn't printed its final prompt, the summary will miss the answer
      // (see v2.7.20 regression log).
      const busy = target.busyWorkers();
      if (busy.length > 0) {
        const detail = busy
          .map((b) => `${b.id} (last output ${b.msSinceOutput}ms ago)`)
          .join(', ');
        const pick = await vscode.window.showWarningMessage(
          `Podium: ${busy.length} worker(s) still active — ${detail}. ` +
            `Dissolving now will likely summarize an incomplete transcript. Continue?`,
          { modal: true },
          'Dissolve anyway',
          'Cancel',
        );
        if (pick !== 'Dissolve anyway') {
          output.appendLine(`[orch.dissolve-cmd] cancelled by user — busy workers: ${detail}`);
          return;
        }
        output.appendLine(`[orch.dissolve-cmd] user confirmed dissolve despite busy: ${detail}`);
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Podium: dissolving workers…',
          cancellable: false,
        },
        async () => {
          const summary = await target.dissolve();
          if (summary === null) {
            vscode.window.showInformationMessage(
              'Podium: no workers attached; nothing to dissolve.',
            );
          } else {
            vscode.window.showInformationMessage(
              'Podium: workers dissolved, summary injected into leader.',
            );
          }
        },
      );
    }),
  );

  // ─── Podium Mode dashboard ───
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.podium.dashboard', () => {
      output.appendLine('[orch] podium.dashboard invoked');
      HUDDashboardPanel.show(ctx, output, {
        hud: stateWatcher.snapshot(),
        history: historyWatcher.snapshot(),
        ccg: ccgWatcher.snapshot(),
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
      async () => {
        const cwd = currentCwd();
        const teamsDir = path.join(cwd, '.omc', 'state', 'team');
        if (!fs.existsSync(teamsDir)) {
          vscode.window.showInformationMessage('Claude: no .omc/state/team directory found.');
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
          vscode.window.showInformationMessage('Claude: no team directories to inspect.');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          entries.map((e) => ({
            label: e.name,
            description: new Date(e.mtime).toLocaleString(),
          })),
          { placeHolder: 'Pick a team to inspect messages' },
        );
        if (!picked) return;
        TeamConversationPanel.show(ctx, output, cwd, picked.label);
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

  // ─── CCG commands ───
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeLauncher.ccg.focus', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.claude-code-launcher');
      await vscode.commands.executeCommand('claudeCodeLauncher.ccgPanel.focus');
      const snap = ccgProvider.getSnapshot();
      if (snap && snap.pairs.length > 0) {
        CcgViewerPanel.show(ctx, ccgDeps, output, snap.pairs[0].id);
      }
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.ccg.refresh', () => {
      ccgWatcher.forceRefresh();
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.ccg.openPair', (id: unknown) => {
      if (typeof id !== 'string') return;
      CcgViewerPanel.show(ctx, ccgDeps, output, id);
    }),
    vscode.commands.registerCommand('claudeCodeLauncher.ccg.rerun', async () => {
      const snap = ccgProvider.getSnapshot();
      if (!snap || snap.pairs.length === 0) {
        vscode.window.showInformationMessage('Claude: no CCG sessions to re-run yet.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        snap.pairs.map((p) => ({
          label: p.title,
          description: new Date(p.createdAt).toLocaleString(),
          id: p.id,
        })),
        { placeHolder: 'Pick a CCG session to re-run' },
      );
      if (!picked) return;
      const pair = ccgProvider.findPair(picked.id);
      if (pair) await ccgDeps.onRerun(pair);
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
      ccgWatcher.start(next);
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
      ['podium.killSession',                'claudeCodeLauncher.team.kill'],
      ['podium.team.rename',                'claudeCodeLauncher.team.rename'],
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
      ['podium.showCcg',                    'claudeCodeLauncher.ccg.focus'],
      ['podium.refreshCcg',                 'claudeCodeLauncher.ccg.refresh'],
      ['podium.openCcgPair',                'claudeCodeLauncher.ccg.openPair'],
      ['podium.rerunCcg',                   'claudeCodeLauncher.ccg.rerun'],
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

  output.appendLine(`[orch] ready (pollingMs=${pollingMs})`);

  return {
    dispose: () => {
      // Disposables handled via ctx.subscriptions
    },
  };
}

// ─── Helpers ───
function currentCwd(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) return folders[0].uri.fsPath;
  return process.cwd();
}
