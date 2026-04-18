import * as vscode from 'vscode';
import type {
  Mission,
  MissionAgent,
  MissionStatus,
  MissionTimelineEntry,
  SubagentTrackingFile,
} from '../types/mission';
import type { MissionSnapshot } from '../core/MissionWatcher';

class MissionLeaf extends vscode.TreeItem {
  constructor(
    label: string,
    value?: string,
    iconId?: string,
    tooltip?: string | vscode.MarkdownString,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    if (iconId) this.iconPath = new vscode.ThemeIcon(iconId);
    if (tooltip) this.tooltip = tooltip;
    this.contextValue = 'missionLeaf';
  }
}

class MissionSection extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly children: vscode.TreeItem[],
    iconId?: string,
    description?: string,
    collapsed?: boolean,
  ) {
    super(
      label,
      collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
    );
    if (iconId) this.iconPath = new vscode.ThemeIcon(iconId);
    if (description) this.description = description;
    this.contextValue = 'missionSection';
  }
}

export class MissionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private snapshot: MissionSnapshot = { missions: null, subagents: null };

  update(snapshot: MissionSnapshot): void {
    this.snapshot = snapshot;
    this.changeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof MissionSection) return element.children;
    if (element) return [];
    return this.buildRoot();
  }

  private buildRoot(): vscode.TreeItem[] {
    const sections: vscode.TreeItem[] = [];

    const missionsRoot = this.snapshot.missions;
    const subagents = this.snapshot.subagents;

    if (!missionsRoot && !subagents) {
      const empty = new vscode.TreeItem('No mission activity yet');
      empty.description = 'Run /team, /autopilot, /ralph, ultrawork...';
      empty.iconPath = new vscode.ThemeIcon('info');
      return [empty];
    }

    if (subagents) {
      sections.push(this.buildSubagentSummary(subagents));
    }

    const missions = missionsRoot?.missions ?? [];
    if (missions.length === 0) {
      const item = new vscode.TreeItem('No active missions');
      item.description = missionsRoot?.updatedAt ? `(last update ${shortIso(missionsRoot.updatedAt)})` : '';
      item.iconPath = new vscode.ThemeIcon('info');
      sections.push(item);
    } else {
      // Most recent first.
      const sorted = [...missions].sort(
        (a, b) => parseTs(b.updatedAt) - parseTs(a.updatedAt),
      );
      for (const m of sorted) {
        sections.push(this.buildMissionSection(m));
      }
    }

    return sections;
  }

  private buildSubagentSummary(s: SubagentTrackingFile): vscode.TreeItem {
    const children: vscode.TreeItem[] = [];
    if (typeof s.total_spawned === 'number') {
      children.push(new MissionLeaf('Spawned', String(s.total_spawned), 'rocket'));
    }
    if (typeof s.total_completed === 'number') {
      children.push(new MissionLeaf('Completed', String(s.total_completed), 'check'));
    }
    if (typeof s.total_failed === 'number') {
      children.push(
        new MissionLeaf(
          'Failed',
          String(s.total_failed),
          s.total_failed > 0 ? 'error' : 'check-all',
        ),
      );
    }
    if (s.last_updated) {
      children.push(new MissionLeaf('Last update', shortIso(s.last_updated), 'clock'));
    }

    const active = (s.agents ?? []).filter((a) => a.status === 'running' || a.status === 'started');
    if (active.length > 0) {
      const activeChildren = active.map(
        (a) =>
          new MissionLeaf(
            `${a.agent_type ?? 'agent'} · ${a.agent_id.slice(0, 8)}`,
            a.started_at ? `since ${shortIso(a.started_at)}` : undefined,
            'sync~spin',
          ),
      );
      children.push(new MissionSection('Active workers', activeChildren, 'pulse'));
    }

    const header = new MissionSection(
      'Subagent Tracker',
      children,
      'organization',
      `${s.total_spawned ?? 0} spawned`,
      true,
    );
    return header;
  }

  private buildMissionSection(m: Mission): vscode.TreeItem {
    const statusIcon = statusToIcon(m.status);
    const counts = m.taskCounts ?? {};
    const progress = formatProgress(counts);

    const children: vscode.TreeItem[] = [];

    if (m.objective) {
      children.push(new MissionLeaf('Objective', m.objective, 'target'));
    }
    if (m.source || m.name) {
      children.push(
        new MissionLeaf(
          'Source',
          `${m.source ?? '?'} / ${m.name ?? '?'}`,
          'type-hierarchy',
        ),
      );
    }
    if (m.createdAt) children.push(new MissionLeaf('Created', shortIso(m.createdAt), 'history'));
    if (m.updatedAt) children.push(new MissionLeaf('Updated', shortIso(m.updatedAt), 'clock'));
    if (typeof m.workerCount === 'number') {
      children.push(new MissionLeaf('Worker count', String(m.workerCount), 'organization'));
    }

    const taskChildren: vscode.TreeItem[] = [];
    if (typeof counts.total === 'number') {
      taskChildren.push(new MissionLeaf('Total', String(counts.total), 'list-unordered'));
    }
    if (typeof counts.completed === 'number') {
      taskChildren.push(new MissionLeaf('Completed', String(counts.completed), 'check'));
    }
    if (typeof counts.inProgress === 'number') {
      taskChildren.push(
        new MissionLeaf(
          'In progress',
          String(counts.inProgress),
          counts.inProgress > 0 ? 'sync~spin' : 'sync',
        ),
      );
    }
    if (typeof counts.pending === 'number') {
      taskChildren.push(new MissionLeaf('Pending', String(counts.pending), 'circle-outline'));
    }
    if (typeof counts.blocked === 'number' && counts.blocked > 0) {
      taskChildren.push(new MissionLeaf('Blocked', String(counts.blocked), 'error'));
    }
    if (typeof counts.failed === 'number' && counts.failed > 0) {
      taskChildren.push(new MissionLeaf('Failed', String(counts.failed), 'error'));
    }
    if (taskChildren.length > 0) {
      children.push(new MissionSection('Tasks', taskChildren, 'checklist', progress, true));
    }

    const agents = m.agents ?? [];
    if (agents.length > 0) {
      const agentChildren = agents.map((a) => this.buildAgentLeaf(a));
      const doneCount = agents.filter((a) => a.status === 'done').length;
      children.push(
        new MissionSection('Agents', agentChildren, 'account', `${doneCount}/${agents.length}`, true),
      );
    }

    const timeline = m.timeline ?? [];
    if (timeline.length > 0) {
      const recent = [...timeline]
        .sort((a, b) => parseTs(b.at) - parseTs(a.at))
        .slice(0, 8)
        .map((t) => this.buildTimelineLeaf(t));
      children.push(
        new MissionSection(
          'Timeline',
          recent,
          'history',
          `latest ${Math.min(timeline.length, 8)}/${timeline.length}`,
          true,
        ),
      );
    }

    const label = m.name && m.name !== 'none' ? m.name : m.source ?? 'mission';
    return new MissionSection(label, children, statusIcon, progress);
  }

  private buildAgentLeaf(a: MissionAgent): vscode.TreeItem {
    const status = a.status ?? 'unknown';
    const icon = agentStatusIcon(status);
    const step = a.currentStep || a.latestUpdate || '';
    const tooltip = buildAgentTooltip(a);
    return new MissionLeaf(a.name, step, icon, tooltip);
  }

  private buildTimelineLeaf(t: MissionTimelineEntry): vscode.TreeItem {
    const icon = timelineKindIcon(t.kind);
    const desc = `${t.agent ?? ''}${t.detail ? ' · ' + t.detail : ''}`.trim();
    return new MissionLeaf(shortIso(t.at), desc, icon, `${t.kind ?? ''} @ ${t.at}`);
  }
}

function statusToIcon(status?: MissionStatus): string {
  switch (status) {
    case 'done':
      return 'check';
    case 'failed':
      return 'error';
    case 'in-progress':
      return 'sync~spin';
    case 'pending':
      return 'circle-outline';
    default:
      return 'target';
  }
}

function agentStatusIcon(status: string): string {
  switch (status) {
    case 'done':
      return 'pass';
    case 'failed':
      return 'error';
    case 'in-progress':
    case 'running':
    case 'started':
      return 'sync~spin';
    default:
      return 'circle-outline';
  }
}

function timelineKindIcon(kind?: string): string {
  switch (kind) {
    case 'completion':
      return 'pass';
    case 'update':
      return 'arrow-right';
    case 'error':
    case 'failure':
      return 'error';
    default:
      return 'primitive-dot';
  }
}

function formatProgress(counts: { total?: number; completed?: number; failed?: number }): string {
  const total = counts.total ?? 0;
  const completed = counts.completed ?? 0;
  if (total === 0) return '';
  if (counts.failed && counts.failed > 0) {
    return `${completed}/${total} (${counts.failed}✗)`;
  }
  return `${completed}/${total}`;
}

function parseTs(iso?: string): number {
  if (!iso) return 0;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? 0 : n;
}

function shortIso(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function buildAgentTooltip(a: MissionAgent): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${a.name}**\n\n`);
  if (a.role) md.appendMarkdown(`- role: ${a.role}\n`);
  if (a.status) md.appendMarkdown(`- status: ${a.status}\n`);
  if (a.currentStep) md.appendMarkdown(`- step: ${a.currentStep}\n`);
  if (a.latestUpdate) md.appendMarkdown(`- last: ${a.latestUpdate}\n`);
  if (a.completedSummary) md.appendMarkdown(`- summary: ${a.completedSummary}\n`);
  if (a.updatedAt) md.appendMarkdown(`- updatedAt: ${a.updatedAt}\n`);
  if (a.ownership) md.appendMarkdown(`- ownership: \`${a.ownership}\`\n`);
  return md;
}
