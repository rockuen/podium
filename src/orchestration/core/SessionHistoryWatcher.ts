import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import {
  KNOWN_SESSION_MODES,
  SessionHistoryEntry,
  SessionHistorySnapshot,
  SessionHudStateFile,
  SessionMode,
} from '../types/history';
import type { HUDStdinCache } from '../types/hud';

const SESSIONS_DIR = '.omc/state/sessions';
const HUD_CACHE = '.omc/state/hud-stdin-cache.json';

export class SessionHistoryWatcher extends EventEmitter {
  private root: string | null = null;
  private dirWatcher: vscode.FileSystemWatcher | null = null;
  private cacheWatcher: vscode.FileSystemWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastSnapshot: SessionHistorySnapshot | null = null;

  constructor(
    private readonly logger: (msg: string) => void,
    private readonly pollIntervalMs: number = 5000,
  ) {
    super();
  }

  get currentRoot(): string | null {
    return this.root;
  }

  start(projectRoot: string): void {
    this.stop();
    this.root = projectRoot;

    const dirPattern = new vscode.RelativePattern(projectRoot, `${SESSIONS_DIR}/**/*.json`);
    this.dirWatcher = vscode.workspace.createFileSystemWatcher(dirPattern);
    const trigger = () => this.scan();
    this.dirWatcher.onDidCreate(trigger);
    this.dirWatcher.onDidChange(trigger);
    this.dirWatcher.onDidDelete(trigger);

    const cachePattern = new vscode.RelativePattern(projectRoot, HUD_CACHE);
    this.cacheWatcher = vscode.workspace.createFileSystemWatcher(cachePattern);
    this.cacheWatcher.onDidCreate(trigger);
    this.cacheWatcher.onDidChange(trigger);

    this.pollTimer = setInterval(() => this.scan(), this.pollIntervalMs);
    this.scan();
    this.logger(
      `[podium.history] watching ${path.join(projectRoot, SESSIONS_DIR)} + ${HUD_CACHE}`,
    );
  }

  stop(): void {
    this.dirWatcher?.dispose();
    this.cacheWatcher?.dispose();
    this.dirWatcher = null;
    this.cacheWatcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.root = null;
  }

  snapshot(): SessionHistorySnapshot | null {
    return this.lastSnapshot;
  }

  forceRefresh(): void {
    this.scan();
  }

  private scan(): void {
    if (!this.root) return;
    const sessionsDir = path.join(this.root, SESSIONS_DIR);
    if (!fs.existsSync(sessionsDir)) {
      const empty: SessionHistorySnapshot = {
        entries: [],
        activeSessionId: this.readActiveSessionId(),
        scannedAt: Date.now(),
      };
      this.emitIfChanged(empty);
      return;
    }

    let dirNames: string[];
    try {
      dirNames = fs.readdirSync(sessionsDir);
    } catch {
      return;
    }

    const entries: SessionHistoryEntry[] = [];
    for (const name of dirNames) {
      const sessionDir = path.join(sessionsDir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(sessionDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const files = safeReaddir(sessionDir);
      const fileMtimes: Record<string, number> = {};
      for (const f of files) {
        try {
          fileMtimes[f] = fs.statSync(path.join(sessionDir, f)).mtimeMs;
        } catch {
          /* ignore */
        }
      }

      const hud = readJsonSafe<SessionHudStateFile>(path.join(sessionDir, 'hud-state.json'));
      const modes: SessionMode[] = [];
      for (const mode of KNOWN_SESSION_MODES) {
        if (files.includes(`${mode}-state.json`)) {
          modes.push(mode);
        }
      }
      const hasCancelSignal = files.includes('cancel-signal-state.json');

      entries.push({
        sessionId: name,
        directory: sessionDir,
        hud,
        modes,
        hasCancelSignal,
        directoryMtime: stat.mtimeMs,
        fileMtimes,
      });
    }

    // Most-recently active first (uses latest file mtime or session dir mtime)
    entries.sort((a, b) => lastActivity(b) - lastActivity(a));

    const snapshot: SessionHistorySnapshot = {
      entries,
      activeSessionId: this.readActiveSessionId(),
      scannedAt: Date.now(),
    };
    this.emitIfChanged(snapshot);
  }

  private readActiveSessionId(): string | null {
    if (!this.root) return null;
    const file = path.join(this.root, HUD_CACHE);
    const parsed = readJsonSafe<HUDStdinCache>(file);
    return parsed?.session_id ?? null;
  }

  private emitIfChanged(snapshot: SessionHistorySnapshot): void {
    if (this.lastSnapshot && shallowEqual(snapshot, this.lastSnapshot)) return;
    this.lastSnapshot = snapshot;
    this.emit('snapshot', snapshot);
  }
}

function lastActivity(entry: SessionHistoryEntry): number {
  let latest = entry.directoryMtime;
  for (const value of Object.values(entry.fileMtimes)) {
    if (value > latest) latest = value;
  }
  const hudTs = parseIsoMs(entry.hud?.timestamp) || parseIsoMs(entry.hud?.sessionStartTimestamp);
  if (hudTs && hudTs > latest) latest = hudTs;
  return latest;
}

function parseIsoMs(iso?: string): number {
  if (!iso) return 0;
  const n = Date.parse(iso);
  return Number.isNaN(n) ? 0 : n;
}

function readJsonSafe<T>(file: string): T | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function shallowEqual(a: SessionHistorySnapshot, b: SessionHistorySnapshot): boolean {
  if (a.activeSessionId !== b.activeSessionId) return false;
  if (a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i++) {
    const ea = a.entries[i];
    const eb = b.entries[i];
    if (ea.sessionId !== eb.sessionId) return false;
    if (ea.directoryMtime !== eb.directoryMtime) return false;
    if (ea.modes.length !== eb.modes.length) return false;
    if (ea.hasCancelSignal !== eb.hasCancelSignal) return false;
    if (Object.keys(ea.fileMtimes).length !== Object.keys(eb.fileMtimes).length) return false;
    for (const k of Object.keys(ea.fileMtimes)) {
      if (ea.fileMtimes[k] !== eb.fileMtimes[k]) return false;
    }
  }
  return true;
}
