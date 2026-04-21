import * as vscode from 'vscode';
import { SessionDetector, DetectedSession } from '../core/SessionDetector';
import type { TmuxPane } from '../backends/IMultiplexerBackend';
import { agentThemeIcon, detectAgent, COLOR_IDS } from './colors';

type Node = SessionNode | PaneNode | EmptyNode | ErrorNode;

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

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly detector: SessionDetector) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      try {
        const detected = await this.detector.detect();
        if (detected.length === 0) {
          return [new EmptyNode(this.detector.getPrefix(), this.detector.getNameFilter())];
        }
        return detected.map((d) => new SessionNode(d));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return [new ErrorNode(msg)];
      }
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
