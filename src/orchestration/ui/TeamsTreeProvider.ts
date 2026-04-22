import * as vscode from 'vscode';
import { SessionDetector, DetectedSession } from '../core/SessionDetector';
import type { TmuxPane } from '../backends/IMultiplexerBackend';
import { agentThemeIcon, detectAgent, COLOR_IDS } from './colors';
import type { PodiumOrchestrator, WorkerConfig } from '../core/PodiumOrchestrator';

type Node = SessionNode | PaneNode | EmptyNode | ErrorNode | PodiumLiveTeamNode | WorkerTreeItem;

export class SessionNode extends vscode.TreeItem {
  readonly kind = 'session' as const;

  constructor(public readonly detected: DetectedSession) {
    super(detected.session.name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'omcSession';
    const attached = detected.session.attached ? ' · attached' : '';
    const mix = summarizeAgents(detected.panes);
    // v2.6.37: tag inline teams so users can tell apart an `omc-team-*`
    // standalone session from a `/team`-split leader session.
    const inlineTag = detected.kind === 'podium-inline' ? ' · inline' : '';
    this.description = `${detected.panes.length} pane${detected.panes.length === 1 ? '' : 's'}${mix}${attached}${inlineTag}`;
    this.iconPath = new vscode.ThemeIcon(
      'organization',
      new vscode.ThemeColor(COLOR_IDS.omc),
    );
    this.tooltip = buildSessionTooltip(detected);
  }
}

export class PaneNode extends vscode.TreeItem {
  readonly kind = 'pane' as const;

  constructor(public readonly pane: TmuxPane) {
    super(paneLabel(pane), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'omcPane';
    const agent = detectAgent(pane.currentCommand, pane.title);
    this.description = pane.currentCommand || '';
    this.iconPath = agentThemeIcon(agent);
    this.tooltip = `${pane.paneId} · window ${pane.windowIndex}\nagent: ${agent}\npid: ${pane.pid ?? 'n/a'}\ncmd: ${pane.currentCommand || '-'}`;
  }
}

class EmptyNode extends vscode.TreeItem {
  readonly kind = 'empty' as const;

  constructor(prefix: string, nameFilter: string) {
    // v2.6.37: detector now also picks up podium-leader-* sessions with ≥2
    // panes (inline /team), so the "no sessions" label shouldn't name only
    // the omc-team- prefix.
    const label = nameFilter
      ? `No team sessions matching "${nameFilter}"`
      : prefix
        ? `No team sessions (checked "${prefix}*" and "podium-leader-*" with ≥2 panes)`
        : 'No team sessions found';
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'omcEmpty';
  }
}

class ErrorNode extends vscode.TreeItem {
  readonly kind = 'error' as const;

  constructor(message: string) {
    super('Multiplexer error', vscode.TreeItemCollapsibleState.None);
    this.description = message;
    this.iconPath = new vscode.ThemeIcon('warning');
    this.contextValue = 'omcError';
    this.tooltip = message;
  }
}

/**
 * v2.7.25 · Top-level node representing a running PodiumOrchestrator keyed by
 * `sessionKey`. Children are the orchestrator's current workers. Exposes
 * `sessionKey` + `orch` as public readonly fields so the Step 8 command
 * handlers (Add/Remove/Rename) can route through the correct orchestrator
 * when dispatched from a tree-item context menu. `contextValue` matches the
 * `view/item/context` `when` clause introduced by Step 7's `package.json`.
 */
export class PodiumLiveTeamNode extends vscode.TreeItem {
  readonly kind = 'podiumLiveTeam' as const;

  constructor(
    public readonly sessionKey: string,
    public readonly orch: PodiumOrchestrator,
  ) {
    super(sessionKey, vscode.TreeItemCollapsibleState.Expanded);
    this.iconPath = new vscode.ThemeIcon('organization');
    this.contextValue = 'podiumLiveTeam';
    this.tooltip = `sessionKey=${sessionKey} · workers=${orch.listWorkers().length}`;
  }
}

/**
 * v2.7.25 · Leaf node representing one worker under a `PodiumLiveTeamNode`.
 * Carries `sessionKey` + `workerId` so the context-menu command handlers can
 * look up the orchestrator and target worker without ambiguity when multiple
 * orchestrators run concurrently. `contextValue` matches the Remove/Rename
 * `view/item/context` clauses.
 */
export class WorkerTreeItem extends vscode.TreeItem {
  readonly kind = 'podiumWorker' as const;

  constructor(
    public readonly sessionKey: string,
    public readonly workerId: string,
    public readonly cfg: WorkerConfig,
  ) {
    super(cfg.label ?? workerId, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('person');
    this.contextValue = 'podiumWorker';
    this.tooltip = `id=${cfg.id} paneId=${cfg.paneId} agent=${cfg.agent} session=${sessionKey}`;
    // When the user renamed the worker (label differs from the raw id), show
    // the raw id next to the label so routing keys remain visible.
    this.description = workerId !== (cfg.label ?? workerId) ? workerId : undefined;
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly detector: SessionDetector,
    // v2.7.25 · Registry of active runtime orchestrators, keyed by sessionKey.
    // Rendered as top-level `PodiumLiveTeamNode` entries ahead of the tmux
    // `SessionNode` entries. Refresh is driven explicitly by the Step 8
    // command handlers after each add/remove/rename mutation.
    private readonly orchestratorRegistry: Map<string, PodiumOrchestrator>,
  ) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      // v2.7.25 · Live Podium orchestrators render above the tmux session list.
      // v2.7.27 · Skip entries whose orchestrator has already been torn down
      // — the registry should get cleaned up via `panel.onDidDispose`, but
      // this belt-and-suspenders filter keeps the tree sane even if an
      // orchestrator dies without the cleanup subscription firing.
      const liveTeams: Node[] = [...this.orchestratorRegistry.entries()]
        .filter(([, orch]) => !orch.isDisposed)
        .map(([key, orch]) => new PodiumLiveTeamNode(key, orch));
      try {
        const detected = await this.detector.detect();
        if (detected.length === 0) {
          // Preserve existing empty-state UX for the tmux section; any live
          // Podium teams still show above it.
          return [...liveTeams, new EmptyNode(this.detector.getPrefix(), this.detector.getNameFilter())];
        }
        const existingTmuxNodes = detected.map((d) => new SessionNode(d));
        return [...liveTeams, ...existingTmuxNodes];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [...liveTeams, new ErrorNode(msg)];
      }
    }
    if (element instanceof PodiumLiveTeamNode) {
      return element.orch
        .listWorkers()
        .map((w) => new WorkerTreeItem(element.sessionKey, w.cfg.id, w.cfg));
    }
    if (element.kind === 'session') {
      return element.detected.panes.map((p) => new PaneNode(p));
    }
    return [];
  }

  async killSession(item: unknown): Promise<void> {
    if (!(item instanceof SessionNode)) {
      return;
    }
    const name = item.detected.session.name;
    const answer = await vscode.window.showWarningMessage(
      `Kill session "${name}"?`,
      { modal: true },
      'Kill',
    );
    if (answer !== 'Kill') return;
    try {
      await this.detector.killSession(name);
      vscode.window.showInformationMessage(`Podium: killed session ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Podium: failed to kill ${name} — ${msg}`);
    }
    this.refresh();
  }
}

function paneLabel(pane: TmuxPane): string {
  if (pane.title && pane.title !== pane.currentCommand) {
    return pane.title;
  }
  return `${pane.paneId} · w${pane.windowIndex}`;
}

function summarizeAgents(panes: TmuxPane[]): string {
  const counts: Record<string, number> = {};
  for (const p of panes) {
    const a = detectAgent(p.currentCommand, p.title);
    counts[a] = (counts[a] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const k of ['claude', 'codex', 'gemini', 'shell', 'unknown']) {
    const n = counts[k];
    if (n && (k === 'claude' || k === 'codex' || k === 'gemini')) {
      parts.push(`${n} ${k}`);
    }
  }
  return parts.length > 0 ? ` · ${parts.join(', ')}` : '';
}

function buildSessionTooltip(d: DetectedSession): string {
  const createdAt = d.session.createdAtUnix
    ? new Date(d.session.createdAtUnix * 1000).toISOString()
    : 'unknown';
  return [
    `session: ${d.session.name}`,
    `windows: ${d.session.windowCount}`,
    `attached: ${d.session.attached}`,
    `created: ${createdAt}`,
    `panes: ${d.panes.length}`,
  ].join('\n');
}

/**
 * v2.7.25 · Canonical export name matching the Phase 4.B plan terminology.
 * `index.ts` currently imports `SessionTreeProvider as TeamsTreeProvider`;
 * Step 8 updates that callsite to import `TeamsTreeProvider` directly.
 */
export { SessionTreeProvider as TeamsTreeProvider };
