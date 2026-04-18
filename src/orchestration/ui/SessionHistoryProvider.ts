import * as vscode from 'vscode';
import type {
  SessionHistoryEntry,
  SessionHistorySnapshot,
} from '../types/history';

class HistoryLeaf extends vscode.TreeItem {
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
    this.contextValue = 'historyLeaf';
  }
}

class HistoryEntryNode extends vscode.TreeItem {
  constructor(
    public readonly entry: SessionHistoryEntry,
    public readonly isActive: boolean,
  ) {
    super(entry.sessionId.slice(0, 8), vscode.TreeItemCollapsibleState.Collapsed);
    this.description = isActive ? 'active' : entryShortStatus(entry);
    this.iconPath = new vscode.ThemeIcon(
      isActive ? 'circle-filled' : entry.hasCancelSignal ? 'circle-slash' : 'circle-outline',
    );
    this.tooltip = buildEntryTooltip(entry, isActive);
    this.contextValue = isActive ? 'historyEntryActive' : 'historyEntry';
  }
}

export class SessionHistoryProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private snapshot: SessionHistorySnapshot | null = null;

  update(snapshot: SessionHistorySnapshot): void {
    this.snapshot = snapshot;
    this.changeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof HistoryEntryNode) {
      return this.buildEntryDetails(element.entry, element.isActive);
    }
    if (element) return [];

    const snap = this.snapshot;
    if (!snap) {
      const item = new vscode.TreeItem('Scanning...');
      item.iconPath = new vscode.ThemeIcon('sync~spin');
      return [item];
    }
    if (snap.entries.length === 0) {
      const item = new vscode.TreeItem('No sessions found');
      item.description = 'Nothing in .omc/state/sessions yet';
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    return snap.entries.map(
      (e) => new HistoryEntryNode(e, snap.activeSessionId === e.sessionId),
    );
  }

  getSnapshot(): SessionHistorySnapshot | null {
    return this.snapshot;
  }

  private buildEntryDetails(
    entry: SessionHistoryEntry,
    isActive: boolean,
  ): vscode.TreeItem[] {
    const kids: vscode.TreeItem[] = [];

    kids.push(new HistoryLeaf('Full ID', entry.sessionId, 'key', entry.sessionId));

    const started = entry.hud?.sessionStartTimestamp;
    const updated = entry.hud?.timestamp;
    if (started) kids.push(new HistoryLeaf('Started', formatRelative(started), 'history', started));
    if (updated) kids.push(new HistoryLeaf('Last update', formatRelative(updated), 'clock', updated));
    if (started && updated) {
      const dur = Date.parse(updated) - Date.parse(started);
      if (Number.isFinite(dur) && dur > 0) {
        kids.push(new HistoryLeaf('Duration', formatDuration(dur), 'watch'));
      }
    }

    const bgCount = entry.hud?.backgroundTasks?.length ?? 0;
    kids.push(
      new HistoryLeaf(
        'Background tasks',
        String(bgCount),
        bgCount > 0 ? 'tasklist' : 'list-unordered',
      ),
    );

    if (entry.modes.length > 0) {
      kids.push(new HistoryLeaf('Modes', entry.modes.join(', '), 'rocket'));
    }

    if (entry.hasCancelSignal) {
      kids.push(new HistoryLeaf('Cancel signal', 'set', 'circle-slash'));
    }

    kids.push(
      new HistoryLeaf(
        'Directory',
        entry.directory,
        'folder',
        `${entry.directory}\n\nFiles: ${Object.keys(entry.fileMtimes).join(', ')}`,
      ),
    );

    if (isActive) {
      kids.push(
        new HistoryLeaf(
          'Status',
          'active',
          'circle-filled',
          'This is the session currently mirrored by hud-stdin-cache.json',
        ),
      );
    }

    return kids;
  }
}

function entryShortStatus(entry: SessionHistoryEntry): string {
  if (entry.hasCancelSignal) return 'cancelled';
  if (entry.modes.length > 0) return entry.modes.join('/');
  const updated = entry.hud?.timestamp;
  if (updated) return formatRelative(updated);
  return 'inactive';
}

function buildEntryTooltip(
  entry: SessionHistoryEntry,
  isActive: boolean,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${entry.sessionId}**\n\n`);
  if (isActive) md.appendMarkdown(`- $(circle-filled) **active session**\n`);
  if (entry.hud?.sessionStartTimestamp) {
    md.appendMarkdown(`- $(history) started: ${entry.hud.sessionStartTimestamp}\n`);
  }
  if (entry.hud?.timestamp) {
    md.appendMarkdown(`- $(clock) last update: ${entry.hud.timestamp}\n`);
  }
  if (entry.modes.length > 0) {
    md.appendMarkdown(`- $(rocket) modes: ${entry.modes.join(', ')}\n`);
  }
  if (entry.hasCancelSignal) {
    md.appendMarkdown(`- $(circle-slash) cancel signal set\n`);
  }
  const bgCount = entry.hud?.backgroundTasks?.length ?? 0;
  md.appendMarkdown(`- $(tasklist) background tasks: ${bgCount}\n`);
  return md;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const now = Date.now();
  const delta = now - t;
  const abs = Math.abs(delta);
  if (abs < 60 * 1000) return delta < 0 ? 'in a moment' : 'just now';
  const mins = Math.floor(abs / 60000);
  if (mins < 60) return delta < 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return delta < 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return delta < 0 ? `in ${days}d` : `${days}d ago`;
  const d = new Date(t);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
