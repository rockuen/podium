import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import type { HUDStdinCache } from '../types/hud';

const RELATIVE_HUD_CACHE = '.omc/state/hud-stdin-cache.json';

export class StateWatcher extends EventEmitter {
  private fsWatcher: vscode.FileSystemWatcher | null = null;
  private root: string | null = null;
  private lastHud: HUDStdinCache | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: (msg: string) => void,
    private readonly pollIntervalMs: number = 2000,
  ) {
    super();
  }

  get currentRoot(): string | null {
    return this.root;
  }

  start(projectRoot: string): void {
    this.stop();
    this.root = projectRoot;

    const pattern = new vscode.RelativePattern(projectRoot, RELATIVE_HUD_CACHE);
    this.fsWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    const handler = () => this.readAndEmit();
    this.fsWatcher.onDidCreate(handler);
    this.fsWatcher.onDidChange(handler);
    this.fsWatcher.onDidDelete(() => {
      if (this.lastHud !== null) {
        this.lastHud = null;
        this.emit('hud', null);
      }
    });

    // Defensive polling fallback — FileSystemWatcher can miss atomic rename-writes
    // on some platforms. Cheap since we only stat+parse one small JSON file.
    this.refreshTimer = setInterval(() => this.readAndEmit(), this.pollIntervalMs);

    this.readAndEmit();
    this.logger(`[podium.hud] watching ${path.join(projectRoot, RELATIVE_HUD_CACHE)}`);
  }

  stop(): void {
    if (this.fsWatcher) {
      this.fsWatcher.dispose();
      this.fsWatcher = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.root = null;
  }

  snapshot(): HUDStdinCache | null {
    return this.lastHud;
  }

  forceRefresh(): void {
    this.readAndEmit();
  }

  private readAndEmit(): void {
    if (!this.root) return;
    const file = path.join(this.root, RELATIVE_HUD_CACHE);
    if (!fs.existsSync(file)) {
      if (this.lastHud !== null) {
        this.lastHud = null;
        this.emit('hud', null);
      }
      return;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return; // atomic rename collision; try again on next tick
    }
    if (!raw.trim()) return;

    let parsed: HUDStdinCache;
    try {
      parsed = JSON.parse(raw) as HUDStdinCache;
    } catch {
      return; // partial write
    }

    if (hudEqual(parsed, this.lastHud)) return;
    this.lastHud = parsed;
    this.emit('hud', parsed);
  }
}

function hudEqual(a: HUDStdinCache | null, b: HUDStdinCache | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  // Cheap JSON comparison — HUD cache is small (~1KB) so stringify is fine.
  return JSON.stringify(a) === JSON.stringify(b);
}
