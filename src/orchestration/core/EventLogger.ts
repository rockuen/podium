// v0.9.5 — Event ledger MVP.
// v0.9.6 — Council product skeleton: extends EventKind with council.* types.
//
// Append-only NDJSON event log written to
// `<cwd>/.omc/team/logs/orchestrator.ndjson`. Provider-neutral envelope so
// future Codex/Gemini live-team paths can emit into the same ledger without
// a schema migration. Council runs share this ledger so live-routing and
// temporary council activity are observable from one timeline.
//
// Invariants (enforced by callers):
//   - `log()` must never throw into routing. All I/O is wrapped in try/catch
//     here; caller doesn't need its own guard. A persistent write failure
//     emits a single `[eventLogger] warning` line via the supplied
//     OutputChannel-shaped sink and then silently drops further writes until
//     the next successful flush attempt.
//   - VS Code runtime not required: only `fs`, `path`, `crypto`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const EVENT_SCHEMA_VERSION = '0.9.6';

export type EventLevel = 'info' | 'warn' | 'error';

export type EventKind =
  // v0.9.5 — live-routing ledger.
  | 'session.started'
  | 'route.committed'
  | 'drop.written'
  | 'artifact.notified'
  | 'ack.match'
  | 'ack.mismatch'
  | 'redelivery.tagged'
  // v0.12.0 — artifact-only routing (Option C).
  | 'reject.missingArtifactPath'
  // v0.9.6 — Council product skeleton. Full set per v6 plan registered up
  // front so later slices (real participant transport, synthesis, close
  // workflow) can emit into the same ledger without bumping the schema.
  | 'council.opened'
  | 'context_pack.created'
  | 'council.participant.started'
  | 'council.participant.completed'
  | 'council.participant.failed'
  | 'council.synthesis.started'
  | 'council.synthesis.completed'
  | 'council.brief.created'
  | 'council.closed'
  | 'council.brief.injected';

/**
 * Endpoint descriptor. Kept provider-neutral so Codex/Gemini live-team paths
 * can emit the same envelope shape without schema migration. `kind` is the
 * role axis; `provider` is the runtime engine axis. Both optional everywhere
 * except for log lines that explicitly reason about one of them (and in that
 * case the caller fills in what it has).
 */
export interface EventEndpoint {
  /** Logical role in the team graph. */
  kind: 'leader' | 'worker' | 'orchestrator';
  /** Stable id inside the team (e.g. "worker-1"). */
  id?: string;
  /** Provider runtime if known. Free-form for forward compatibility. */
  provider?: string;
}

export interface EventEnvelope {
  schemaVersion: string;
  eventId: string;
  ts: string;
  level: EventLevel;
  type: EventKind;
  podiumSessionId: string;
  turnId?: number;
  messageId?: string;
  correlationId?: string;
  source?: EventEndpoint;
  target?: EventEndpoint;
  payload?: Record<string, unknown>;
}

/**
 * Caller-side input. Everything except `type` is optional; EventLogger fills
 * in `schemaVersion`, `eventId`, `ts`, `level` (default 'info'), and
 * `podiumSessionId` (from its constructor).
 */
export interface EventInput {
  type: EventKind;
  level?: EventLevel;
  turnId?: number;
  messageId?: string;
  correlationId?: string;
  source?: EventEndpoint;
  target?: EventEndpoint;
  payload?: Record<string, unknown>;
}

export interface EventLoggerSink {
  appendLine(line: string): void;
}

export interface EventLoggerOptions {
  /**
   * Workspace root. `.omc/team/logs/orchestrator.ndjson` is created beneath
   * it on first write.
   */
  cwd: string;
  /**
   * Podium-side session id. Provider-neutral — this is NOT the leader CLI's
   * session uuid. Generated per `attach()` so a team instance's lifetime
   * maps 1:1 to one ledger "run".
   */
  podiumSessionId: string;
  /**
   * Optional warning sink. Receives a single line if the ledger hits an I/O
   * error. No-op when absent so tests can construct the logger without a
   * VS Code output channel.
   */
  warn?: EventLoggerSink;
  /**
   * Override the wall clock (tests). Returns ISO-8601 by default.
   */
  nowIso?: () => string;
  /**
   * Override the id generator (tests).
   */
  newEventId?: () => string;
  /**
   * Override the ledger file path. When absent, resolves to
   * `<cwd>/.omc/team/logs/orchestrator.ndjson`.
   */
  filePath?: string;
}

export class EventLogger {
  private readonly filePath: string;
  private readonly podiumSessionId: string;
  private readonly warn: EventLoggerSink | null;
  private readonly nowIso: () => string;
  private readonly newEventId: () => string;
  private warnedOnce = false;
  private disabled = false;

  constructor(opts: EventLoggerOptions) {
    this.podiumSessionId = opts.podiumSessionId;
    this.warn = opts.warn ?? null;
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.newEventId = opts.newEventId ?? (() => randomUUID());
    this.filePath =
      opts.filePath ??
      path.join(opts.cwd, '.omc', 'team', 'logs', 'orchestrator.ndjson');
  }

  /**
   * Append a single event. Never throws into the caller. Returns the
   * written envelope (useful for tests) or `null` if the write was
   * suppressed (disabled after a prior failure, or JSON serialization
   * produced an invalid line).
   */
  log(input: EventInput): EventEnvelope | null {
    if (this.disabled) return null;
    const envelope: EventEnvelope = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: this.newEventId(),
      ts: this.nowIso(),
      level: input.level ?? 'info',
      type: input.type,
      podiumSessionId: this.podiumSessionId,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };

    let line: string;
    try {
      line = JSON.stringify(envelope);
    } catch (err) {
      this.warnOnce(`serialize FAILED — ${this.msg(err)}`);
      return null;
    }

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, line + '\n', 'utf8');
    } catch (err) {
      this.warnOnce(`append FAILED to ${this.filePath} — ${this.msg(err)}`);
      return null;
    }

    return envelope;
  }

  /** Test inspector. */
  get sessionId(): string {
    return this.podiumSessionId;
  }

  /** Test inspector. */
  get path(): string {
    return this.filePath;
  }

  private warnOnce(msg: string): void {
    if (this.warnedOnce) return;
    this.warnedOnce = true;
    this.disabled = true;
    if (this.warn) {
      try {
        this.warn.appendLine(`[eventLogger] warning — ${msg}; further events suppressed`);
      } catch {
        // warning sink failures are themselves swallowed — the logger must
        // never leak an exception back into the routing path.
      }
    }
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
