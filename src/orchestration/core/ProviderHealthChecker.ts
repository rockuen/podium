import { exec } from 'child_process';
import { EventEmitter } from 'events';
import type { ProviderHealth, ProviderProbe } from '../types/provider';

const DEFAULT_REFRESH_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;

/**
 * Probes `omc doctor --team-routing --json` to learn which of claude/codex/
 * gemini CLIs are actually resolvable on this machine. Emits `update` when
 * the snapshot changes.
 *
 * Note: depends on the local OMC bridge/cli.cjs hotfix on Windows (see
 * memory/feedback_omc_windows_probe.md). If `omc` itself is missing, the
 * checker returns `error` state and the panel should gracefully fall back.
 */
export class ProviderHealthChecker extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private latest: ProviderHealth | null = null;
  private running = false;
  private pendingRecheck = false;
  private cwd: string | null = null;

  constructor(private readonly logger: (msg: string) => void) {
    super();
  }

  setCwd(cwd: string | null): void {
    const normalized = cwd ?? null;
    if (normalized === this.cwd) return;
    this.cwd = normalized;
    this.logger(`[podium.health] cwd=${normalized ?? '(none)'}`);
    // Invalidate cache and re-probe from the new working directory so the
    // `.claude/omc.jsonc` at that root is picked up. If a probe is already
    // running, flag a follow-up so the new cwd isn't lost (the in-flight
    // probe's result reflects the old cwd and would otherwise be the last
    // word until the next timer tick).
    this.latest = null;
    if (this.running) {
      this.pendingRecheck = true;
    } else {
      void this.check();
    }
  }

  start(refreshMs: number = DEFAULT_REFRESH_MS): void {
    this.stop();
    void this.check();
    this.timer = setInterval(() => void this.check(), Math.max(10_000, refreshMs));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  snapshot(): ProviderHealth | null {
    return this.latest;
  }

  async forceRefresh(): Promise<ProviderHealth> {
    return this.check();
  }

  private async check(): Promise<ProviderHealth> {
    if (this.running) return this.latest ?? emptyHealth();
    this.running = true;
    try {
      const health = await runDoctor(this.cwd);
      const changed = !this.latest || !sameHealth(this.latest, health);
      this.latest = health;
      if (changed) {
        this.emit('update', health);
        const badge = health.error
          ? `ERROR: ${health.error}`
          : health.missing.length === 0
          ? `all providers ready (${health.probes.length} probed)`
          : `missing: ${health.missing.join(', ')}`;
        this.logger(`[podium.health] ${badge}`);
      }
      return health;
    } finally {
      this.running = false;
      if (this.pendingRecheck) {
        this.pendingRecheck = false;
        // setCwd (or another trigger) queued a re-probe while the previous
        // one was in flight — run it now so the cache reflects the latest
        // cwd / config.
        void this.check();
      }
    }
  }
}

function runDoctor(cwd: string | null): Promise<ProviderHealth> {
  return new Promise((resolve) => {
    exec(
      'omc doctor --team-routing --json',
      {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 256,
        cwd: cwd ?? undefined,
      },
      (err, stdout, _stderr) => {
        if (err) {
          resolve({
            probes: [],
            missing: [],
            checkedAt: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        try {
          const text = String(stdout ?? '');
          // Extract the first JSON block — ignores any leading warning lines.
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start === -1 || end === -1 || end < start) {
            throw new Error('no JSON block in omc doctor output');
          }
          const json = JSON.parse(text.slice(start, end + 1)) as {
            probes?: ProviderProbe[];
            missing?: string[];
          };
          resolve({
            probes: Array.isArray(json.probes) ? json.probes : [],
            missing: Array.isArray(json.missing) ? json.missing : [],
            checkedAt: Date.now(),
          });
        } catch (parseErr) {
          resolve({
            probes: [],
            missing: [],
            checkedAt: Date.now(),
            error: parseErr instanceof Error ? parseErr.message : String(parseErr),
          });
        }
      },
    );
  });
}

function emptyHealth(): ProviderHealth {
  return { probes: [], missing: [], checkedAt: 0 };
}

function sameHealth(a: ProviderHealth, b: ProviderHealth): boolean {
  if ((a.error ?? '') !== (b.error ?? '')) return false;
  if (a.missing.length !== b.missing.length) return false;
  for (let i = 0; i < a.missing.length; i++) {
    if (a.missing[i] !== b.missing[i]) return false;
  }
  if (a.probes.length !== b.probes.length) return false;
  for (let i = 0; i < a.probes.length; i++) {
    const pa = a.probes[i];
    const pb = b.probes[i];
    if (pa.provider !== pb.provider) return false;
    if (pa.found !== pb.found) return false;
    if ((pa.version ?? '') !== (pb.version ?? '')) return false;
    if ((pa.path ?? '') !== (pb.path ?? '')) return false;
  }
  return true;
}
