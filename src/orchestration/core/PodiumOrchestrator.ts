// Phase 2b · v2.7.2 — Leader-driven orchestration engine.
//
// What it does
// ------------
// Given a running LiveMultiPanel with one leader pane and N worker panes,
// observe the leader's output stream, extract `@worker-N:` routing tokens,
// and inject each payload into the corresponding worker's stdin — but only
// once that worker is visibly idle (prompt showing, output stream quiet).
//
// Flow per chunk from the leader pty:
//   leader.pty.onData(raw)
//     → stripAnsi(raw)                    // cleanable text
//     → WorkerPatternParser.feed(text)    // extracts RoutedMessage[]
//     → for each msg:
//         worker = workers[msg.workerId]
//         if worker.idleDetector.isIdle:
//             submitToPty(worker, msg.payload)    // fire now
//             worker.idleDetector.markBusy()
//         else:
//             worker.queue.push(msg.payload)       // defer
//
// A tick loop (pollIntervalMs) drains each worker's queue when that worker
// transitions to idle. We can't rely on a pure event — the IdleDetector is
// time-based and has no clock of its own — so polling at 250ms is the
// simplest correct option. The poll cost is negligible: a handful of
// IdleDetector reads per tick.
//
// Workers *also* have their pty output fed back into their IdleDetector so
// the detector can see the prompt reappear. We only ever WRITE to workers —
// their output is not piped anywhere else by the orchestrator.
//
// Scope (Phase 2b MVP):
//   - No retry on injection failure (logged, then dropped)
//   - No dissolve / summarize (Phase 3)
//   - No dynamic worker add/replace (Phase 5)
//   - No leader injection from sidecar UI (user types in leader pane directly)

// `vscode` is type-only here — the orchestrator never *constructs* anything
// from the vscode module (no EventEmitter, window, etc.). Keeping the import
// type-only lets us exercise the full class under `node --test` without a
// VS Code runtime stub.
import type * as vscode from 'vscode';
import { stripAnsi } from './ansi';
import { IdleDetector } from './idleDetector';
import {
  ClaudeLeaderRoutingProjector,
  WorkerPatternParser,
  type RoutedMessage,
} from './messageRouter';
import { buildSubmitPayload, splitSubmitPayload, needsWin32KeyEvents } from './cliInput';
import type { AgentKind } from './agentSpawn';
import type { LiveMultiPanel } from '../ui/LiveMultiPanel';
import { claudeBareSummarizer, type Summarizer } from './summarizer';

export interface WorkerConfig {
  /** Stable logical id referenced in leader output, e.g. `worker-1`. */
  id: string;
  /** Pane id in the LiveMultiPanel that hosts this worker's CLI. */
  paneId: string;
  agent: AgentKind;
  /** Override idle detection silence window for this worker. */
  silenceMs?: number;
  /**
   * v2.7.19 · Claude session UUID that this pane was spawned with (either
   * via `--session-id` for a new session or `--resume` for a restored
   * session). Used by `captureSnapshot()` so the team can be reopened.
   */
  sessionId?: string;
}

export interface LeaderConfig {
  paneId: string;
  agent: AgentKind;
  /** v2.7.19 · See `WorkerConfig.sessionId`. */
  sessionId?: string;
  /** Display label propagated into the snapshot for human recognition. */
  label?: string;
}

export interface OrchestratorAttachOptions {
  leader: LeaderConfig;
  workers: readonly WorkerConfig[];
  /** Queue drain / idle poll interval (default 250 ms). */
  pollIntervalMs?: number;
  /** Test hook: wall-clock source threaded into every worker's IdleDetector. */
  now?: () => number;
  /** Test hook: skip the internal setInterval. Tests drive `tick()` manually. */
  skipAutoTick?: boolean;
  /** Override duplicate-payload suppression window (default 30 s). */
  dedupeWindowMs?: number;
  /**
   * v2.7.16 · Delay per-worker dispatch by this many ms so that Claude's Ink
   * re-renders (which stream the same `@worker-N:` directive multiple times
   * as the visual wrap firms up) collapse into a single dispatch.
   *
   * Behavior:
   * - 0 (default in tests) → dispatch synchronously, matching legacy.
   * - >0 → hold the message per worker; if a newer parse for the same worker
   *        arrives and EXTENDS the pending payload (prefix match), replace
   *        and restart the timer; otherwise flush the pending one first and
   *        debounce the new one.
   *
   * Production (`index.ts`) sets this to 400 ms, which empirically absorbs
   * Ink's "emit raw text, then rewrap with 2-space indent" double-pulse.
   */
  dispatchDebounceMs?: number;
  /**
   * v2.7.19 · Workspace root the team was launched from. Captured verbatim
   * into snapshots so a restore can re-spawn with the same cwd on a
   * different machine where the project path may be identical via OneDrive
   * sync.
   */
  cwd?: string;
  /**
   * v2.7.19 · Callback invoked on auto-save triggers (dissolve, first pane
   * exit). Receives the captured snapshot; the command layer wires this to
   * `teamSnapshot.saveSnapshot`. Absent in tests.
   */
  onAutoSnapshot?: (snapshot: CapturedSnapshot, source: 'dissolve' | 'pane-exit') => void;
}

/** Minimal snapshot payload surfaced by `PodiumOrchestrator.captureSnapshot`. */
export interface CapturedSnapshot {
  cwd: string;
  leader: { paneId: string; agent: AgentKind; sessionId?: string; label?: string };
  workers: { paneId: string; id: string; agent: AgentKind; sessionId?: string }[];
}

interface WorkerRuntime {
  cfg: WorkerConfig;
  idle: IdleDetector;
  queue: string[];
  /** payload → last-seen ms timestamp. Used to suppress redraw duplicates. */
  recentPayloads: Map<string, number>;
  /** Accumulated stripped output. Tail is kept when the buffer exceeds cap. */
  transcript: string;
}

/** Cap per-worker transcript to avoid unbounded memory growth in long runs. */
const MAX_TRANSCRIPT_CHARS = 50_000;

const DEFAULT_POLL_MS = 250;
// Claude Code v2.1+ uses an Ink TUI that repaints the alt-screen periodically
// (every few seconds, driven by its status-row refresh). Each repaint re-emits
// the same `@worker-N: …` line through the pty, which our line-based parser
// sees as a fresh token. Within this window we suppress exact duplicates per
// worker so a single routing directive doesn't spawn a 10-deep queue.
const DEFAULT_DEDUPE_WINDOW_MS = 30_000;

// v2.7.13: macrotask gap between writing the body and the Win32 Enter
// KEY_EVENT for Claude/Windows worker injects. Empirically 25 ms is enough
// for ConPTY to drain the body bytes through win32-input-mode; any lower
// and worker-2 of a two-way dispatch intermittently lost the submit.
const INJECT_SUBMIT_DELAY_MS = 25;

// v2.7.16: per-worker dispatch holdoff. Only used when attach opts set
// `dispatchDebounceMs` > 0 (production); tests default to 0 (synchronous).
const DEFAULT_DISPATCH_DEBOUNCE_MS = 0;

// v2.7.22: "busy" threshold for the pre-dissolve UX warning. If a worker's
// last real output was more recent than this many ms, show the modal. See
// `busyWorkers()` for the full rationale (prompt-pattern eviction under
// Ink flood). Tuned to avoid warning during normal Ink re-wrap gaps while
// still catching actively-emitting workers.
const BUSY_WARN_MS = 2000;

export class PodiumOrchestrator implements vscode.Disposable {
  private readonly parser = new WorkerPatternParser();
  private readonly workers = new Map<string, WorkerRuntime>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private leader: LeaderConfig | null = null;
  private leaderProjector: ClaudeLeaderRoutingProjector | null = null;
  // The leader's own idle detector — used to trigger parser.flush() when the
  // leader's output stream goes quiet, so compact-form pending tokens that
  // lack a trailing newline/next-token terminator (see messageRouter.ts) get
  // surfaced instead of rotting in the buffer.
  private leaderIdle: IdleDetector | null = null;
  private leaderWasIdle = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private stats = { routed: 0, injected: 0, queued: 0, dropped: 0, deduped: 0, flushed: 0, dissolved: 0 };
  private nowFn: () => number = Date.now;
  private dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS;
  private dispatchDebounceMs = DEFAULT_DISPATCH_DEBOUNCE_MS;
  /** v2.7.16: per-worker pending debounced dispatch (worker id → state). */
  private readonly pendingRoute = new Map<
    string,
    { payload: string; timer: ReturnType<typeof setTimeout> }
  >();
  /** v2.7.19 · Captured cwd for team snapshot export. */
  private attachedCwd: string | null = null;
  /** v2.7.19 · Auto-save hook wired by the command layer (see index.ts). */
  private onAutoSnapshot: ((s: CapturedSnapshot, source: 'dissolve' | 'pane-exit') => void) | null = null;
  /** v2.7.19 · Guard so the first pane exit only triggers one snapshot. */
  private autoSnapshotFired = false;

  constructor(
    private readonly panel: LiveMultiPanel,
    private readonly output: vscode.OutputChannel,
    private readonly summarizer: Summarizer = claudeBareSummarizer,
  ) {}

  attach(opts: OrchestratorAttachOptions): void {
    if (this.leader) {
      this.output.appendLine('[orch] already attached; call dispose() first');
      return;
    }
    this.leader = opts.leader;
    this.leaderProjector = opts.leader.agent === 'claude' ? new ClaudeLeaderRoutingProjector() : null;
    if (opts.now) this.nowFn = opts.now;
    if (opts.dedupeWindowMs !== undefined) this.dedupeWindowMs = opts.dedupeWindowMs;
    if (opts.dispatchDebounceMs !== undefined) this.dispatchDebounceMs = opts.dispatchDebounceMs;
    this.attachedCwd = opts.cwd ?? process.cwd();
    this.onAutoSnapshot = opts.onAutoSnapshot ?? null;
    this.autoSnapshotFired = false;
    this.leaderIdle = new IdleDetector({
      agent: opts.leader.agent,
      silenceMs: 500,
      now: opts.now,
    });
    this.leaderWasIdle = false;
    for (const w of opts.workers) {
      this.workers.set(w.id, {
        cfg: w,
        idle: new IdleDetector({ agent: w.agent, silenceMs: w.silenceMs, now: opts.now }),
        queue: [],
        recentPayloads: new Map(),
        transcript: '',
      });
    }

    this.subscriptions.push(
      this.panel.onPaneData(({ paneId, data }) => this.onPaneData(paneId, data)),
    );
    this.subscriptions.push(
      this.panel.onPaneExit(({ paneId, exitCode }) => {
        this.output.appendLine(`[orch] pane "${paneId}" exit code=${exitCode}`);
        // v2.7.19: first pane exit signals the team is broken. Auto-save
        // a snapshot once so the user can reopen later even if they never
        // ran Dissolve.
        if (!this.autoSnapshotFired && this.onAutoSnapshot && this.leader) {
          this.autoSnapshotFired = true;
          try {
            this.onAutoSnapshot(this.captureSnapshot(), 'pane-exit');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[orch.snapshot] auto-save on pane-exit FAILED — ${msg}`);
          }
        }
      }),
    );

    if (!opts.skipAutoTick) {
      const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
      this.tickTimer = setInterval(() => this.tick(), pollMs);
    }

    this.output.appendLine(
      `[orch] attached — leader=${opts.leader.paneId} (${opts.leader.agent}) workers=${[...this.workers.values()]
        .map((w) => `${w.cfg.id}→${w.cfg.paneId}(${w.cfg.agent})`)
        .join(', ')}`,
    );
  }

  dispose(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const { timer } of this.pendingRoute.values()) clearTimeout(timer);
    this.pendingRoute.clear();
    for (const s of this.subscriptions) s.dispose();
    this.subscriptions.length = 0;
    this.output.appendLine(
      `[orch] detached — routed=${this.stats.routed} injected=${this.stats.injected} queued=${this.stats.queued} deduped=${this.stats.deduped} flushed=${this.stats.flushed} dissolved=${this.stats.dissolved} dropped=${this.stats.dropped}`,
    );
    this.leaderProjector?.reset();
    this.leaderProjector = null;
    this.leader = null;
    this.workers.clear();
  }

  /**
   * v2.7.19 · Capture the current team as a plain data structure suitable
   * for `teamSnapshot.saveSnapshot`. Safe to call at any point while the
   * orchestrator is attached. Workers' sessionIds come from the attach
   * config — they're populated by the caller (index.ts) before spawn.
   */
  captureSnapshot(): CapturedSnapshot {
    if (!this.leader) {
      throw new Error('PodiumOrchestrator.captureSnapshot: not attached');
    }
    return {
      cwd: this.attachedCwd ?? process.cwd(),
      leader: {
        paneId: this.leader.paneId,
        agent: this.leader.agent,
        sessionId: this.leader.sessionId,
        label: this.leader.label,
      },
      workers: [...this.workers.values()].map((w) => ({
        paneId: w.cfg.paneId,
        id: w.cfg.id,
        agent: w.cfg.agent,
        sessionId: w.cfg.sessionId,
      })),
    };
  }

  /**
   * v2.7.21 → v2.7.22 · Report which workers have emitted output recently.
   * Used by the dissolve command to warn the user before summarizing.
   *
   * v2.7.22 fix: we intentionally do NOT gate on `IdleDetector.isIdle` here.
   * `isIdle` requires BOTH silence AND a recognized prompt pattern in the
   * rolling tail — but Claude v2.1+'s Ink TUI repaints the status row
   * (`[OMC#…]`, `⏵⏵ bypass …`) many times per second even while the
   * worker sits idle post-answer, which evicts the actual `>` prompt line
   * out of `rollingTail` within seconds. A worker silent for 48s would
   * still be reported "busy" — false positive blocking the user's dissolve.
   *
   * For the UX warning, "has there been recent output?" is the right
   * question. If the last real output was > BUSY_WARN_MS ago, summarizing
   * is safe (transcript tail has settled). 2s is generous: enough to avoid
   * warning during brief Ink re-wrap gaps, short enough to not stall the
   * user when a worker genuinely finished ~1s ago.
   */
  busyWorkers(): { id: string; msSinceOutput: number }[] {
    const out: { id: string; msSinceOutput: number }[] = [];
    for (const w of this.workers.values()) {
      const ms = w.idle.msSinceOutput;
      if (ms < BUSY_WARN_MS) {
        out.push({ id: w.cfg.id, msSinceOutput: ms });
      }
    }
    return out;
  }

  private onPaneData(paneId: string, rawData: string): void {
    if (this.leader && paneId === this.leader.paneId) {
      this.leaderIdle?.feed(rawData);
      this.leaderWasIdle = false; // incoming data — leader is active
      this.consumeLeaderOutput(rawData);
      return;
    }
    for (const w of this.workers.values()) {
      if (w.cfg.paneId === paneId) {
        w.idle.feed(rawData);
        // Accumulate stripped output for dissolve-time summarization. Keep
        // only the tail to bound memory on long-running teams.
        w.transcript += stripAnsi(rawData);
        if (w.transcript.length > MAX_TRANSCRIPT_CHARS) {
          w.transcript = w.transcript.slice(-MAX_TRANSCRIPT_CHARS);
        }
        return;
      }
    }
  }

  /**
   * Phase 3 · v2.7.8 — Dissolve the team.
   *
   * Flow:
   *   1. Collect each worker's rolling transcript.
   *   2. Ask the summarizer (default: `claude --bare -p --model haiku`) for a
   *      short bullet summary.
   *   3. Kill every worker pane.
   *   4. Inject the summary as a pseudo-user message into the leader's stdin,
   *      so the ongoing conversation can continue with context but without
   *      the live workers.
   *
   * Returns the summary text on success, or null if there was nothing to do.
   * The orchestrator STAYS ATTACHED to the leader afterward — this is
   * "dissolve workers," not "tear everything down." Call `dispose()` to
   * detach fully.
   */
  async dissolve(): Promise<string | null> {
    if (!this.leader) {
      this.output.appendLine('[orch.dissolve] no leader attached; nothing to do');
      return null;
    }
    const items = [...this.workers.values()].map((w) => ({
      workerId: w.cfg.id,
      transcript: w.transcript,
    }));
    if (items.length === 0) {
      this.output.appendLine('[orch.dissolve] no workers to dissolve');
      return null;
    }
    this.output.appendLine(
      `[orch.dissolve] summarizing ${items.length} worker(s) (${items
        .map((i) => `${i.workerId}=${i.transcript.length}ch`)
        .join(', ')})...`,
    );

    let summary: string;
    try {
      summary = await this.summarizer(items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[orch.dissolve] summarizer FAILED — ${msg}`);
      // Fallback: raw tails so the user still gets something injectable.
      summary = items
        .map((i) => `- ${i.workerId}: (raw tail) ${trimForFallback(i.transcript)}`)
        .join('\n');
    }
    this.output.appendLine(`[orch.dissolve] summary received (${summary.length} chars)`);

    const workerIds = [...this.workers.values()].map((w) => w.cfg.paneId);
    for (const paneId of workerIds) {
      this.panel.removePane(paneId);
    }
    this.workers.clear();
    this.stats.dissolved += workerIds.length;
    this.output.appendLine(`[orch.dissolve] killed ${workerIds.length} worker pane(s)`);

    const injection = [
      '[Team dissolved — worker outputs summarized below]',
      summary.trim(),
      '',
      'The workers are no longer available. Continue the conversation using this context.',
    ].join('\n');
    const bytes = buildSubmitPayload(injection, { agent: this.leader.agent });
    try {
      this.panel.writeToPane(this.leader.paneId, bytes);
      this.output.appendLine('[orch.dissolve] summary injected into leader stdin');
      // v2.7.19: Dissolve is a natural "checkpoint" moment. Snapshot the
      // team so the user can pick the conversation back up later.
      if (!this.autoSnapshotFired && this.onAutoSnapshot) {
        this.autoSnapshotFired = true;
        try {
          this.onAutoSnapshot(this.captureSnapshot(), 'dissolve');
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          this.output.appendLine(`[orch.snapshot] auto-save on dissolve FAILED — ${m}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[orch.dissolve] leader injection failed — ${msg}`);
    }
    return summary;
  }

  private consumeLeaderOutput(rawData: string): void {
    // v2.7.21 · After dissolve the workers Map is cleared but the leader
    // pane stays alive. Ink keeps repainting the scrollback (including old
    // `@worker-N:` directives), which previously produced a stream of
    // "leader referenced unknown" log entries. With zero workers there's
    // nothing to route to — short-circuit before the projector accumulates
    // ghost state. Leader's pty → webview rendering is unaffected (that
    // flow is handled by LiveMultiPanel, not here).
    if (this.workers.size === 0) return;

    const cleaned = stripAnsi(rawData);
    const projected = this.leaderProjector ? this.leaderProjector.feed(cleaned) : cleaned;

    // Diagnostic trace (v2.7.5): if the leader's cleaned output contains the
    // substring "@worker" at all, log it so we can see exactly what the
    // parser gets. This is the only way to distinguish between
    //   (a) data never reaches the parser,
    //   (b) parser sees it but regex fails to match,
    //   (c) parser matches and route() short-circuits silently.
    // We log the raw codepoints around the first `@worker` occurrence so we
    // can identify unexpected bullet glyphs / zero-width chars / indent shapes.
    if (cleaned.includes('@worker')) {
      const idx = cleaned.indexOf('@worker');
      const before = cleaned.slice(Math.max(0, idx - 20), idx);
      const window = cleaned.slice(idx, Math.min(cleaned.length, idx + 80));
      const beforeCodes = [...before].map((c) => c.charCodeAt(0).toString(16)).join(' ');
      this.output.appendLine(
        `[orch.trace] leader @worker chunk — before=[${beforeCodes}] window=${JSON.stringify(window)}`,
      );
      if (!projected.includes('@worker')) {
        this.output.appendLine('[orch.trace] leader @worker chunk suppressed by Claude assistant projector');
      }
    }

    if (!projected) return;

    const msgs = this.parser.feed(projected);
    if (msgs.length > 0) {
      this.output.appendLine(
        `[orch.trace] parser yielded ${msgs.length} msg(s): ${msgs.map((m) => `${m.workerId}=${preview(m.payload, 30)}`).join(', ')}`,
      );
    }

    // v2.7.17 · Ink-activity-aware debounce extension
    // ------------------------------------------------
    // While the leader is still actively emitting assistant content (projector
    // yielded a non-empty chunk), push every pending dispatch timer forward by
    // one full debounce window. This keeps a half-emitted routing directive
    // from firing before Ink completes its re-wrap pass. Status-bar-only
    // chunks return empty from the projector and don't extend — pending
    // dispatches can still expire normally when the leader truly goes quiet.
    if (projected.length > 0) this.extendPendingTimers();

    for (const m of msgs) this.route(m);
  }

  private extendPendingTimers(): void {
    if (this.dispatchDebounceMs <= 0) return;
    for (const [workerId, entry] of this.pendingRoute) {
      this.armDispatchTimer(workerId, entry.payload);
    }
  }

  private route(msg: RoutedMessage): void {
    this.stats.routed += 1;
    const w = this.workers.get(msg.workerId);
    if (!w) {
      this.output.appendLine(
        `[orch] leader referenced unknown "${msg.workerId}" — dropped (payload: ${preview(msg.payload)})`,
      );
      this.stats.dropped += 1;
      return;
    }

    if (this.dispatchDebounceMs <= 0) {
      this.commitRoute(w, msg.payload);
      return;
    }

    // v2.7.16 · Ink re-render absorber
    // --------------------------------
    // Claude's TUI often emits a routing line twice: a raw early pulse
    // (truncated at a real `\n`) then a settled pulse with the line visually
    // wrapped via 2-space indent. Pre-v2.7.16 we fired on the raw pulse and
    // queued the settled version, so workers saw the short prompt first and
    // the full one afterwards. Here we hold each worker's latest payload,
    // replace it if the next parse extends it (prefix match), and only
    // commit after the TUI settles.
    const existing = this.pendingRoute.get(w.cfg.id);
    if (existing) {
      clearTimeout(existing.timer);
      const newExtendsOld = msg.payload.startsWith(existing.payload);
      const oldExtendsNew = existing.payload.startsWith(msg.payload);
      if (!newExtendsOld && !oldExtendsNew) {
        // Different logical task — flush the pending one now so we don't
        // lose it, then debounce the new one below.
        this.commitRoute(w, existing.payload);
      }
      // If oldExtendsNew (new is a shrinking prefix), treat the pending one
      // as authoritative and let it re-arm below with the longer text kept
      // via the early-return below.
      if (oldExtendsNew && !newExtendsOld) {
        const timer = setTimeout(() => {
          this.pendingRoute.delete(w.cfg.id);
          this.commitRoute(w, existing.payload);
        }, this.dispatchDebounceMs);
        this.pendingRoute.set(w.cfg.id, { payload: existing.payload, timer });
        return;
      }
    }
    this.armDispatchTimer(w.cfg.id, msg.payload);
  }

  private armDispatchTimer(workerId: string, payload: string): void {
    const existing = this.pendingRoute.get(workerId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.tryDispatchPending(workerId, payload), this.dispatchDebounceMs);
    this.pendingRoute.set(workerId, { payload, timer });
  }

  /**
   * v2.7.18 · Leader-idle-gated dispatch
   * ------------------------------------
   * Even with debounce + activity extension, Claude Ink can pause emitting
   * for longer than the debounce window (~1s+) in the middle of re-rendering
   * a long `@worker-N:` line. If the timer fires while the leader is still
   * mid-stream, we'd commit the stale first-pulse payload. Here we ask the
   * leader's idle detector: if it says the leader is still active (no
   * prompt + silence signal yet), re-arm for another debounce window. Only
   * commit when the leader has demonstrably stopped talking.
   */
  private tryDispatchPending(workerId: string, payload: string): void {
    if (this.leaderIdle && !this.leaderIdle.isIdle) {
      this.armDispatchTimer(workerId, payload);
      return;
    }
    this.pendingRoute.delete(workerId);
    const w = this.workers.get(workerId);
    if (w) this.commitRoute(w, payload);
  }

  private commitRoute(w: WorkerRuntime, payload: string): void {
    // Redraw dedupe: Claude's Ink UI repaints the same line on every status
    // tick. Suppress any payload we've seen for this worker within the dedupe
    // window. First hit logs as dedup-suppressed; silent for subsequent hits.
    const nowMs = this.nowFn();
    this.pruneRecent(w, nowMs);
    const lastSeen = w.recentPayloads.get(payload);
    if (lastSeen !== undefined) {
      this.stats.deduped += 1;
      return;
    }
    w.recentPayloads.set(payload, nowMs);

    if (w.idle.isIdle) {
      this.inject(w, payload);
    } else {
      w.queue.push(payload);
      this.stats.queued += 1;
      this.output.appendLine(
        `[orch] queue ${w.cfg.id} (busy, queue=${w.queue.length}): ${preview(payload)}`,
      );
    }
  }

  private pruneRecent(w: WorkerRuntime, nowMs: number): void {
    for (const [payload, t] of w.recentPayloads) {
      if (nowMs - t >= this.dedupeWindowMs) w.recentPayloads.delete(payload);
    }
  }

  private inject(w: WorkerRuntime, payload: string): void {
    // v2.7.13: on Windows+Claude, split body and submit. Writing a long
    // UTF-8 body plus the Win32 Enter KEY_EVENT in one `pty.write` call was
    // observed to lose the Enter for worker-2 (the second of two back-to-
    // back dispatches) even though worker-1 with a shorter payload fired
    // fine. A short macrotask gap lets ConPTY flush the body bytes through
    // win32-input-mode before the submit sequence arrives.
    const paneId = w.cfg.paneId;
    const opts = { agent: w.cfg.agent };
    try {
      if (needsWin32KeyEvents(opts)) {
        const { body, submit } = splitSubmitPayload(payload, opts);
        this.panel.writeToPane(paneId, body);
        setTimeout(() => {
          try {
            this.panel.writeToPane(paneId, submit);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[orch] inject submit → ${w.cfg.id} FAILED — ${msg}`);
          }
        }, INJECT_SUBMIT_DELAY_MS);
      } else {
        const bytes = buildSubmitPayload(payload, opts);
        this.panel.writeToPane(paneId, bytes);
      }
      w.idle.markBusy();
      this.stats.injected += 1;
      this.output.appendLine(`[orch] → ${w.cfg.id}: ${preview(payload)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[orch] inject → ${w.cfg.id} FAILED — ${msg}`);
      this.stats.dropped += 1;
    }
  }

  /**
   * Drain one queued payload per idle worker. Also flush the parser when the
   * leader transitions to idle, so compact-form tokens without a trailing
   * terminator (e.g. `●@worker-1:x@worker-2:y` with no \n) get delivered.
   * Exposed (not private) so tests can step the engine without real time.
   */
  tick(): void {
    // Leader idle edge: busy → idle transition flushes the parser.
    if (this.leaderIdle && this.leaderIdle.isIdle && !this.leaderWasIdle) {
      const pending = this.parser.flush();
      if (pending.length > 0) {
        this.stats.flushed += pending.length;
        this.output.appendLine(
          `[orch] leader idle — flushed ${pending.length} pending routing msg(s)`,
        );
        for (const m of pending) this.route(m);
      }
      this.leaderWasIdle = true;
    } else if (this.leaderIdle && !this.leaderIdle.isIdle) {
      this.leaderWasIdle = false;
    }
    for (const w of this.workers.values()) {
      if (w.queue.length > 0 && w.idle.isIdle) {
        const next = w.queue.shift();
        if (next !== undefined) this.inject(w, next);
      }
    }
  }

  /** Test hook. */
  get snapshot() {
    return {
      leader: this.leader,
      workers: [...this.workers.values()].map((w) => ({
        id: w.cfg.id,
        paneId: w.cfg.paneId,
        agent: w.cfg.agent,
        queueLen: w.queue.length,
        idle: w.idle.isIdle,
      })),
      stats: { ...this.stats },
    };
  }
}

function preview(text: string, max = 60): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

function trimForFallback(transcript: string): string {
  const tail = transcript.slice(-400).replace(/\s+/g, ' ').trim();
  return tail.length > 0 ? tail : '(no output captured)';
}
