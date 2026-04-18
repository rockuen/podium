import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import type { MissionStateFile, SubagentTrackingFile } from '../types/mission';

const MISSION_FILE = '.omc/state/mission-state.json';
const SUBAGENT_FILE = '.omc/state/subagent-tracking.json';

export interface MissionSnapshot {
  missions: MissionStateFile | null;
  subagents: SubagentTrackingFile | null;
}

export class MissionWatcher extends EventEmitter {
  private missionWatcher: vscode.FileSystemWatcher | null = null;
  private subagentWatcher: vscode.FileSystemWatcher | null = null;
  private root: string | null = null;
  private lastMissions: MissionStateFile | null = null;
  private lastSubagents: SubagentTrackingFile | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: (msg: string) => void,
    private readonly pollIntervalMs: number = 3000,
  ) {
    super();
  }

  get currentRoot(): string | null {
    return this.root;
  }

  start(projectRoot: string): void {
    this.stop();
    this.root = projectRoot;

    const missionPattern = new vscode.RelativePattern(projectRoot, MISSION_FILE);
    this.missionWatcher = vscode.workspace.createFileSystemWatcher(missionPattern);
    const missionHandler = () => this.readMissions();
    this.missionWatcher.onDidCreate(missionHandler);
    this.missionWatcher.onDidChange(missionHandler);
    this.missionWatcher.onDidDelete(() => {
      if (this.lastMissions !== null) {
        this.lastMissions = null;
        this.emitSnapshot();
      }
    });

    const subagentPattern = new vscode.RelativePattern(projectRoot, SUBAGENT_FILE);
    this.subagentWatcher = vscode.workspace.createFileSystemWatcher(subagentPattern);
    const subagentHandler = () => this.readSubagents();
    this.subagentWatcher.onDidCreate(subagentHandler);
    this.subagentWatcher.onDidChange(subagentHandler);
    this.subagentWatcher.onDidDelete(() => {
      if (this.lastSubagents !== null) {
        this.lastSubagents = null;
        this.emitSnapshot();
      }
    });

    this.pollTimer = setInterval(() => {
      this.readMissions();
      this.readSubagents();
    }, this.pollIntervalMs);

    this.readMissions();
    this.readSubagents();
    this.logger(
      `[podium.mission] watching ${path.join(projectRoot, MISSION_FILE)} + ${path.join(
        projectRoot,
        SUBAGENT_FILE,
      )}`,
    );
  }

  stop(): void {
    this.missionWatcher?.dispose();
    this.subagentWatcher?.dispose();
    this.missionWatcher = null;
    this.subagentWatcher = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.root = null;
  }

  snapshot(): MissionSnapshot {
    return { missions: this.lastMissions, subagents: this.lastSubagents };
  }

  forceRefresh(): void {
    this.readMissions();
    this.readSubagents();
  }

  private readMissions(): void {
    if (!this.root) return;
    const file = path.join(this.root, MISSION_FILE);
    const parsed = readJsonSafe<MissionStateFile>(file);
    if (serialized(parsed) === serialized(this.lastMissions)) return;
    this.lastMissions = parsed;
    this.emitSnapshot();
  }

  private readSubagents(): void {
    if (!this.root) return;
    const file = path.join(this.root, SUBAGENT_FILE);
    const parsed = readJsonSafe<SubagentTrackingFile>(file);
    if (serialized(parsed) === serialized(this.lastSubagents)) return;
    this.lastSubagents = parsed;
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    this.emit('snapshot', this.snapshot());
  }
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

function serialized(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return '<unserializable>';
  }
}
