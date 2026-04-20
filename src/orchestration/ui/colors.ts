import * as vscode from 'vscode';

/**
 * Podium brand palette — aligned with Pencil design mockup
 * (designs/omc-ide-mockup.pen). Exposed via VSCode theme colors so
 * dark/light/high-contrast variants live in package.json:contributes.colors.
 */
export const COLOR_IDS = {
  claude: 'podium.agent.claude',
  codex: 'podium.agent.codex',
  gemini: 'podium.agent.gemini',
  omc: 'podium.brand.omc',
  statusRunning: 'podium.status.running',
  statusDone: 'podium.status.done',
  statusFailed: 'podium.status.failed',
  statusCancelled: 'podium.status.cancelled',
  statusIdle: 'podium.status.idle',
} as const;

export const HEX = {
  claude: '#C084FC',
  codex: '#10B981',
  gemini: '#60A5FA',
  omc: '#FB923C',
  statusRunning: '#FACC15',
  statusDone: '#22C55E',
  statusFailed: '#EF4444',
  statusCancelled: '#9CA3AF',
  statusIdle: '#6B7280',
} as const;

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'shell' | 'unknown';

const AGENT_CMD_PATTERNS: Array<{ kind: AgentKind; re: RegExp }> = [
  { kind: 'claude', re: /\bclaude(?:\.cmd|\.exe)?\b/i },
  { kind: 'codex', re: /\bcodex(?:\.cmd|\.exe)?\b/i },
  // Gemini CLI runs through its node-based MCP server on Windows/macOS.
  { kind: 'gemini', re: /\bgemini\b|mcp-server-windows|mcp-server-mac/i },
  { kind: 'shell', re: /^(cmd|powershell|pwsh|bash|zsh|sh|fish|wsl)(\.exe)?$/i },
];

export function detectAgent(command: string | undefined, title?: string): AgentKind {
  const src = `${command ?? ''} ${title ?? ''}`;
  for (const { kind, re } of AGENT_CMD_PATTERNS) {
    if (re.test(src)) return kind;
  }
  return 'unknown';
}

export function agentDisplayName(kind: AgentKind): string {
  switch (kind) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'shell':
      return 'shell';
    default:
      return 'agent';
  }
}

export function agentIconId(kind: AgentKind): string {
  switch (kind) {
    case 'claude':
      return 'sparkle';
    case 'codex':
      return 'code';
    case 'gemini':
      return 'star-full';
    case 'shell':
      return 'terminal-bash';
    default:
      return 'terminal';
  }
}

export function agentColorId(kind: AgentKind): string | undefined {
  switch (kind) {
    case 'claude':
      return COLOR_IDS.claude;
    case 'codex':
      return COLOR_IDS.codex;
    case 'gemini':
      return COLOR_IDS.gemini;
    default:
      return undefined;
  }
}

export function agentHex(kind: AgentKind): string {
  switch (kind) {
    case 'claude':
      return HEX.claude;
    case 'codex':
      return HEX.codex;
    case 'gemini':
      return HEX.gemini;
    default:
      return HEX.statusIdle;
  }
}

export function agentThemeIcon(kind: AgentKind): vscode.ThemeIcon {
  const id = agentIconId(kind);
  const colorId = agentColorId(kind);
  return colorId
    ? new vscode.ThemeIcon(id, new vscode.ThemeColor(colorId))
    : new vscode.ThemeIcon(id);
}

export type PodiumStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'idle';

export function statusThemeIcon(status: PodiumStatus | undefined): vscode.ThemeIcon {
  switch (status) {
    case 'running':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(COLOR_IDS.statusRunning));
    case 'done':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor(COLOR_IDS.statusDone));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor(COLOR_IDS.statusFailed));
    case 'cancelled':
      return new vscode.ThemeIcon(
        'circle-slash',
        new vscode.ThemeColor(COLOR_IDS.statusCancelled),
      );
    default:
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor(COLOR_IDS.statusIdle));
  }
}

export function statusHex(status: PodiumStatus | undefined): string {
  switch (status) {
    case 'running':
      return HEX.statusRunning;
    case 'done':
      return HEX.statusDone;
    case 'failed':
      return HEX.statusFailed;
    case 'cancelled':
      return HEX.statusCancelled;
    default:
      return HEX.statusIdle;
  }
}

// -----------------------------------------------------------------------------
// Per-worker accent tinting
// -----------------------------------------------------------------------------
// Two workers with the same provider (e.g. claude-1 and claude-2) should be
// visually distinguishable while staying close to the provider's base hue.
// We compute an HSL shift keyed on the worker's 1-based index so same-provider
// workers get a deterministic, reasonably-spaced set of accents.

export type ConversationProvider = 'claude' | 'codex' | 'gemini' | 'leader' | 'unknown';

// Base hues derived empirically from the HEX palette above. Keeping S/L fixed
// gives the variants a uniform "feel" instead of veering into muddy territory.
const PROVIDER_BASE_HSL: Record<ConversationProvider, { h: number; s: number; l: number }> = {
  // #C084FC (purple)
  claude: { h: 270, s: 95, l: 75 },
  // #10B981 (emerald)
  codex: { h: 160, s: 84, l: 39 },
  // #60A5FA (blue)
  gemini: { h: 217, s: 91, l: 68 },
  // #FB923C (orange) — matches --podium-omc / --accent-leader
  leader: { h: 24, s: 95, l: 61 },
  // fall back to neutral gray tone
  unknown: { h: 220, s: 9, l: 56 },
};

/**
 * Return an HSL color string for a worker bubble accent.
 *
 * Provider drives the base hue; workerIndex drives a subtle hue shift so
 * `claude-1` and `claude-2` read as distinct:
 *   shift = (index - 1) * 12deg
 * For a 4-worker team of the same provider this spans 0° → 36°, staying
 * inside "same family" range. Saturation/lightness stay fixed per provider.
 *
 * `workerIndex <= 0` (leader / unknown / absent) → base color unchanged.
 */
export function workerAccentColor(provider: ConversationProvider, workerIndex: number): string {
  const base = PROVIDER_BASE_HSL[provider] ?? PROVIDER_BASE_HSL.unknown;
  const idx = Number.isFinite(workerIndex) && workerIndex > 0 ? Math.floor(workerIndex) : 0;
  const shift = idx > 0 ? (idx - 1) * 12 : 0;
  // Wrap into [0, 360)
  const h = ((base.h + shift) % 360 + 360) % 360;
  return `hsl(${h.toFixed(1)}, ${base.s}%, ${base.l}%)`;
}
