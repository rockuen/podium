import * as vscode from 'vscode';
import type { HUDStdinCache } from '../types/hud';
import { COLOR_IDS } from './colors';

class HUDLeaf extends vscode.TreeItem {
  constructor(label: string, value: string | undefined, iconId?: string, tooltip?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = value;
    if (iconId) this.iconPath = new vscode.ThemeIcon(iconId);
    if (tooltip) this.tooltip = tooltip;
    this.contextValue = 'hudLeaf';
  }
}

class HUDSection extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly children: vscode.TreeItem[],
    iconId?: string,
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    if (iconId) this.iconPath = new vscode.ThemeIcon(iconId);
    this.contextValue = 'hudSection';
  }
}

export class HUDTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private hud: HUDStdinCache | null = null;

  update(hud: HUDStdinCache | null): void {
    this.hud = hud;
    this.changeEmitter.fire();
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element instanceof HUDSection) return element.children;
    if (element) return [];
    return this.buildRoot();
  }

  private buildRoot(): vscode.TreeItem[] {
    if (!this.hud) {
      const empty = new vscode.TreeItem('No HUD state found');
      empty.description = 'Claude not running, or .omc/state/ not yet populated';
      empty.iconPath = new vscode.ThemeIcon('info');
      return [empty];
    }

    const sections: vscode.TreeItem[] = [];

    // Session
    const sessionChildren: vscode.TreeItem[] = [];
    if (this.hud.session_id) {
      sessionChildren.push(
        new HUDLeaf('ID', this.hud.session_id.slice(0, 8), 'key', this.hud.session_id),
      );
    }
    if (this.hud.model?.display_name || this.hud.model?.id) {
      const leaf = new HUDLeaf(
        'Model',
        this.hud.model.display_name || this.hud.model.id,
        'sparkle',
        this.hud.model.id,
      );
      // claude session → brand color accent
      leaf.iconPath = new vscode.ThemeIcon(
        'sparkle',
        new vscode.ThemeColor(COLOR_IDS.claude),
      );
      sessionChildren.push(leaf);
    }
    if (this.hud.cwd) sessionChildren.push(new HUDLeaf('cwd', this.hud.cwd, 'folder'));
    if (this.hud.version) sessionChildren.push(new HUDLeaf('Claude version', this.hud.version, 'versions'));
    if (this.hud.output_style?.name) {
      sessionChildren.push(new HUDLeaf('Output style', this.hud.output_style.name, 'symbol-color'));
    }
    if (sessionChildren.length > 0) {
      sections.push(new HUDSection('Session', sessionChildren, 'account'));
    }

    // Context
    if (this.hud.context_window) {
      const cw = this.hud.context_window;
      const ctxChildren: vscode.TreeItem[] = [];
      if (typeof cw.used_percentage === 'number') {
        const leaf = new HUDLeaf('Used', `${cw.used_percentage}%`, 'graph');
        leaf.iconPath = new vscode.ThemeIcon(
          'graph',
          new vscode.ThemeColor(
            cw.used_percentage >= 85
              ? COLOR_IDS.statusFailed
              : cw.used_percentage >= 60
              ? COLOR_IDS.statusRunning
              : COLOR_IDS.statusDone,
          ),
        );
        ctxChildren.push(leaf);
      }
      if (typeof cw.remaining_percentage === 'number') {
        ctxChildren.push(new HUDLeaf('Remaining', `${cw.remaining_percentage}%`, 'graph-line'));
      }
      if (typeof cw.context_window_size === 'number') {
        ctxChildren.push(
          new HUDLeaf(
            'Window size',
            `${Math.round(cw.context_window_size / 1000)}K`,
            'symbol-namespace',
            `${cw.context_window_size.toLocaleString()} tokens`,
          ),
        );
      }
      if (typeof cw.total_input_tokens === 'number') {
        ctxChildren.push(
          new HUDLeaf('Input tokens', cw.total_input_tokens.toLocaleString(), 'arrow-down'),
        );
      }
      if (typeof cw.total_output_tokens === 'number') {
        ctxChildren.push(
          new HUDLeaf('Output tokens', cw.total_output_tokens.toLocaleString(), 'arrow-up'),
        );
      }
      if (cw.current_usage) {
        const cu = cw.current_usage;
        const cacheParts: string[] = [];
        if (typeof cu.cache_read_input_tokens === 'number') {
          cacheParts.push(`read ${cu.cache_read_input_tokens.toLocaleString()}`);
        }
        if (typeof cu.cache_creation_input_tokens === 'number') {
          cacheParts.push(`create ${cu.cache_creation_input_tokens.toLocaleString()}`);
        }
        if (cacheParts.length > 0) {
          ctxChildren.push(new HUDLeaf('Cache (current)', cacheParts.join(' · '), 'database'));
        }
      }
      if (ctxChildren.length > 0) {
        sections.push(new HUDSection('Context', ctxChildren, 'symbol-string'));
      }
    }

    // Cost
    if (this.hud.cost) {
      const cost = this.hud.cost;
      const costChildren: vscode.TreeItem[] = [];
      if (typeof cost.total_cost_usd === 'number') {
        costChildren.push(new HUDLeaf('Total', `$${cost.total_cost_usd.toFixed(4)}`, 'database'));
      }
      if (typeof cost.total_duration_ms === 'number') {
        costChildren.push(
          new HUDLeaf('Session duration', formatDuration(cost.total_duration_ms), 'clock'),
        );
      }
      if (typeof cost.total_api_duration_ms === 'number') {
        costChildren.push(
          new HUDLeaf('API time', formatDuration(cost.total_api_duration_ms), 'dashboard'),
        );
      }
      if (typeof cost.total_lines_added === 'number' || typeof cost.total_lines_removed === 'number') {
        costChildren.push(
          new HUDLeaf(
            'Lines',
            `+${cost.total_lines_added ?? 0} / -${cost.total_lines_removed ?? 0}`,
            'diff',
          ),
        );
      }
      if (costChildren.length > 0) {
        sections.push(new HUDSection('Cost', costChildren, 'credit-card'));
      }
    }

    // Rate Limits
    if (this.hud.rate_limits) {
      const rl = this.hud.rate_limits;
      const rlChildren: vscode.TreeItem[] = [];
      if (rl.five_hour) {
        rlChildren.push(
          new HUDLeaf(
            '5 hour',
            formatLimit(rl.five_hour.used_percentage, rl.five_hour.resets_at),
            'watch',
          ),
        );
      }
      if (rl.seven_day) {
        rlChildren.push(
          new HUDLeaf(
            '7 day',
            formatLimit(rl.seven_day.used_percentage, rl.seven_day.resets_at),
            'calendar',
          ),
        );
      }
      if (rlChildren.length > 0) {
        sections.push(new HUDSection('Rate Limits', rlChildren, 'law'));
      }
    }

    return sections;
  }
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

function formatLimit(used?: number, resetsAt?: number): string | undefined {
  if (typeof used !== 'number') return undefined;
  let out = `${used}%`;
  if (typeof resetsAt === 'number') {
    const d = new Date(resetsAt * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    out += ` (resets ${hh}:${mm})`;
  }
  return out;
}
