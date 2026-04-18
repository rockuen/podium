import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readJsonConfig, writeJsonConfigAtomic } from './JsonConfig';

/**
 * Shell patterns routinely invoked by OMC team workers. Added to
 * `tools.allowed` as a belt-and-suspenders fallback in case folderTrust
 * fails to silence the prompt (see Gemini CLI issues #18815, #18816).
 */
export const DESIRED_TOOLS_ALLOWED = [
  'run_shell_command(powershell)',
  'run_shell_command(pwsh)',
  'run_shell_command(cmd)',
  'run_shell_command(bash)',
  'run_shell_command(omc)',
  'run_shell_command(psmux)',
  'run_shell_command(tmux)',
  'run_shell_command(claude)',
  'run_shell_command(codex)',
  'run_shell_command(gemini)',
];

export interface GeminiAutoApproveResult {
  settingsPath: string;
  trustedFoldersPath: string;
  settingsChanged: boolean;
  settingsAdded: {
    folderTrustEnabled: boolean;
    allowedEntries: string[];
  };
  trustedFoldersChanged: boolean;
  trustedFolderAdded: string | null;
  error?: string;
}

interface GeminiSettings {
  security?: {
    folderTrust?: { enabled?: boolean; [k: string]: unknown };
    [k: string]: unknown;
  };
  tools?: {
    allowed?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

type TrustedFolders = Record<string, string>;

const GEMINI_DIR_CANDIDATES = () => [
  path.join(os.homedir(), '.gemini'),
  process.env.HOME ? path.join(process.env.HOME, '.gemini') : '',
].filter(Boolean);

function resolveGeminiDir(): string {
  const candidates = GEMINI_DIR_CANDIDATES();
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const primary = candidates[0] || path.join(os.homedir(), '.gemini');
  fs.mkdirSync(primary, { recursive: true });
  return primary;
}

/**
 * Make Gemini CLI silent when OMC team workers run shell commands under
 * `--approval-mode yolo` on Windows.
 *
 * Based on the Gemini CLI policy engine:
 *   - YOLO is downgraded to "default" when the folder is untrusted.
 *   - `security.folderTrust.enabled: true` activates trustedFolders.json.
 *   - `tools.allowed` bypasses the per-call confirmation dialog.
 */
export function installGeminiAutoApprove(workspaceRoot: string): GeminiAutoApproveResult {
  const geminiDir = resolveGeminiDir();
  const settingsPath = path.join(geminiDir, 'settings.json');
  const trustedFoldersPath = path.join(geminiDir, 'trustedFolders.json');

  const result: GeminiAutoApproveResult = {
    settingsPath,
    trustedFoldersPath,
    settingsChanged: false,
    settingsAdded: { folderTrustEnabled: false, allowedEntries: [] },
    trustedFoldersChanged: false,
    trustedFolderAdded: null,
  };

  // ---- settings.json -----------------------------------------------------
  const settingsRead = readJsonConfig<GeminiSettings>(settingsPath);
  if (settingsRead.error && fs.existsSync(settingsPath)) {
    result.error = `could not parse ${settingsPath}: ${settingsRead.error}`;
    return result;
  }
  const settings: GeminiSettings = settingsRead.value ?? {};

  if (!settings.security || typeof settings.security !== 'object') {
    settings.security = {};
  }
  const security = settings.security as { folderTrust?: { enabled?: boolean } };
  if (!security.folderTrust || typeof security.folderTrust !== 'object') {
    security.folderTrust = {};
  }
  if (security.folderTrust.enabled !== true) {
    security.folderTrust.enabled = true;
    result.settingsAdded.folderTrustEnabled = true;
    result.settingsChanged = true;
  }

  if (!settings.tools || typeof settings.tools !== 'object') {
    settings.tools = {};
  }
  const tools = settings.tools as { allowed?: unknown };
  if (!Array.isArray(tools.allowed)) {
    tools.allowed = [];
  }
  const allowed = tools.allowed as string[];
  for (const entry of DESIRED_TOOLS_ALLOWED) {
    if (!allowed.includes(entry)) {
      allowed.push(entry);
      result.settingsAdded.allowedEntries.push(entry);
      result.settingsChanged = true;
    }
  }

  if (result.settingsChanged) {
    const writeRes = writeJsonConfigAtomic(settingsPath, settings);
    if (!writeRes.wrote) {
      result.error = `could not write ${settingsPath}: ${writeRes.error ?? 'unknown'}`;
      return result;
    }
  }

  // ---- trustedFolders.json -----------------------------------------------
  // Schema (inferred from a working install): { "<absolute-windows-path>": "TRUST_FOLDER" | "TRUST_PARENT" | "DO_NOT_TRUST" }
  const trustedRead = readJsonConfig<TrustedFolders>(trustedFoldersPath);
  let trusted: TrustedFolders = trustedRead.value ?? {};
  if (trustedRead.error && fs.existsSync(trustedFoldersPath)) {
    // Corrupt file — back up and start fresh rather than lose data silently.
    const backup = `${trustedFoldersPath}.podium-backup-${Date.now()}`;
    try {
      fs.copyFileSync(trustedFoldersPath, backup);
    } catch {
      /* ignore */
    }
    trusted = {};
  }

  const normalizedRoot = normalizeWindowsPath(workspaceRoot);
  const alreadyTrusted = Object.keys(trusted).some(
    (k) => normalizeWindowsPath(k) === normalizedRoot,
  );
  if (!alreadyTrusted) {
    trusted[workspaceRoot] = 'TRUST_FOLDER';
    const writeRes = writeJsonConfigAtomic(trustedFoldersPath, trusted);
    if (!writeRes.wrote) {
      result.error = `could not write ${trustedFoldersPath}: ${writeRes.error ?? 'unknown'}`;
      return result;
    }
    result.trustedFoldersChanged = true;
    result.trustedFolderAdded = workspaceRoot;
  }

  return result;
}

function normalizeWindowsPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export interface GeminiAutoApproveCheck {
  settingsPath: string;
  trustedFoldersPath: string;
  folderTrustEnabled: boolean;
  missingAllowedEntries: string[];
  workspaceTrusted: boolean;
  needed: boolean;
}

/**
 * Read-only variant of installGeminiAutoApprove — returns what would need to
 * change without writing anything. Used to warn the user before they spawn a
 * Gemini worker that is about to be nagged with approval prompts.
 */
export function checkGeminiAutoApprove(workspaceRoot: string): GeminiAutoApproveCheck {
  const geminiDir = resolveGeminiDir();
  const settingsPath = path.join(geminiDir, 'settings.json');
  const trustedFoldersPath = path.join(geminiDir, 'trustedFolders.json');

  let folderTrustEnabled = false;
  let allowed: string[] = [];
  {
    const read = readJsonConfig<GeminiSettings>(settingsPath);
    const settings = read.value ?? {};
    folderTrustEnabled = settings.security?.folderTrust?.enabled === true;
    if (Array.isArray(settings.tools?.allowed)) {
      allowed = settings.tools!.allowed as string[];
    }
  }
  const missingAllowedEntries = DESIRED_TOOLS_ALLOWED.filter((e) => !allowed.includes(e));

  let workspaceTrusted = false;
  {
    const read = readJsonConfig<Record<string, string>>(trustedFoldersPath);
    const parsed = read.value ?? {};
    const normalizedRoot = normalizeWindowsPath(workspaceRoot);
    for (const key of Object.keys(parsed)) {
      const val = String(parsed[key] ?? '').toUpperCase();
      if (val === 'TRUST_FOLDER' || val === 'TRUST_PARENT') {
        if (normalizeWindowsPath(key) === normalizedRoot) {
          workspaceTrusted = true;
          break;
        }
      }
    }
  }

  const needed = !folderTrustEnabled || !workspaceTrusted;
  return {
    settingsPath,
    trustedFoldersPath,
    folderTrustEnabled,
    missingAllowedEntries,
    workspaceTrusted,
    needed,
  };
}
