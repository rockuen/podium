export type ProviderName = 'claude' | 'codex' | 'gemini';

export interface ProviderProbe {
  provider: ProviderName;
  binary: string;
  found: boolean;
  path?: string;
  version?: string;
}

export interface ProviderHealth {
  probes: ProviderProbe[];
  missing: string[];
  checkedAt: number;
  error?: string;
}
