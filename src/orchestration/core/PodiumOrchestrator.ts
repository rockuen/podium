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
import { randomUUID } from 'node:crypto';
import { stripAnsi } from './ansi';
import { IdleDetector } from './idleDetector';
import {
  ClaudeLeaderRoutingProjector,
  WorkerPatternParser,
  type RoutedMessage,
} from './messageRouter';
import { buildSubmitPayload, splitSubmitPayload, needsWin32KeyEvents } from './cliInput';
import type { AgentKind } from './agentSpawn';
import type { LiveMultiPanel, LivePaneSpec } from '../ui/LiveMultiPanel';
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
  /**
   * v2.7.25 · Display-only label (runtime-renamable via `renameWorker`).
   * Routing uses `id`, not `label` — the routing key is immutable.
   * Mirrors `LeaderConfig.label`; propagated into `CapturedSnapshot.workers`
   * so snapshot save/restore preserves user-assigned names.
   */
  label?: string;
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
  /**
   * v2.7.28 · Restore grace window. When set, any routing directive parsed
   * from the leader within `restoreGraceMs` of `attach()` is dropped with a
   * log line. Rationale: on `snapshot.load`, the leader pane spawns with
   * `--resume <uuid>`, which causes Claude CLI to replay its prior
   * conversation into the alt-screen scrollback. As Ink repaints that
   * scrollback, its stream contains `@worker-N: ...` directives that were
   * already routed+executed in the ORIGINAL session. Without a grace
   * window the fresh orchestrator (empty `recentPayloads`) treats them as
   * new directives and re-injects them into the just-restored worker
   * panes, causing unwanted re-execution.
   *
   * The window only affects the parser → route dispatch path. IdleDetector,
   * transcript accumulation, and leader-notify commits are unaffected —
   * they need to see the replayed bytes so the orchestrator's "is leader
   * idle?" answer stays correct.
   *
   * Set to 0 or omit for fresh orchestrate (no scrollback to replay).
   * `index.ts` snapshot.load passes 3000 (3s), empirically long enough for
   * Ink to settle after the resume-driven repaint.
   */
  restoreGraceMs?: number;
}

/** Minimal snapshot payload surfaced by `PodiumOrchestrator.captureSnapshot`. */
export interface CapturedSnapshot {
  cwd: string;
  leader: { paneId: string; agent: AgentKind; sessionId?: string; label?: string };
  workers: { paneId: string; id: string; agent: AgentKind; sessionId?: string; label?: string }[];
}

/**
 * v2.7.25 · Exported so `TeamsTreeProvider` (Step 6) can type its children
 * off the array returned by `PodiumOrchestrator.listWorkers()`.
 */
export interface WorkerRuntime {
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

/**
 * v2.7.25 · Runtime worker-count cap introduced for dynamic `addWorker`.
 * Chosen to equal `MAX_SNAPSHOTS = 10` at `teamSnapshot.ts:33` so no team
 * can exceed snapshot retention, and to mirror the prompt-level
 * `totalWorkers > 10` guard at `SpawnTeamPanel.ts:200-202` so UX is
 * consistent across spawn-time and runtime paths. The SpawnTeamPanel check
 * is prompt-level (input-slot aggregation) only; this constant is the
 * runtime invariant for the mutable worker Map.
 */
export const MAX_RUNTIME_WORKERS = 10;

// v2.7.25: wall-clock deadline for the idle-gated leader notify. After this
// many ms, `scheduleLeaderNotify` commits the write even if the leader is
// still mid-assistant-turn. Bounds the worst-case UX latency between an
// add/remove click and the leader-pane `[system] ...` notice.
const NOTIFY_GATE_DEADLINE_MS = 2000;
// v2.7.25: idle-poll interval inside `scheduleLeaderNotify`. Mirrors the
// `DEFAULT_POLL_MS` cadence so we don't spin faster than the main tick loop.
const NOTIFY_GATE_POLL_MS = 250;
// v2.7.25: window (ms) after `addWorker` returns during which an
// `@worker-N:` from the leader is still considered a race. If a
// `leader referenced unknown` drop lands within this window, the notify-
// commit log surfaces the race so production tuning can observe it.
const ADD_WORKER_RACE_WINDOW_MS = 500;

// v2.7.31 (was v2.7.29): after a snapshot restore, the grace window stays
// open until `leaderIdle.isIdle === true` — i.e. a prompt pattern is visible
// in the rolling tail AND the leader has been silent for ≥500ms. Claude CLI's
// `--resume` replays the prior conversation into the Ink alt-screen; the
// prompt box is only painted at the end of that replay, so waiting for the
// prompt reliably means the replay settled. v2.7.29 used raw silence
// (`msSinceOutput >= 1000`) which mis-fired during the post-spawn session-
// loading gap when leader hadn't emitted anything yet — grace closed with
// `dropped 0` before scrollback arrived, and replayed directives routed
// live. `isIdle` rejects that case because an empty rolling tail can never
// match a prompt pattern. Paired with `restoreGraceMs` as a hard wall-clock
// cap (15s default in production).

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
  /**
   * v2.7.28 · Restore grace bookkeeping. `restoreGraceEndsAt === null` means
   * the window has closed or was never opened; otherwise it's the
   * `nowFn()`-relative timestamp at which routing resumes.
   */
  private restoreGraceEndsAt: number | null = null;
  private restoreGraceDroppedCount = 0;
  /**
   * v2.7.25 · Per-worker timestamp of last `addWorker` return. Used only
   * for the race-window observability log in `route()` when a
   * `leader referenced unknown` would otherwise drop silently.
   */
  private readonly recentAdds = new Map<string, number>();

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
    // v2.7.28: arm the restore grace window if caller requested one.
    if (opts.restoreGraceMs && opts.restoreGraceMs > 0) {
      this.restoreGraceEndsAt = this.nowFn() + opts.restoreGraceMs;
      this.restoreGraceDroppedCount = 0;
      this.output.appendLine(
        `[orch.restoreGrace] armed for ${opts.restoreGraceMs}ms — routing directives from leader scrollback replay will be dropped`,
      );
    } else {
      this.restoreGraceEndsAt = null;
      this.restoreGraceDroppedCount = 0;
    }
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
    this.recentAdds.clear();
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
   * v2.7.25 · Dynamically add a worker to the running orchestrator.
   *
   * Rollback-safe ordering (ADR-1, Option A1 · pane-first):
   *   1. `panel.addPane(spec)` — may silently fail (addPane logs + returns
   *      without throwing on spawn errors).
   *   2. Verify via `panel.hasPane(id)` — if false, throw before any Map
   *      mutation occurs. `workers` never observes a ghost entry.
   *   3. Build `WorkerRuntime` with fresh IdleDetector + empty queue/
   *      recentPayloads/transcript (mirrors `attach()`'s construction).
   *   4. `workers.set(cfg.id, runtime)`.
   *   5. Stamp `recentAdds` for race-window observability in `route()`.
   *   6. `scheduleLeaderNotify` ("worker-N joined…") — idle-gated with 2s
   *      deadline, so echoes don't extend pending route timers and Win32
   *      Shift+Enter encoding doesn't merge into in-progress user typing.
   *
   * Guards:
   *   - Not attached → throws `addWorker: not attached`.
   *   - `workers.size >= MAX_RUNTIME_WORKERS` → throws with cap message.
   *   - Duplicate `cfg.id` → throws.
   */
  async addWorker(cfg: WorkerConfig): Promise<void> {
    if (!this.leader) {
      throw new Error('addWorker: not attached');
    }
    if (this.workers.size >= MAX_RUNTIME_WORKERS) {
      throw new Error(
        `addWorker: workers.size (${this.workers.size}) has hit MAX_RUNTIME_WORKERS cap (${MAX_RUNTIME_WORKERS})`,
      );
    }
    if (this.workers.has(cfg.id)) {
      throw new Error(`addWorker: duplicate id "${cfg.id}"`);
    }

    const sessionId = cfg.sessionId ?? randomUUID();
    const spec: LivePaneSpec = {
      paneId: cfg.paneId,
      label: cfg.label ?? cfg.id,
      agent: cfg.agent,
      sessionId,
      cwd: this.attachedCwd ?? process.cwd(),
    };

    // Step 1 · pane-first
    this.panel.addPane(spec);
    // Step 2 · verify (addPane swallows spawn failures)
    if (!this.panel.hasPane(cfg.paneId)) {
      throw new Error(`addWorker: pane spawn failed for "${cfg.paneId}"`);
    }

    // Step 3-4 · runtime construction + map insertion. Preserve `cfg` but
    // stamp the resolved sessionId so captureSnapshot() can serialize it.
    const resolvedCfg: WorkerConfig = { ...cfg, sessionId };
    const runtime: WorkerRuntime = {
      cfg: resolvedCfg,
      idle: new IdleDetector({
        agent: cfg.agent,
        silenceMs: cfg.silenceMs,
        now: this.nowFn,
      }),
      queue: [],
      recentPayloads: new Map(),
      transcript: '',
    };
    this.workers.set(cfg.id, runtime);

    // Step 5 · race-window stamp. Cleaned up after the window elapses so
    // the Map doesn't grow unbounded on long sessions.
    this.recentAdds.set(cfg.id, this.nowFn());
    setTimeout(() => {
      this.recentAdds.delete(cfg.id);
    }, ADD_WORKER_RACE_WINDOW_MS + 50);

    this.output.appendLine(
      `[orch] addWorker ${cfg.id} → ${cfg.paneId} (${cfg.agent})`,
    );

    // Step 6 · idle-gated leader notify. No `@` in the body — the
    // substring assertion inside scheduleLeaderNotify would throw.
    const shortId = cfg.id.replace(/^worker-/, '');
    this.scheduleLeaderNotify(
      `worker-${shortId} joined. You can now route to it using the standard routing syntax.`,
    );
  }

  /**
   * v2.7.25 · Dynamically remove a worker from the running orchestrator.
   *
   * Cleanup order (spec §Remove Worker):
   *   1. Clear any pending debounce timer + pendingRoute entry for this id.
   *   2. Drain worker.queue and recentPayloads.
   *   3. `workers.delete(id)`.
   *   4. `panel.removePane(paneId)` — pane-kill last so subscribers see the
   *      cleanup state before the pty exits.
   *   5. `scheduleLeaderNotify` with drop count.
   *
   * No-op (warn-log) when id is unknown. Never throws for missing id —
   * matches `renameWorker` semantics.
   */
  async removeWorker(id: string): Promise<void> {
    const worker = this.workers.get(id);
    if (!worker) {
      this.output.appendLine(`[orch] removeWorker: no such worker "${id}"`);
      return;
    }

    const droppedQueue = worker.queue.length;
    const droppedPending = this.pendingRoute.has(id) ? 1 : 0;
    const droppedCount = droppedQueue + droppedPending;

    // Step 1 · pending debounce timer + entry
    const pending = this.pendingRoute.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRoute.delete(id);
    }
    // Step 2 · runtime maps
    worker.queue.length = 0;
    worker.recentPayloads.clear();
    // Step 3 · orchestrator map
    this.workers.delete(id);
    // Also drop any recent-add stamp so a same-id re-add starts clean.
    this.recentAdds.delete(id);
    // Step 4 · pane kill
    this.panel.removePane(worker.cfg.paneId);

    this.output.appendLine(
      `[orch] removeWorker ${id} droppedCount=${droppedCount} (queue=${droppedQueue} pending=${droppedPending})`,
    );

    // Step 5 · notify
    const shortId = id.replace(/^worker-/, '');
    const notifyBody =
      droppedCount > 0
        ? `worker-${shortId} removed (${droppedCount} pending dropped)`
        : `worker-${shortId} removed (no pending)`;
    this.scheduleLeaderNotify(notifyBody);
  }

  /**
   * v2.7.25 · Rename a worker's display label.
   *
   * Label-only: `cfg.id` (the routing key) is NEVER changed. `@worker-N:`
   * routing continues to use the original id. Silent on missing worker
   * (warn-log only) — matches `removeWorker` semantics. Throws on empty /
   * whitespace-only label.
   */
  renameWorker(id: string, displayName: string): void {
    if (displayName.trim().length === 0) {
      throw new Error('renameWorker: label required');
    }
    const worker = this.workers.get(id);
    if (!worker) {
      this.output.appendLine(`[orch] renameWorker: no such worker "${id}"`);
      return;
    }
    const trimmed = displayName.trim();
    worker.cfg = { ...worker.cfg, label: trimmed };
    this.output.appendLine(`[orch] renameWorker ${id} → "${trimmed}"`);
  }

  /**
   * v2.7.25 · Public read-accessor for the worker map. Consumed by
   * `TeamsTreeProvider` to render the Podium live-team children. Returns
   * a snapshot array — internal Map mutation is not exposed. The test-only
   * `snapshot` getter above remains for unit tests that inspect queue/idle
   * state.
   */
  listWorkers(): WorkerRuntime[] {
    return [...this.workers.values()];
  }

  /**
   * v2.7.19 · Capture the current team as a plain data structure suitable
   * for `teamSnapshot.saveSnapshot`. Safe to call at any point while the
   * orchestrator is attached. Workers' sessionIds come from the attach
   * config — they're populated by the caller (index.ts) before spawn.
   */
  /**
   * v2.7.27 · Whether `dispose()` has been called (either by `killAll`, by
   * the panel's `onDidDispose` handler, or by a consumer). The tree provider
   * uses this to skip stale registry entries; the command handlers can also
   * short-circuit on a disposed orchestrator instead of racing with cleanup.
   */
  get isDisposed(): boolean {
    return this.leader === null;
  }

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
        label: w.cfg.label,
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
    // v2.7.25: clear any pending debounce timers whose target workers just went
    // away. Without this, the timers fire, land in tryDispatchPending, find no
    // worker in the Map, and no-op — benign but leaks setTimeout handles until
    // dispose(). removeWorker already clears per-worker; dissolve needs the
    // bulk version.
    for (const { timer } of this.pendingRoute.values()) clearTimeout(timer);
    this.pendingRoute.clear();
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

    // v2.7.29: restore grace is idle-gated but the state transition lives in
    // `tick()` (not here). Rationale: `onPaneData` calls `leaderIdle.feed`
    // BEFORE `consumeLeaderOutput` → `route()`, so by the time route() runs
    // the chunk that triggered it has already bumped `lastOutputAt` to now.
    // `msSinceOutput` would always read 0 here. tick() runs every 250ms
    // between pane data events, which is where `msSinceOutput` actually
    // grows large enough to signal "leader settled". See `tick()` for the
    // close logic. Here we just honor whichever state tick() set.
    if (this.restoreGraceEndsAt !== null) {
      this.stats.dropped += 1;
      this.restoreGraceDroppedCount += 1;
      this.output.appendLine(
        `[orch.restoreGrace] dropped routing to "${msg.workerId}": ${preview(msg.payload)}`,
      );
      return;
    }

    const w = this.workers.get(msg.workerId);
    if (!w) {
      this.output.appendLine(
        `[orch] leader referenced unknown "${msg.workerId}" — dropped (payload: ${preview(msg.payload)})`,
      );
      // v2.7.25: if this id was `addWorker`'d very recently, the leader may
      // have referenced the new id before our `workers.set` landed. Surface
      // the race window so production tuning can observe it.
      const addedAt = this.recentAdds.get(msg.workerId);
      if (addedAt !== undefined) {
        const window = this.nowFn() - addedAt;
        if (window <= ADD_WORKER_RACE_WINDOW_MS) {
          this.output.appendLine(
            `[orch] addWorker racing leader reference — window=${window}ms id=${msg.workerId}`,
          );
        }
      }
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
   * v2.7.25 · Idle-gated leader notification used by `addWorker` /
   * `removeWorker` to inform the model that its routable worker set has
   * changed. Writes `[system] ${text}` into the leader's pty stdin via the
   * same Win32 split-write pattern as `inject()`.
   *
   * Why idle-gated (ADR-2 revised under Fix 1): writing to the leader pane
   * echoes back through the output stream. `consumeLeaderOutput` feeds the
   * projector; a non-empty projector chunk triggers `extendPendingTimers`,
   * which re-arms every pending worker-route timer by one full debounce
   * window. Fire-and-forget notify would delay legitimate `@worker-N:`
   * routing. On Win32-Claude, `buildSubmitPayload` also encodes embedded
   * `\n` into Shift+Enter keydown/keyup pairs; writing mid-typing would
   * merge the notify into the user's in-progress input line.
   *
   * Substring assertion: `@worker-` is forbidden in the body so a notify
   * can never self-route through `messageRouter` after echoing back.
   * All internal callers use safe phrasings ("worker-N joined",
   * "worker-N removed (k pending dropped)") — no `@`.
   *
   * The gate polls `leaderIdle.isIdle` every `NOTIFY_GATE_POLL_MS`. It
   * commits on first idle OR when `(now - t0) >= NOTIFY_GATE_DEADLINE_MS`.
   * Detach / dispose during the wait silently aborts. Notify failures are
   * logged but never propagate back to the caller.
   */
  private scheduleLeaderNotify(text: string): void {
    // Invariant: prevent self-routing via echo.
    if (text.includes('@worker-')) {
      throw new Error('[orch.leaderNotify] forbidden substring @worker- in notify body');
    }
    if (!this.leader) return;

    const t0 = this.nowFn();
    const body = `[system] ${text}`;

    const commit = () => {
      // Re-check attachment — dispose may have fired during the poll window.
      if (!this.leader) return;
      const agent = this.leader.agent;
      const paneId = this.leader.paneId;
      const opts = { agent };
      try {
        if (needsWin32KeyEvents(opts)) {
          const { body: bytes, submit } = splitSubmitPayload(body, opts);
          this.panel.writeToPane(paneId, bytes);
          setTimeout(() => {
            try {
              this.panel.writeToPane(paneId, submit);
            } catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              this.output.appendLine(`[orch.leaderNotify] submit write FAILED — ${m}`);
            }
          }, INJECT_SUBMIT_DELAY_MS);
        } else {
          this.panel.writeToPane(paneId, buildSubmitPayload(body, opts));
        }
        const waited = this.nowFn() - t0;
        this.output.appendLine(
          `[orch.leaderNotify] committed waited=${waited}ms text=${preview(text)}`,
        );
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[orch.leaderNotify] commit FAILED — ${m}`);
      }
    };

    const arm = () => {
      // Detach / dispose during the wait → silently abort.
      if (!this.leader) return;
      const elapsed = this.nowFn() - t0;
      const idleReady = !this.leaderIdle || this.leaderIdle.isIdle;
      if (idleReady || elapsed >= NOTIFY_GATE_DEADLINE_MS) {
        commit();
        return;
      }
      setTimeout(arm, NOTIFY_GATE_POLL_MS);
    };

    // First check is synchronous — if leader is already idle, commit
    // without any timer jitter.
    arm();
  }

  /**
   * Drain one queued payload per idle worker. Also flush the parser when the
   * leader transitions to idle, so compact-form tokens without a trailing
   * terminator (e.g. `●@worker-1:x@worker-2:y` with no \n) get delivered.
   * Exposed (not private) so tests can step the engine without real time.
   */
  tick(): void {
    // v2.7.31: restore grace state machine. Close the window when the leader
    // has reached `leaderIdle.isIdle` — a prompt pattern is visible in the
    // rolling tail (`>`, `[OMC#...]`, `╰──`, or equivalent) AND the leader
    // has been silent for ≥500ms. That combination signals the `--resume`
    // scrollback replay actually finished painting, not merely that
    // Claude CLI is still loading the session and hasn't started emitting.
    //
    // Why this replaced v2.7.29's raw `msSinceOutput >= 1s` check
    // ------------------------------------------------------------
    // Field report on 2026-04-22: after snapshot restore, the grace window
    // closed with `dropped 0` BEFORE any `@worker-N:` directives reached
    // route(), and worker panes re-executed the replayed directives.
    // `IdleDetector.lastOutputAt` is seeded at construction time, so the raw
    // `msSinceOutput` monotonically grows from zero even when the leader has
    // never emitted a single byte — the 1s idle threshold was hit during
    // Claude CLI's post-spawn session-loading silence, well before the
    // scrollback burst arrived. `isIdle` requires a prompt pattern which is
    // only painted at the end of the replay, so it can't fire during the
    // loading gap.
    //
    // Also closes via the hard wall-clock cap (`restoreGraceEndsAt`, 15s
    // default) as a safety net for a wedged leader that never paints a
    // prompt. Lives in tick() not route() because `leaderIdle.feed()` bumps
    // `lastOutputAt` to `now` in the same onPaneData call that feeds route(),
    // so `isIdle` would always return false inside route(). tick() runs
    // every 250ms between pane data events, which is where the leader's
    // settled state becomes observable.
    if (this.restoreGraceEndsAt !== null && this.leaderIdle) {
      const leaderSettled = this.leaderIdle.isIdle;
      const pastDeadline = this.nowFn() >= this.restoreGraceEndsAt;
      if (leaderSettled || pastDeadline) {
        const reason = pastDeadline ? 'deadline' : 'leader-idle';
        this.output.appendLine(
          `[orch.restoreGrace] window closed (${reason}) — dropped ${this.restoreGraceDroppedCount} directive(s) from scrollback replay; live routing active`,
        );
        this.restoreGraceEndsAt = null;
      }
    }
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
