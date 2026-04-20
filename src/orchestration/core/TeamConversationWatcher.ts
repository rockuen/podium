import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import type {
  ConversationSnapshot,
  LeaderMeta,
  MailboxFile,
  MailboxMessage,
  WorkerMeta,
  WorkerProvider,
} from '../types/conversation';
import { readTeamDisplay, type TeamDisplay } from './TeamDisplayStore';

const POLL_MS = 1500;

interface ConfigWorkerEntry {
  name?: string;
  role?: string;
  worker_cli?: string;
  index?: number;
}

interface RoutingLeafRaw {
  provider?: string;
  model?: string;
  agent?: string;
}

interface TeamConfigFile {
  workers?: ConfigWorkerEntry[];
  agent_type?: string;
  resolved_routing?: {
    orchestrator?: { primary?: RoutingLeafRaw };
  };
}

interface TeamManifestFile {
  workers?: ConfigWorkerEntry[];
  leader?: { worker_id?: string; role?: string };
}

interface ConfigResolution {
  workerProviders: Map<string, WorkerProvider>;
  workerIndexes: Map<string, number>;
  leaderWorkerId: string | null;
  leader: LeaderMeta | null;
}

export class TeamConversationWatcher extends EventEmitter {
  private mailboxWatcher: vscode.FileSystemWatcher | null = null;
  private heartbeatWatcher: vscode.FileSystemWatcher | null = null;
  private displayWatcher: vscode.FileSystemWatcher | null = null;
  private configWatcher: vscode.FileSystemWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private root: string | null = null;
  private teamName: string | null = null;
  private last: ConversationSnapshot | null = null;
  private display: TeamDisplay | null = null;

  constructor(private readonly logger: (msg: string) => void) {
    super();
  }

  get currentTeam(): string | null {
    return this.teamName;
  }

  currentDisplay(): TeamDisplay | null {
    return this.display;
  }

  start(root: string, teamName: string): void {
    this.stop();
    this.root = root;
    this.teamName = teamName;
    this.display = readTeamDisplay(root, teamName);

    const mailboxPattern = new vscode.RelativePattern(
      root,
      `.omc/state/team/${teamName}/mailbox/*.json`,
    );
    this.mailboxWatcher = vscode.workspace.createFileSystemWatcher(mailboxPattern);
    const debounced = () => this.scheduleScan();
    this.mailboxWatcher.onDidCreate(debounced);
    this.mailboxWatcher.onDidChange(debounced);
    this.mailboxWatcher.onDidDelete(debounced);

    const heartbeatPattern = new vscode.RelativePattern(
      root,
      `.omc/state/team/${teamName}/workers/*/heartbeat.json`,
    );
    this.heartbeatWatcher = vscode.workspace.createFileSystemWatcher(heartbeatPattern);
    this.heartbeatWatcher.onDidCreate(debounced);
    this.heartbeatWatcher.onDidChange(debounced);

    const displayPattern = new vscode.RelativePattern(
      root,
      `.omc/state/team/${teamName}/display.json`,
    );
    this.displayWatcher = vscode.workspace.createFileSystemWatcher(displayPattern);
    const reloadDisplay = () => {
      if (!this.root || !this.teamName) return;
      this.display = readTeamDisplay(this.root, this.teamName);
      this.scheduleScan();
    };
    this.displayWatcher.onDidCreate(reloadDisplay);
    this.displayWatcher.onDidChange(reloadDisplay);
    this.displayWatcher.onDidDelete(() => {
      this.display = null;
      this.scheduleScan();
    });

    // Watch config.json + manifest.json so provider/leader info re-resolves if
    // OMC rewrites them mid-team (rare, but cheap to wire).
    const configPattern = new vscode.RelativePattern(
      root,
      `.omc/state/team/${teamName}/{config,manifest}.json`,
    );
    this.configWatcher = vscode.workspace.createFileSystemWatcher(configPattern);
    this.configWatcher.onDidCreate(debounced);
    this.configWatcher.onDidChange(debounced);
    this.configWatcher.onDidDelete(debounced);

    this.pollTimer = setInterval(() => this.scan(), POLL_MS);
    this.scan();
    this.logger(`[podium.convo] watching team "${teamName}"`);
  }

  stop(): void {
    this.mailboxWatcher?.dispose();
    this.heartbeatWatcher?.dispose();
    this.displayWatcher?.dispose();
    this.configWatcher?.dispose();
    this.mailboxWatcher = null;
    this.heartbeatWatcher = null;
    this.displayWatcher = null;
    this.configWatcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.root = null;
    this.teamName = null;
    this.last = null;
    this.display = null;
  }

  snapshot(): ConversationSnapshot | null {
    return this.last;
  }

  forceRefresh(): void {
    this.scan();
  }

  private scheduleScan(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.scan();
    }, 200);
  }

  private scan(): void {
    if (!this.root || !this.teamName) return;
    const teamDir = path.join(this.root, '.omc', 'state', 'team', this.teamName);
    if (!fs.existsSync(teamDir)) {
      this.emitSnapshot({
        teamName: this.teamName,
        root: this.root,
        messages: [],
        workers: {},
        scannedAt: Date.now(),
        ...this.displayFields(),
      });
      return;
    }

    const mailboxDir = path.join(teamDir, 'mailbox');
    const mergedMap = new Map<string, MailboxMessage>();
    if (fs.existsSync(mailboxDir)) {
      let entries: string[];
      try {
        entries = fs.readdirSync(mailboxDir);
      } catch {
        entries = [];
      }
      for (const file of entries) {
        if (!file.endsWith('.json')) continue;
        const full = path.join(mailboxDir, file);
        const parsed = safeReadJson<MailboxFile>(full);
        if (!parsed) continue;
        const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
        for (const msg of messages) {
          if (!msg || typeof msg.message_id !== 'string') continue;
          // Last-writer-wins on same id (delivery status may update over time).
          mergedMap.set(msg.message_id, msg);
        }
      }
    }

    const messages = Array.from(mergedMap.values()).sort((a, b) => {
      const ta = Date.parse(a.created_at || '') || 0;
      const tb = Date.parse(b.created_at || '') || 0;
      return ta - tb;
    });

    const resolution = resolveFromConfig(teamDir);
    const workers = this.readWorkers(teamDir, messages, resolution);

    const snap: ConversationSnapshot = {
      teamName: this.teamName,
      root: this.root,
      messages,
      workers,
      scannedAt: Date.now(),
      ...this.displayFields(),
    };
    if (resolution.leader) snap.leader = resolution.leader;
    this.emitSnapshot(snap);
  }

  private displayFields(): Partial<ConversationSnapshot> {
    if (!this.display) return {};
    return {
      displayName: this.display.displayName,
      initialPrompt: this.display.initialPrompt,
      createdAt: this.display.createdAt,
    };
  }

  private readWorkers(
    teamDir: string,
    messages: MailboxMessage[],
    resolution: ConfigResolution,
  ): Record<string, WorkerMeta> {
    const workers: Record<string, WorkerMeta> = {};
    const workersDir = path.join(teamDir, 'workers');
    if (fs.existsSync(workersDir)) {
      let names: string[];
      try {
        names = fs.readdirSync(workersDir);
      } catch {
        names = [];
      }
      for (const name of names) {
        const heartbeatPath = path.join(workersDir, name, 'heartbeat.json');
        const statusPath = path.join(workersDir, name, 'status.json');
        const heartbeat = safeReadJson<{ provider?: string; pid?: number; status?: string }>(
          heartbeatPath,
        );
        const status = safeReadJson<{ state?: string; status?: string }>(statusPath);
        workers[name] = buildWorkerMeta(name, resolution, heartbeat?.provider, {
          status: heartbeat?.status ?? status?.state ?? status?.status,
          pid: heartbeat?.pid,
        });
      }
    }
    // Seed any workers we saw in messages but not on disk (e.g., leader-fixed).
    for (const msg of messages) {
      for (const who of [msg.from_worker, msg.to_worker]) {
        if (!who || workers[who]) continue;
        workers[who] = buildWorkerMeta(who, resolution);
      }
    }
    // Seed workers that are declared in config.json but not yet on disk /
    // mailbox. This makes the provider pills appear immediately after spawn.
    for (const [name] of resolution.workerProviders) {
      if (workers[name]) continue;
      workers[name] = buildWorkerMeta(name, resolution);
    }
    return workers;
  }

  private emitSnapshot(snap: ConversationSnapshot): void {
    if (this.last && sameSnapshot(this.last, snap)) return;
    this.last = snap;
    this.emit('snapshot', snap);
  }
}

function normalizeProvider(raw: string | undefined, workerName: string): WorkerProvider {
  const lower = (raw ?? '').toLowerCase();
  if (lower === 'claude' || lower === 'codex' || lower === 'gemini') return lower;
  if (lower === 'leader') return 'leader';
  if (/^leader/i.test(workerName)) return 'leader';
  return 'unknown';
}

/**
 * Resolution priority for a worker's provider:
 *   1. `config.json` / `manifest.json` `workers[].role` (authoritative per-spawn mapping)
 *   2. heartbeat.json `provider` field (forward-compat for future OMC builds)
 *   3. name-based guess (`leader-*` → `'leader'`)
 *   4. `'unknown'`
 */
function buildWorkerMeta(
  name: string,
  resolution: ConfigResolution,
  heartbeatProvider?: string,
  extra: { status?: string; pid?: number } = {},
): WorkerMeta {
  let provider: WorkerProvider = 'unknown';
  const fromConfig = resolution.workerProviders.get(name);
  if (fromConfig) {
    provider = fromConfig;
  } else if (heartbeatProvider) {
    provider = normalizeProvider(heartbeatProvider, name);
  } else {
    provider = normalizeProvider(undefined, name);
  }
  const meta: WorkerMeta = { name, provider };
  const idx = resolution.workerIndexes.get(name) ?? parseWorkerIndex(name);
  if (idx !== null) meta.index = idx;
  if (extra.status !== undefined) meta.status = extra.status;
  if (extra.pid !== undefined) meta.pid = extra.pid;
  return meta;
}

function parseWorkerIndex(name: string): number | null {
  const m = name.match(/^worker-(\d+)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Read `config.json` (preferred) then `manifest.json` and distill:
 *   - per-worker provider map (name → 'claude' | 'codex' | 'gemini' | …)
 *   - per-worker index (1-based)
 *   - leader worker id (`manifest.json.leader.worker_id`)
 *   - leader meta (from `config.json.resolved_routing.orchestrator.primary`;
 *     fallback to `{ provider: 'leader' }`)
 *
 * Missing/corrupt files are not errors — this helper always returns a valid
 * (possibly empty) resolution so the watcher degrades gracefully.
 */
export function resolveFromConfig(teamDir: string): ConfigResolution {
  const config = safeReadJson<TeamConfigFile>(path.join(teamDir, 'config.json'));
  const manifest = safeReadJson<TeamManifestFile>(path.join(teamDir, 'manifest.json'));

  const workerProviders = new Map<string, WorkerProvider>();
  const workerIndexes = new Map<string, number>();
  const entries = Array.isArray(config?.workers) && config!.workers!.length > 0
    ? config!.workers!
    : (manifest?.workers ?? []);
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string') continue;
    const provider = normalizeProvider(entry.role, entry.name);
    workerProviders.set(entry.name, provider);
    if (typeof entry.index === 'number' && Number.isFinite(entry.index)) {
      workerIndexes.set(entry.name, entry.index);
    } else {
      const parsed = parseWorkerIndex(entry.name);
      if (parsed !== null) workerIndexes.set(entry.name, parsed);
    }
  }

  const leaderWorkerId = typeof manifest?.leader?.worker_id === 'string'
    ? manifest.leader.worker_id
    : null;

  let leader: LeaderMeta | null = null;
  const primary = config?.resolved_routing?.orchestrator?.primary;
  if (primary && typeof primary === 'object') {
    const provider = normalizeProvider(primary.provider, leaderWorkerId ?? '');
    const leaderMeta: LeaderMeta = {
      provider: provider === 'unknown' ? 'leader' : provider,
    };
    if (typeof primary.model === 'string' && primary.model.length > 0) leaderMeta.model = primary.model;
    if (typeof primary.agent === 'string' && primary.agent.length > 0) leaderMeta.agent = primary.agent;
    leader = leaderMeta;
  } else if (typeof config?.agent_type === 'string' && config.agent_type.length > 0) {
    const provider = normalizeProvider(config.agent_type, leaderWorkerId ?? '');
    leader = { provider: provider === 'unknown' ? 'leader' : provider };
  } else if (leaderWorkerId) {
    leader = { provider: 'leader' };
  }

  return { workerProviders, workerIndexes, leaderWorkerId, leader };
}

function safeReadJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function sameSnapshot(a: ConversationSnapshot, b: ConversationSnapshot): boolean {
  if (a.teamName !== b.teamName) return false;
  if ((a.displayName ?? '') !== (b.displayName ?? '')) return false;
  if ((a.initialPrompt ?? '') !== (b.initialPrompt ?? '')) return false;
  if ((a.createdAt ?? 0) !== (b.createdAt ?? 0)) return false;
  if ((a.leader?.provider ?? '') !== (b.leader?.provider ?? '')) return false;
  if ((a.leader?.model ?? '') !== (b.leader?.model ?? '')) return false;
  if ((a.leader?.agent ?? '') !== (b.leader?.agent ?? '')) return false;
  if (a.messages.length !== b.messages.length) return false;
  for (let i = 0; i < a.messages.length; i++) {
    const ma = a.messages[i];
    const mb = b.messages[i];
    if (ma.message_id !== mb.message_id) return false;
    if ((ma.delivered_at ?? '') !== (mb.delivered_at ?? '')) return false;
    if ((ma.notified_at ?? '') !== (mb.notified_at ?? '')) return false;
  }
  const aw = Object.keys(a.workers);
  const bw = Object.keys(b.workers);
  if (aw.length !== bw.length) return false;
  for (const k of aw) {
    const wa = a.workers[k];
    const wb = b.workers[k];
    if (!wb) return false;
    if (wa.provider !== wb.provider) return false;
    if ((wa.status ?? '') !== (wb.status ?? '')) return false;
    if ((wa.index ?? 0) !== (wb.index ?? 0)) return false;
  }
  return true;
}
