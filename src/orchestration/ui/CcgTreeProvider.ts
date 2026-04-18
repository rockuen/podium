import * as vscode from 'vscode';
import type { CcgPair, CcgSnapshot } from '../types/ccg';
import { COLOR_IDS } from './colors';

export class CcgPairNode extends vscode.TreeItem {
  readonly kind = 'pair' as const;

  constructor(public readonly pair: CcgPair) {
    super(pair.title, vscode.TreeItemCollapsibleState.None);
    const providers = [
      pair.codex ? 'codex' : null,
      pair.gemini ? 'gemini' : null,
      pair.claude ? 'claude' : null,
    ].filter((p): p is string => p !== null);
    this.description = `${formatRelative(pair.createdAt)} · ${providers.join('+')}`;
    this.iconPath = iconForPair(pair);
    this.contextValue = 'ccgPair';
    this.tooltip = buildTooltip(pair);
    this.command = {
      command: 'podium.openCcgPair',
      title: 'Open CCG pair',
      arguments: [pair.id],
    };
  }
}

export class CcgTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private snapshot: CcgSnapshot | null = null;

  update(snapshot: CcgSnapshot): void {
    this.snapshot = snapshot;
    this.changeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element) return [];
    const snap = this.snapshot;
    if (!snap) {
      const item = new vscode.TreeItem('Scanning...');
      item.iconPath = new vscode.ThemeIcon('sync~spin');
      return [item];
    }
    if (snap.pairs.length === 0) {
      const item = new vscode.TreeItem('No CCG sessions yet');
      item.description = 'Run /ccg "<question>"';
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }
    return snap.pairs.map((p) => new CcgPairNode(p));
  }

  getSnapshot(): CcgSnapshot | null {
    return this.snapshot;
  }

  findPair(id: string): CcgPair | null {
    return this.snapshot?.pairs.find((p) => p.id === id) ?? null;
  }
}

function iconForPair(pair: CcgPair): vscode.ThemeIcon {
  if (pair.codex && pair.gemini) {
    return new vscode.ThemeIcon('git-compare', new vscode.ThemeColor(COLOR_IDS.omc));
  }
  if (pair.codex) {
    return new vscode.ThemeIcon('terminal', new vscode.ThemeColor(COLOR_IDS.codex));
  }
  if (pair.gemini) {
    return new vscode.ThemeIcon('star-full', new vscode.ThemeColor(COLOR_IDS.gemini));
  }
  return new vscode.ThemeIcon('sparkle', new vscode.ThemeColor(COLOR_IDS.claude));
}

function buildTooltip(pair: CcgPair): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${pair.title}**\n\n`);
  md.appendMarkdown(`- $(calendar) ${new Date(pair.createdAt).toLocaleString()}\n`);
  if (pair.codex) {
    md.appendMarkdown(`- $(terminal) codex · exit ${pair.codex.exitCode ?? '?'}\n`);
  }
  if (pair.gemini) {
    md.appendMarkdown(`- $(star-full) gemini · exit ${pair.gemini.exitCode ?? '?'}\n`);
  }
  if (pair.claude) {
    md.appendMarkdown(`- $(sparkle) claude synthesis\n`);
  }
  return md;
}

function formatRelative(ts: number): string {
  const now = Date.now();
  const delta = now - ts;
  const abs = Math.abs(delta);
  if (abs < 60 * 1000) return delta < 0 ? 'in a moment' : 'just now';
  const mins = Math.floor(abs / 60000);
  if (mins < 60) return delta < 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return delta < 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return delta < 0 ? `in ${days}d` : `${days}d ago`;
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}
