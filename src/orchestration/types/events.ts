/**
 * OMC OpenClaw Gateway payload types.
 * Mirrors the shape built in OMC 4.12.0 `dist/openclaw/index.js` (wakeOpenClaw).
 * See research/openclaw-payload-schema.md for details.
 */

export interface OMCOpenClawSignal {
  kind: string;
  name: string;
  phase: string;
  routeKey: string;
  priority: string;
  summary?: string;
  prUrl?: string;
  testRunner?: string;
  command?: string;
}

export interface OMCOpenClawContext {
  sessionId?: string;
  projectPath?: string;
  tmuxSession?: string;
  toolName?: string;
  prompt?: string;
  contextSummary?: string;
  reason?: string;
  question?: string;
  tmuxTail?: string;
  replyChannel?: string;
  replyTarget?: string;
  replyThread?: string;
}

export interface OMCOpenClawPayload {
  event: string;
  instruction: string;
  timestamp: string;
  sessionId?: string;
  projectPath?: string;
  projectName?: string;
  tmuxSession?: string;
  tmuxTail?: string;
  channel?: string;
  to?: string;
  threadId?: string;
  signal: OMCOpenClawSignal;
  context: OMCOpenClawContext;
}

export const KNOWN_OMC_EVENTS = [
  'session-start',
  'session-end',
  'stop',
  'subagent-stop',
  'pre-tool-use',
  'post-tool-use',
  'user-prompt-submit',
  'keyword-detector',
  'ask-user-question',
  'notification',
  'compact',
] as const;

export type KnownOMCEvent = (typeof KNOWN_OMC_EVENTS)[number];
