import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import type {
  ConversationSnapshot,
  MailboxFile,
  MailboxMessage,
  WorkerMeta,
  WorkerProvider,
} from '../types/conversation';

const POLL_MS = 1500;

export class TeamConversationWatcher extends EventEmitter {
  private mailboxWatcher: vscode.FileSystemWatcher | null = null;
  private heartbeatWatcher: vscode.FileSystemWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private root: string | null = null;
  private teamName: string | null = null;
  private last: ConversationSnapshot | null = null;

  constructor(private readonly logger: (msg: string) => void) {
    super();
  }

  get currentTeam(): string | null {
    return this.teamName;
  }

  start(root: string, teamName: string): void {
    this.stop();
    this.root = root;
    this.teamName = teamName;

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

    this.pollTimer = setInterval(() => this.scan(), POLL_MS);
    this.scan();
    this.logger(`[podium.convo] watching team "${teamName}"`);
  }

  stop(): void {
    this.mailboxWatcher?.dispose();
    this.heartbeatWatcher?.dispose();
    this.mailboxWatcher = null;
    this.heartbeatWatcher = null;
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

    const workers = this.readWorkers(teamDir, messages);

    this.emitSnapshot({
      teamName: this.teamName,
      root: this.root,
      messages,
      workers,
      scannedAt: Date.now(),
    });
  }

  private readWorkers(teamDir: string, messages: MailboxMessage[]): Record<string, WorkerMeta> {
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
        workers[name] = {
          name,
          provider: normalizeProvider(heartbeat?.provider, name),
          status: heartbeat?.status ?? status?.state ?? status?.status,
          pid: heartbeat?.pid,
        };
      }
    }
    // Seed any workers we saw in messages but not on disk (e.g., leader-fixed).
    for (const msg of messages) {
      for (const who of [msg.from_worker, msg.to_worker]) {
        if (!who || workers[who]) continue;
        workers[who] = { name: who, provider: normalizeProvider(undefined, who) };
      }
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
  if (/^leader/i.test(workerName)) return 'leader';
  return 'unknown';
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
  }
  return true;
}
