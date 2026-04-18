import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readJsonConfig, writeJsonConfigAtomic } from './JsonConfig';

type Gateway = {
  type: 'http';
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  timeout: number;
};

type HookMapping = {
  enabled: boolean;
  gateway: string;
  instruction: string;
};

type OpenclawConfig = {
  enabled: boolean;
  gateways: Record<string, Gateway>;
  hooks: Record<string, HookMapping>;
};

const GATEWAY_NAME = 'podium';

/**
 * Sensible defaults — Podium only cares about lifecycle/tool events to
 * keep the Sessions tree + HUD fresh. User can edit the file afterwards.
 */
const DEFAULT_HOOK_INSTRUCTIONS: Record<string, string> = {
  'session-start': 'Session {{sessionId}} started in {{projectName}}',
  'session-end': 'Session {{sessionId}} ended. Summary: {{contextSummary}}',
  stop: 'Stop ({{reason}}) for session {{sessionId}}',
  'subagent-stop': 'Subagent stopped ({{reason}}) in session {{sessionId}}',
  'pre-tool-use': 'Pre-tool: {{toolName}} {{command}}',
  'post-tool-use': 'Post-tool: {{toolName}}',
  'user-prompt-submit': 'User prompt: {{prompt}}',
  notification: '{{signalSummary}}',
};

export interface RegisterResult {
  configPath: string;
  gatewayName: string;
  url: string;
  added: string[];
  preserved: string[];
}

export function openclawConfigPath(): string {
  return path.join(os.homedir(), '.claude', 'omc_config.openclaw.json');
}

export function readOpenclawConfig(): OpenclawConfig | null {
  const read = readJsonConfig<OpenclawConfig>(openclawConfigPath());
  return read.value;
}

export function registerPodiumAsGateway(url: string, token: string): RegisterResult {
  const configPath = openclawConfigPath();
  const existing = readOpenclawConfig();

  const next: OpenclawConfig = {
    enabled: existing?.enabled ?? true,
    gateways: { ...(existing?.gateways ?? {}) },
    hooks: { ...(existing?.hooks ?? {}) },
  };

  next.gateways[GATEWAY_NAME] = {
    type: 'http',
    url,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Extension-Id': 'rockuen.podium',
    },
    timeout: 10000,
  };

  const added: string[] = [];
  const preserved: string[] = [];
  for (const [event, instruction] of Object.entries(DEFAULT_HOOK_INSTRUCTIONS)) {
    if (next.hooks[event]) {
      preserved.push(event);
      continue;
    }
    next.hooks[event] = { enabled: true, gateway: GATEWAY_NAME, instruction };
    added.push(event);
  }

  const writeRes = writeJsonConfigAtomic(configPath, next);
  if (!writeRes.wrote) {
    throw new Error(`Podium: could not write ${configPath}: ${writeRes.error ?? 'unknown'}`);
  }

  return { configPath, gatewayName: GATEWAY_NAME, url, added, preserved };
}

export function isPodiumGatewayRegistered(): boolean {
  const cfg = readOpenclawConfig();
  return !!cfg?.gateways?.[GATEWAY_NAME];
}
