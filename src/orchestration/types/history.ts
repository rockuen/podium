/**
 * Session history — per-session tracking files under `.omc/state/sessions/{id}/`.
 * Confirmed live from this repo on 2026-04-17.
 */

export interface HistoryBackgroundTask {
  id?: string;
  status?: string;
  startedAt?: string;
  description?: string;
  [key: string]: unknown;
}

export interface SessionHudStateFile {
  sessionId: string;
  timestamp?: string;
  sessionStartTimestamp?: string;
  backgroundTasks?: HistoryBackgroundTask[];
  [key: string]: unknown;
}

export type SessionMode =
  | 'autopilot'
  | 'ralph'
  | 'ultrawork'
  | 'ultraqa'
  | 'ralplan'
  | 'team'
  | 'omc-teams'
  | 'deep-interview'
  | 'self-improve';

export const KNOWN_SESSION_MODES: SessionMode[] = [
  'autopilot',
  'ralph',
  'ultrawork',
  'ultraqa',
  'ralplan',
  'team',
  'omc-teams',
  'deep-interview',
  'self-improve',
];

export interface SessionHistoryEntry {
  sessionId: string;
  directory: string;
  hud: SessionHudStateFile | null;
  modes: SessionMode[];
  hasCancelSignal: boolean;
  directoryMtime: number;
  fileMtimes: Record<string, number>;
}

export interface SessionHistorySnapshot {
  entries: SessionHistoryEntry[];
  activeSessionId: string | null;
  scannedAt: number;
}
