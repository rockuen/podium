import * as fs from 'fs';
import * as path from 'path';
import { readJsonConfig, writeJsonConfigAtomic } from './JsonConfig';

/**
 * Shell-exec patterns that OMC team workers routinely invoke. Pre-authorizing
 * these in `.claude/settings.json` prevents the worker TUI from nagging with
 * "Allow execution of [powershell]?" on every task claim.
 *
 * Only additive — if user has `deny`, `ask`, or custom entries, we leave them
 * untouched. We also dedupe against what's already present.
 */
export const DESIRED_ALLOW = [
  'Bash(powershell*)',
  'Bash(pwsh*)',
  'Bash(omc*)',
  'Bash(psmux*)',
  'Bash(tmux*)',
  'Bash(mkdir*)',
  'Bash(touch*)',
  'Bash(cat*)',
  'Bash(ls*)',
  'Bash(claude*)',
  'Bash(codex*)',
  'Bash(gemini*)',
];

export interface PermissionsResult {
  wrote: boolean;
  added: string[];
  alreadyPresent: string[];
  settingsPath: string;
  error?: string;
}

interface SettingsShape {
  permissions?: {
    allow?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export function ensureTeamWorkerPermissions(workspaceRoot: string): PermissionsResult {
  const settingsPath = path.join(workspaceRoot, '.claude', 'settings.json');
  const read = readJsonConfig<SettingsShape>(settingsPath);
  if (read.error && fs.existsSync(settingsPath)) {
    return {
      wrote: false,
      added: [],
      alreadyPresent: [],
      settingsPath,
      error: `could not parse existing settings.json: ${read.error}`,
    };
  }
  const settings: SettingsShape = read.value ?? {};

  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = {};
  }
  const permissions = settings.permissions as Record<string, unknown>;
  if (!Array.isArray(permissions.allow)) {
    permissions.allow = [];
  }
  const allow = permissions.allow as string[];

  const alreadyPresent: string[] = [];
  const added: string[] = [];
  for (const entry of DESIRED_ALLOW) {
    if (allow.includes(entry)) {
      alreadyPresent.push(entry);
    } else {
      allow.push(entry);
      added.push(entry);
    }
  }
  if (added.length === 0) {
    return { wrote: false, added: [], alreadyPresent, settingsPath };
  }
  const writeRes = writeJsonConfigAtomic(settingsPath, settings);
  if (!writeRes.wrote) {
    return {
      wrote: false,
      added: [],
      alreadyPresent,
      settingsPath,
      error: writeRes.error ?? 'unknown write failure',
    };
  }
  return { wrote: true, added, alreadyPresent, settingsPath };
}
