import * as vscode from 'vscode';
import type { PodiumOrchestrator, WorkerConfig } from '../core/PodiumOrchestrator';

type Node = PodiumLiveTeamNode | WorkerTreeItem | EmptyNode;

class EmptyNode extends vscode.TreeItem {
  readonly kind = 'empty' as const;

  constructor() {
    super('No Podium teams are running yet.', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'podiumEmpty';
  }
}

/**
 * Top-level node representing a running PodiumOrchestrator keyed by
 * `sessionKey`. Children are the orchestrator's current workers.
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
 * Leaf node representing one worker under a PodiumLiveTeamNode. Carries
 * `sessionKey` + `workerId` so the context-menu command handlers can look up
 * the orchestrator and target worker without ambiguity when multiple
 * orchestrators run concurrently.
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
    this.description = workerId !== (cfg.label ?? workerId) ? workerId : undefined;
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
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
      const liveTeams: Node[] = [...this.orchestratorRegistry.entries()]
        .filter(([, orch]) => !orch.isDisposed)
        .map(([key, orch]) => new PodiumLiveTeamNode(key, orch));
      if (liveTeams.length === 0) return [new EmptyNode()];
      return liveTeams;
    }
    if (element instanceof PodiumLiveTeamNode) {
      return element.orch
        .listWorkers()
        .map((w) => new WorkerTreeItem(element.sessionKey, w.cfg.id, w.cfg));
    }
    return [];
  }
}

export { SessionTreeProvider as TeamsTreeProvider };
