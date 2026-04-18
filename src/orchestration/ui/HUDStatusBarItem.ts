import * as vscode from 'vscode';
import type { HUDStdinCache } from '../types/hud';
import { COLOR_IDS } from './colors';

export class HUDStatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Podium HUD';
    this.item.command = 'podium.showHud';
    this.setIdle();
  }

  update(hud: HUDStdinCache | null): void {
    if (!hud) {
      this.setIdle();
      return;
    }

    const parts: string[] = [];
    const model = shortModel(hud.model?.display_name || hud.model?.id);
    if (model) parts.push(`$(sparkle) ${model}`);

    const ctxPct = hud.context_window?.used_percentage;
    if (typeof ctxPct === 'number') {
      parts.push(`$(graph) ${ctxPct}%`);
    }

    const cost = hud.cost?.total_cost_usd;
    if (typeof cost === 'number') {
      parts.push(`$(database) ${formatUsd(cost)}`);
    }

    const fh = hud.rate_limits?.five_hour?.used_percentage;
    if (typeof fh === 'number') {
      parts.push(`$(clock) 5h:${fh}%`);
    }

    this.item.text = parts.length > 0 ? parts.join('  ') : '$(organization) Podium';
    this.item.tooltip = buildTooltip(hud);
    this.item.color = new vscode.ThemeColor(
      typeof ctxPct === 'number' && ctxPct >= 85
        ? COLOR_IDS.statusFailed
        : typeof ctxPct === 'number' && ctxPct >= 60
        ? COLOR_IDS.statusRunning
        : COLOR_IDS.omc,
    );
    this.item.show();
  }

  private setIdle(): void {
    this.item.text = '$(organization) Podium';
    this.item.tooltip = 'Podium — no Claude HUD state detected yet';
    this.item.color = new vscode.ThemeColor(COLOR_IDS.statusIdle);
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function shortModel(name?: string): string | undefined {
  if (!name) return undefined;
  const cleaned = name.replace(/\s*\(.*?\)\s*/g, '').replace(/^claude-/i, '').trim();
  return cleaned || name;
}

function formatUsd(v: number): string {
  if (v < 10) return `$${v.toFixed(2)}`;
  if (v < 100) return `$${v.toFixed(1)}`;
  return `$${Math.round(v)}`;
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

function formatResetClock(unix?: number): string | undefined {
  if (typeof unix !== 'number') return undefined;
  const d = new Date(unix * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function buildTooltip(hud: HUDStdinCache): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**Podium HUD**\n\n`);

  if (hud.model?.display_name) {
    md.appendMarkdown(`- $(sparkle) Model: \`${hud.model.display_name}\`\n`);
  }
  if (hud.session_id) {
    md.appendMarkdown(`- $(key) Session: \`${hud.session_id.slice(0, 8)}\`\n`);
  }

  if (hud.context_window) {
    const cw = hud.context_window;
    const windowK =
      typeof cw.context_window_size === 'number'
        ? `${Math.round(cw.context_window_size / 1000)}K`
        : '?';
    md.appendMarkdown(
      `- $(graph) Context: ${cw.used_percentage ?? '?'}% of ${windowK}` +
        (typeof cw.total_input_tokens === 'number'
          ? ` · in ${cw.total_input_tokens.toLocaleString()}, out ${(cw.total_output_tokens ?? 0).toLocaleString()}`
          : '') +
        `\n`,
    );
  }

  if (hud.cost) {
    if (typeof hud.cost.total_cost_usd === 'number') {
      md.appendMarkdown(`- $(database) Cost: $${hud.cost.total_cost_usd.toFixed(4)}\n`);
    }
    if (typeof hud.cost.total_duration_ms === 'number') {
      md.appendMarkdown(
        `- $(clock) Session duration: ${formatDuration(hud.cost.total_duration_ms)}` +
          (typeof hud.cost.total_api_duration_ms === 'number'
            ? ` (API ${formatDuration(hud.cost.total_api_duration_ms)})`
            : '') +
          `\n`,
      );
    }
  }

  if (hud.rate_limits) {
    const rl = hud.rate_limits;
    if (rl.five_hour) {
      md.appendMarkdown(
        `- $(watch) 5h limit: ${rl.five_hour.used_percentage ?? '?'}%` +
          (formatResetClock(rl.five_hour.resets_at)
            ? ` (resets at ${formatResetClock(rl.five_hour.resets_at)})`
            : '') +
          `\n`,
      );
    }
    if (rl.seven_day) {
      md.appendMarkdown(
        `- $(calendar) 7d limit: ${rl.seven_day.used_percentage ?? '?'}%\n`,
      );
    }
  }

  md.appendMarkdown(`\n_Click to open Podium HUD._`);
  return md;
}
