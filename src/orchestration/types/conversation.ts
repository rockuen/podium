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
}

export interface ConversationSnapshot {
  teamName: string;
  root: string;
  messages: MailboxMessage[];
  workers: Record<string, WorkerMeta>;
  scannedAt: number;
}
