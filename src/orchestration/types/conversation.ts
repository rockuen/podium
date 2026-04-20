export type WorkerProvider = 'claude' | 'codex' | 'gemini' | 'leader' | 'unknown';

export interface MailboxMessage {
  message_id: string;
  from_worker: string;
  to_worker: string;
  body: string;
  created_at: string;
  notified_at?: string;
  delivered_at?: string;
}

export interface MailboxFile {
  worker: string;
  messages: MailboxMessage[];
}

export interface WorkerMeta {
  name: string;
  provider: WorkerProvider;
  status?: string;
  pid?: number;
  /** 1-based worker index parsed from `worker-N`. Absent for leader/unknown. */
  index?: number;
}

export interface LeaderMeta {
  provider: WorkerProvider;
  /** Model label from `resolved_routing.orchestrator.primary.model`. May be literal `'inherit'`. */
  model?: string;
  /** Agent label from `resolved_routing.orchestrator.primary.agent` (e.g. `'omc'`). */
  agent?: string;
}

export interface ConversationSnapshot {
  teamName: string;
  root: string;
  messages: MailboxMessage[];
  workers: Record<string, WorkerMeta>;
  scannedAt: number;
  /** User-editable short label (sidecar `display.json`). Absent when no sidecar is written yet. */
  displayName?: string;
  /** Raw prompt the user typed when spawning the team. Rendered as the first message. */
  initialPrompt?: string;
  /** Sidecar `createdAt` timestamp, used to stamp the synthetic initial message. */
  createdAt?: number;
  /** Resolved leader metadata from `config.json` / `manifest.json`. Absent when we can't infer one. */
  leader?: LeaderMeta;
}
