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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripAnsi } from './ansi';
import { IdleDetector } from './idleDetector';
import {
  ClaudeLeaderRoutingProjector,
  WorkerPatternParser,
  type RoutedMessage,
} from './messageRouter';
import { buildSubmitPayload, splitSubmitPayload, needsWin32KeyEvents } from './cliInput';
import type { AgentKind } from './agentSpawn';
import type { LivePaneSpec, OrchestratorPanel } from '../ui/LiveMultiPanel';
import { claudeBareSummarizer, type Summarizer } from './summarizer';
import type { WorkerRole } from './workerProtocol';

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
  /**
   * v0.3.0 · Worker role for hub-and-spoke orchestration. The role shapes
   * the worker's system prompt (via `workerProtocol.buildWorkerSystemPrompt`)
   * and lets the leader pick the right worker for each sub-task. Routing
   * still uses `id`; `role` is for prompting + leader-side reasoning only.
   * Absent when the caller spawns a plain worker (legacy `podium.orchestrate`
   * command); present when the caller uses the role-aware spawn path.
   */
  role?: WorkerRole;
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
  /**
   * v0.3.0 · Enable bidirectional routing. When true, each worker's output
   * is ALSO parsed for `@leader:` / `@worker-N:` directives, enabling
   * workers to reply to the leader (hub-and-spoke) and route to peers.
   * Default false preserves the legacy one-way (leader → worker) flow so
   * existing tests and the baseline `podium.orchestrate` command behave
   * identically.
   */
  enableWorkerRouting?: boolean;
  /**
   * v0.3.0 · Maximum number of routed directives per "task" before the
   * orchestrator force-converges. Each committed routing event (leader→worker,
   * worker→leader, worker→worker) counts as one. When the cap is hit a
   * single `[system] round cap reached, please converge` notice is injected
   * into the leader and further routing is dropped until `resetRound()` is
   * called or the team goes idle for `autoResetRoundMs`.
   *
   * 0 disables the cap (legacy behavior). Default 5, tuned against the
   * multi-agent literature's convergence sweet spot.
   */
  maxRoundsPerTask?: number;
  /**
   * v0.3.0 · When both leader and all workers have been idle this long with
   * no further routing, the round counter auto-resets to 0 so the next user
   * prompt starts fresh without requiring a manual `resetRound()`.
   * Default 30_000 (30s). Set to 0 to disable auto-reset.
   */
  autoResetRoundMs?: number;
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
  /**
   * payload-key → { turnId, ts } used for dedupe.
   *
   * v0.5.0 (strategy "B"): entries carry the leader turnId at which the
   * route was first committed. commitRoute drops incoming payloads whose
   * key was already routed IN THE SAME TURN, regardless of how many
   * times Ink repaints the scrollback. Different-turn reuses of the same
   * key are allowed through (the turnId changed → legitimate new
   * delegation of the same task in a later user prompt).
   *
   * v0.4.2 (strategy "A") still applies at key level (dedupeKey() returns
   * the normalized first line, capped at 100 chars). B is the stronger
   * dominant filter; A remains as a safety net against minor boundary
   * wobbles inside the same turn that nonetheless produce slightly
   * different raw payload strings.
   */
  recentPayloads: Map<string, { turnId: number; ts: number }>;
  /** Accumulated stripped output. Tail is kept when the buffer exceeds cap. */
  transcript: string;
  /**
   * v0.3.0 · Per-worker bidirectional parser. Parses the worker's own
   * output for `@leader:` / `@worker-N:` directives so workers can route
   * replies back to the leader (hub-and-spoke) or to peers. Only attached
   * when `opts.enableWorkerRouting` is set (new flag in AttachOptions) —
   * legacy attach calls leave it null so existing tests' single-direction
   * behavior is preserved.
   */
  parser: WorkerPatternParser | null;
  /** v0.3.0 · Claude TUI projector for Claude worker output. Null for non-claude agents. */
  projector: ClaudeLeaderRoutingProjector | null;
  /**
   * v0.5.2 — Mirror of `leaderWasIdle` but per-worker. Used by `tick()` to
   * detect the worker's busy → idle transition and flush its parser so
   * multi-line `@leader:\n<body>\n` directives that have no `@end`
   * sentinel finally drain. Without this, a worker that replies with a
   * long code block gets its payload stuck in its parser buffer forever
   * because no subsequent token arrives to terminate the multi-line form.
   */
  wasIdle: boolean;
  /**
   * v0.6.0 — Byte offset into `transcript` where the current in-progress
   * turn began. On every busy→idle edge, the range [currentTurnStart,
   * transcript.length) is considered the full reply body for this turn.
   * If that body exceeds SPILL_THRESHOLD_CHARS, the orchestrator spills
   * it to a drop file instead of trying to route the body text through
   * the pty-stdin parser path (which fragments on long replies).
   */
  currentTurnStart: number;
  /** Monotonic seq used for drop filenames; disambiguates multiple spills per turn. */
  spillSeq: number;
  /**
   * v0.6.1 — True when the worker has received an orchestrator-initiated
   * inject since its last busy→idle edge. Gates spill/flush: if a worker
   * transitions idle without ever having been addressed (boot output
   * settling, Ink repaint, anything else that is NOT a reply to a
   * delegated task), we skip both spill and parser.flush so we do not
   * emit spurious drop notices into the leader and trigger runaway
   * meta-analysis loops. `inject()` sets it true. The idle-edge handler
   * resets it to false after handling.
   */
  hasPendingReply: boolean;
}

/** Cap per-worker transcript to avoid unbounded memory growth in long runs. */
const MAX_TRANSCRIPT_CHARS = 50_000;

const DEFAULT_POLL_MS = 250;
// Claude Code v2.1+ uses an Ink TUI that repaints the alt-screen periodically,
// and crucially it can re-emit the ENTIRE visible scrollback on a full
// refresh (scroll, resize, next-turn replay). Each repaint surfaces every
// earlier `@worker-N: ...` directive from prior turns as a "fresh" parser
// token. Within this window we suppress exact duplicates per worker.
//
// v0.3.9 bumped from 30_000 → 1_800_000 (30 min). Field log showed the
// previous 30s window cleared between user turns, so on each new prompt
// the leader's scrollback replay re-injected the PREVIOUS turn's tasks
// back into the workers. 30 minutes covers realistic scrollback retention
// in typical multi-turn sessions without blocking the user from explicitly
// re-asking the same task after a long pause.
const DEFAULT_DEDUPE_WINDOW_MS = 1_800_000;

/**
 * v0.5.1 — Minimum gap between two `leaderTurnId` bumps.
 *
 * An idle→busy edge that fires within this window of the previous bump
 * is treated as the same logical user turn (Ink mid-response pause /
 * status-tick flicker) and is NOT counted as a new turn. Picked so it
 * comfortably exceeds typical intra-response pauses (~500–800ms) while
 * staying well below realistic intervals between consecutive user
 * prompts (usually seconds).
 */
const TURN_COOLDOWN_MS = 1500;

/**
 * v0.7.3 — Cross-turn dedupe window.
 *
 * B strategy (v0.5.0) dedupes same-turn repeats but allows legitimately
 * different turns to re-route the same payload. Field logs from the
 * v0.7.2 reverseString task chain showed that this opens a loophole
 * for Ink alt-screen scrollback repaints: as the leader emits new
 * delegations, Ink periodically re-emits the ENTIRE scrollback of past
 * turns. Since those past `@worker-N:` lines now arrive in a later
 * turnId, the B-only dedupe lets them through and the orchestrator
 * re-routes a task that was already delivered and answered two turns
 * ago.
 *
 * Fix: even across turns, if the exact same normalized key was routed
 * within CROSS_TURN_DEDUPE_MS (2 min), suppress. Legitimate user
 * re-delegations of identical text within 2 min are rare and almost
 * always an explicit retry that the user can trivially rephrase.
 */
const CROSS_TURN_DEDUPE_MS = 120_000;

/**
 * v0.7.3 — Maximum time leader→worker / worker→leader injects wait for
 * the leader to be idle before firing anyway. Claude's Ink TUI does
 * not always honor the submit key (`\r`) while it is streaming a long
 * response — the body lands in the bottom input box but stays
 * unsubmitted until the user presses Enter manually. Holding the
 * inject until leader idle sidesteps that. The upper bound prevents
 * indefinite buildup if the leader is stuck.
 */
const LEADER_IDLE_WAIT_MAX_MS = 3000;

/**
 * v0.6.0 — Spill threshold for worker replies.
 *
 * When a worker's current-turn transcript (bytes since its last busy→idle
 * edge) grows past this threshold, we abandon the parser-based routing
 * path for this reply and instead:
 *   1. Save the full body to `.omc/team/drops/<worker>-turn<N>-seq<S>.md`.
 *   2. Inject a short pty-safe "[drop from worker-N] …" notice into the
 *      leader, containing a few preview lines + the file path.
 *   3. The leader uses its Read tool to ingest the full body.
 *
 * Rationale (see field logs from v0.5.2 reverseString task):
 *   Long multi-line `@leader:` replies from a Claude worker chunk, repaint,
 *   and fragment as they pass through the pty → ANSI strip → projector →
 *   parser pipeline. The parser yielded only the first 20–80 bytes of
 *   real answers, and follow-up retries slotted under an A-strategy
 *   dedupe key like `"구현"` that collided with the truncated prior
 *   attempt. By short-circuiting to file IO above a size threshold we
 *   pay one Read tool call to get the answer across intact.
 *
 * 300 chars ≈ 5–8 lines of code or ~100 Korean characters. Short acks
 * like "대기 중. 작업 지시 주세요." (18 chars) stay on the parser path;
 * anything that's actually code goes through the spill.
 */
const SPILL_THRESHOLD_CHARS = 300;

/** Max number of lines to echo as a preview inside the leader notice. */
const SPILL_PREVIEW_LINES = 5;

/** Hard cap per preview line so pathological long lines can't inflate the notice. */
const SPILL_PREVIEW_LINE_CHARS = 80;

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
  /**
   * v0.5.0 — Turn counter for strategy B dedupe.
   *
   * Bumped each time the leader transitions from idle → busy (which in
   * practice means "user just sent a prompt and leader started emitting
   * its response"). commitRoute / commitLeaderInject stamp their
   * recentPayloads entries with the current turnId and drop any repeat
   * route whose stamp matches the same turnId. Different turnId → new
   * delegation, allowed. This is immune to Ink repaint boundary wobble
   * that slipped past the older A+C strategies.
   *
   * v0.5.1 — Cooldown guard. The leaderIdle silenceMs is 500ms, which
   * is shorter than some pauses Claude's Ink TUI takes mid-response
   * (for tool-call status ticks, re-render sweeps, etc). Without a
   * cooldown the same logical turn flips idle→busy several times and
   * blows the turnId up by 3–4 per user prompt. See `lastTurnAdvanceAt`
   * below.
   */
  private leaderTurnId = 0;
  /**
   * v0.5.1 — Timestamp of the most recent `leaderTurnId` bump. An
   * idle→busy edge within TURN_COOLDOWN_MS of the previous bump is
   * ignored: it is almost certainly the same logical user turn
   * experiencing a transient status-tick pause, not a new prompt.
   */
  private lastTurnAdvanceAt = 0;
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
  /**
   * v0.3.4 · Per-source pending debounce for worker→leader routing. Mirrors
   * `pendingRoute` but keyed by the SOURCE pane id (the worker that emitted
   * the @leader: directive). Absorbs the same Ink re-render "short pulse →
   * longer pulse" pattern on the leader-inject path that the worker-target
   * route's pendingRoute already handles — without this, every wrap stage
   * of a single @leader: reply counted as a separate round.
   */
  private readonly pendingLeaderInject = new Map<
    string,
    {
      payload: string;
      timer: ReturnType<typeof setTimeout>;
      /**
       * v0.7.3 — When the leader-idle gate first observes leader busy,
       * stamp the time here. Subsequent re-arms compare against this to
       * cap the total wait at LEADER_IDLE_WAIT_MAX_MS — after which the
       * inject commits anyway so a never-idle leader does not strand
       * worker replies indefinitely.
       */
      leaderGateStartedAt?: number;
    }
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

  // ── v0.3.0 bidirectional / ping-pong state ──────────────────────────────

  /** Whether worker output is also parsed for routing directives. */
  private enableWorkerRouting = false;
  /** Routing kill-switch. When true, all route() calls drop silently. */
  private routingPaused = false;
  /** Cap on routed directives per task. 0 = unlimited. */
  private maxRoundsPerTask = 0;
  /** Idle window after which the round counter auto-resets to 0. */
  private autoResetRoundMs = 30_000;
  /** Current round count. Incremented on each commit (post-dedupe). */
  private currentRound = 0;
  /** Wall-clock ms of the most recent successful commit. Drives auto-reset. */
  private lastRouteAt = 0;
  /** Prevents the cap-reached notice from firing every subsequent dropped route. */
  private roundCapNotifyFired = false;
  /**
   * v0.5.0 — Track whether routing was paused *because* of the round cap
   * (vs a manual pause()/resume() by the user). Only the round-cap pause
   * is auto-cleared by `resetRound()`; user-requested pauses stay put.
   */
  private routingPausedByRoundCap = false;
  /**
   * Payload → last-seen ms for directives aimed at the LEADER. Mirrors
   * `WorkerRuntime.recentPayloads` but for the leader target (which has no
   * WorkerRuntime of its own). Keeps Claude's Ink redraw duplicates from
   * re-injecting the same reply N times into the leader stdin.
   */
  private readonly leaderRecentPayloads = new Map<string, { turnId: number; ts: number }>();

  constructor(
    private readonly panel: OrchestratorPanel,
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
    // v0.3.0 bidirectional + round cap wiring
    this.enableWorkerRouting = opts.enableWorkerRouting ?? false;
    this.maxRoundsPerTask = opts.maxRoundsPerTask ?? 0;
    if (opts.autoResetRoundMs !== undefined) this.autoResetRoundMs = opts.autoResetRoundMs;
    this.currentRound = 0;
    this.roundCapNotifyFired = false;
    this.lastRouteAt = 0;
    this.routingPaused = false;
    this.routingPausedByRoundCap = false;
    // v0.5.0 — Fresh attach starts at turnId=0. The first idle→busy edge
    // in onPaneData will bump it to 1 when the leader starts its first
    // response, which is when we actually want same-turn dedupe to apply.
    this.leaderTurnId = 0;
    // v0.5.1 — Clear cooldown timestamp so the very first turn boundary
    // is never suppressed by a stale timestamp from a prior attach.
    this.lastTurnAdvanceAt = 0;
    this.leaderRecentPayloads.clear();
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
        // v0.3.0: only wire worker-side parsers when bidirectional is on.
        parser: this.enableWorkerRouting ? new WorkerPatternParser() : null,
        wasIdle: false,
        currentTurnStart: 0,
        spillSeq: 0,
        hasPendingReply: false,
        projector:
          this.enableWorkerRouting && w.agent === 'claude'
            ? new ClaudeLeaderRoutingProjector()
            : null,
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
    // v0.3.4 · also drain the symmetric leader-inject pending map.
    for (const { timer } of this.pendingLeaderInject.values()) clearTimeout(timer);
    this.pendingLeaderInject.clear();
    this.recentAdds.clear();
    // v0.3.0: reset per-worker projector state + leader dedupe cache.
    for (const w of this.workers.values()) {
      w.projector?.reset();
    }
    this.leaderRecentPayloads.clear();
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
      wasIdle: false,
      currentTurnStart: 0,
      spillSeq: 0,
      hasPendingReply: false,
      // v0.3.0: runtime-added workers inherit the team's bidirectional flag.
      parser: this.enableWorkerRouting ? new WorkerPatternParser() : null,
      projector:
        this.enableWorkerRouting && cfg.agent === 'claude'
          ? new ClaudeLeaderRoutingProjector()
          : null,
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
   * v0.3.0 · Pause all routing. Directives parsed from leader or worker
   * output are dropped silently until `resume()` is called. Does NOT kill
   * panes or clear pending debounce timers — this is a soft kill-switch the
   * user can toggle when a ping-pong is going off the rails.
   */
  pause(): void {
    if (this.routingPaused) return;
    this.routingPaused = true;
    this.output.appendLine('[orch] routing paused');
  }

  resume(): void {
    if (!this.routingPaused) return;
    this.routingPaused = false;
    // v0.5.0 — User-initiated resume clears the round-cap pause marker
    // too (single source of truth: after resume, routing is live).
    this.routingPausedByRoundCap = false;
    this.output.appendLine('[orch] routing resumed');
  }

  get isPaused(): boolean {
    return this.routingPaused;
  }

  /**
   * v0.3.0 · Reset the round counter to 0 and re-arm the cap-reached
   * notice. Called manually (command) or automatically when the team has
   * been idle for `autoResetRoundMs`.
   */
  resetRound(): void {
    if (this.currentRound === 0 && !this.roundCapNotifyFired) return;
    const prior = this.currentRound;
    this.currentRound = 0;
    this.roundCapNotifyFired = false;
    // v0.5.0 — If routing was paused solely because of the round cap,
    // clear that pause on reset. User-invoked pauses stay in effect.
    if (this.routingPausedByRoundCap) {
      this.routingPaused = false;
      this.routingPausedByRoundCap = false;
      this.output.appendLine(`[orch] routing auto-resumed (round cap cleared)`);
    }
    this.output.appendLine(`[orch] round reset (was ${prior})`);
  }

  get roundState(): { current: number; max: number; paused: boolean } {
    return {
      current: this.currentRound,
      max: this.maxRoundsPerTask,
      paused: this.routingPaused,
    };
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
      // v0.5.0 — Turn boundary detection (strategy B)
      // ----------------------------------------------
      // If the leader was idle before this chunk arrived, we just crossed
      // an idle → busy edge. That almost always means the user sent a
      // new prompt and the leader is starting to respond. Bump the turn
      // id so same-turn dedupe entries do NOT mask legitimate re-delegations
      // that a later turn might issue.
      //
      // v0.5.1 — Cooldown gate. Claude's Ink TUI takes transient pauses
      // mid-response (tool status ticks, internal re-renders) that the
      // 500ms idle detector interprets as idle→busy flips. Without this
      // gate a single user prompt was bumping turnId by 3–4, scattering
      // same-turn dedupe entries across multiple turnIds and making B
      // strategy miss the repaints it was meant to catch. We only bump
      // when the previous bump is at least TURN_COOLDOWN_MS old.
      if (this.leaderWasIdle) {
        const now = this.nowFn();
        const sinceLast = now - this.lastTurnAdvanceAt;
        if (this.lastTurnAdvanceAt === 0 || sinceLast >= TURN_COOLDOWN_MS) {
          this.leaderTurnId += 1;
          this.lastTurnAdvanceAt = now;
          this.output.appendLine(
            `[orch.turn] leader turnId advanced to ${this.leaderTurnId} (idle→busy edge, +${sinceLast}ms since last)`,
          );
        } else {
          this.output.appendLine(
            `[orch.turn] idle→busy edge coalesced into turn=${this.leaderTurnId} (only ${sinceLast}ms since last, cooldown=${TURN_COOLDOWN_MS}ms)`,
          );
        }
      }
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
        // v0.3.0: if bidirectional routing is enabled, parse this worker's
        // output for `@leader:` / `@worker-N:` directives and route them.
        this.consumeWorkerOutput(w, rawData);
        return;
      }
    }
  }

  /**
   * v0.3.0 · Parse one worker's output chunk for routing directives and
   * dispatch them. No-op when `enableWorkerRouting` is false (legacy mode).
   * Mirrors `consumeLeaderOutput` but uses the worker's own parser +
   * projector pair so multiple workers stream in parallel without
   * cross-contaminating each other's directive buffers.
   */
  private consumeWorkerOutput(w: WorkerRuntime, rawData: string): void {
    if (!this.enableWorkerRouting || !w.parser) return;
    const cleaned = stripAnsi(rawData);
    const projected = w.projector ? w.projector.feed(cleaned) : cleaned;
    if (!projected) return;
    const msgs = w.parser.feed(projected);
    if (msgs.length === 0) return;
    this.output.appendLine(
      `[orch.trace] ${w.cfg.id} yielded ${msgs.length} directive(s): ${msgs
        .map((m) => `${m.workerId}=${preview(m.payload, 30)}`)
        .join(', ')}`,
    );
    for (const m of msgs) this.route(m, w.cfg.paneId);
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

  /**
   * v0.3.0 · `sourcePaneId` identifies whoever emitted the directive.
   * Defaults to the leader's paneId for backward compatibility with the
   * original leader-only routing path. Worker-emitted directives pass the
   * worker's paneId so self-route and hub-and-spoke checks apply.
   */
  private route(msg: RoutedMessage, sourcePaneId?: string): void {
    const source = sourcePaneId ?? this.leader?.paneId ?? '';

    // v0.3.7 · Field diagnostic entry log. Makes every routing attempt
    // visible so stalls between "parser yielded" and actual injection can
    // be traced. Budget: one short line per parsed directive.
    this.output.appendLine(
      `[orch.route] src=${source} → target=${msg.workerId} (round ${this.currentRound}${this.maxRoundsPerTask > 0 ? `/${this.maxRoundsPerTask}` : ''}, debounce=${this.dispatchDebounceMs}ms): ${preview(msg.payload)}`,
    );

    // v0.3.0 · Pause kill-switch — drops without any side effect.
    if (this.routingPaused) {
      this.stats.dropped += 1;
      this.output.appendLine(
        `[orch.paused] dropped routing to "${msg.workerId}": ${preview(msg.payload)}`,
      );
      return;
    }

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
      // Seed the target's dedupe cache so post-grace Ink redraws don't re-route.
      if (msg.workerId === 'leader') {
        this.leaderRecentPayloads.set(msg.payload, {
          turnId: this.leaderTurnId,
          ts: this.nowFn(),
        });
      } else {
        const w = this.workers.get(msg.workerId);
        if (w) w.recentPayloads.set(msg.payload, { turnId: this.leaderTurnId, ts: this.nowFn() });
      }
      return;
    }

    // v0.3.0 · @leader target handling (hub-and-spoke reply path).
    if (msg.workerId === 'leader') {
      if (!this.leader) {
        this.stats.dropped += 1;
        return;
      }
      if (source === this.leader.paneId) {
        this.output.appendLine(
          `[orch] leader emitted @leader: — self-route dropped (payload: ${preview(msg.payload)})`,
        );
        this.stats.dropped += 1;
        return;
      }
      // v0.3.4 · Ink re-render absorber, symmetric with the worker-target
      // path in the branch below. Without this, each wrap stage of a
      // single worker @leader: reply counted as a separate round.
      if (this.dispatchDebounceMs <= 0) {
        this.commitLeaderInject(msg.payload, source);
        return;
      }
      const existingL = this.pendingLeaderInject.get(source);
      if (existingL) {
        clearTimeout(existingL.timer);
        const newExtendsOld = msg.payload.startsWith(existingL.payload);
        const oldExtendsNew = existingL.payload.startsWith(msg.payload);
        if (!newExtendsOld && !oldExtendsNew) {
          // Different logical messages — flush pending, debounce new.
          this.commitLeaderInject(existingL.payload, source);
        }
        if (oldExtendsNew && !newExtendsOld) {
          // New is a shrinking prefix — keep the longer pending.
          const timer = setTimeout(() => {
            this.pendingLeaderInject.delete(source);
            this.commitLeaderInject(existingL.payload, source);
          }, this.dispatchDebounceMs);
          this.pendingLeaderInject.set(source, { payload: existingL.payload, timer });
          return;
        }
      }
      this.armLeaderDispatchTimer(source, msg.payload);
      return;
    }

    const w = this.workers.get(msg.workerId);
    if (!w) {
      this.output.appendLine(
        `[orch] ${sourcePaneId ? `${sourcePaneId} referenced` : 'leader referenced'} unknown "${msg.workerId}" — dropped (payload: ${preview(msg.payload)})`,
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

    // v0.3.0 · Self-route guard (worker-1 cannot send to worker-1).
    if (w.cfg.paneId === source) {
      this.output.appendLine(
        `[orch] ${msg.workerId} self-routed — dropped (payload: ${preview(msg.payload)})`,
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

  /**
   * v0.3.0 · Inject a `@leader:` payload into the leader pane. Shares the
   * round-cap and dedupe enforcement model with `commitRoute` (the worker-
   * side path), which keeps both directions of the bidirectional routing
   * under the same convergence budget.
   */
  private commitLeaderInject(payload: string, sourcePaneId: string): void {
    if (!this.leader) {
      this.stats.dropped += 1;
      return;
    }
    const nowMs = this.nowFn();
    this.pruneLeaderRecent(nowMs);
    // v0.5.0 · (A+B) Normalized key + turn-based dedupe also on the
    // worker→leader direction. Ghost repaints from worker panes re-emitting
    // a prior turn's `@leader: banana` directive must NOT make it back to
    // the leader stdin a second time — field logs showed worker-2 yielding
    // ["leader=banana", "leader=25"] multiple times per tick after it had
    // already moved on to a new task.
    const key = this.dedupeKey(payload);
    const lastSeen = this.leaderRecentPayloads.get(key);
    // v0.5.0 (B) + v0.7.3 cross-turn dedupe window — see commitRoute for
    // rationale. Same-turn OR within-2-min across turns → drop. Worker
    // panes also repaint scrollback and yield stale @leader: directives;
    // this suppresses those ghosts without blocking legitimate re-uses
    // after the window expires.
    if (lastSeen !== undefined) {
      if (lastSeen.turnId === this.leaderTurnId) {
        this.stats.deduped += 1;
        this.output.appendLine(
          `[orch.commit] leader (from ${sourcePaneId}) deduped (same turn=${this.leaderTurnId}, key="${preview(key, 40)}")`,
        );
        return;
      }
      if (nowMs - lastSeen.ts < CROSS_TURN_DEDUPE_MS) {
        this.stats.deduped += 1;
        this.output.appendLine(
          `[orch.commit] leader (from ${sourcePaneId}) deduped (cross-turn within ${CROSS_TURN_DEDUPE_MS}ms: prior turn=${lastSeen.turnId}, cur=${this.leaderTurnId}, key="${preview(key, 40)}")`,
        );
        return;
      }
    }
    if (this.enforceRoundCap(`leader (from ${sourcePaneId})`, payload)) return;
    this.leaderRecentPayloads.set(key, { turnId: this.leaderTurnId, ts: nowMs });
    this.currentRound += 1;
    this.lastRouteAt = nowMs;
    const agent = this.leader.agent;
    const opts = { agent };
    try {
      if (needsWin32KeyEvents(opts)) {
        const { body, submit } = splitSubmitPayload(payload, opts);
        this.panel.writeToPane(this.leader.paneId, body);
        setTimeout(() => {
          try {
            this.panel.writeToPane(this.leader!.paneId, submit);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[orch] inject submit → leader FAILED — ${msg}`);
          }
        }, INJECT_SUBMIT_DELAY_MS);
      } else {
        this.panel.writeToPane(this.leader.paneId, buildSubmitPayload(payload, opts));
      }
      this.stats.injected += 1;
      this.output.appendLine(
        `[orch] → leader (from ${sourcePaneId}, round ${this.currentRound}${this.maxRoundsPerTask > 0 ? `/${this.maxRoundsPerTask}` : ''}): ${preview(payload)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[orch] inject → leader FAILED — ${msg}`);
      this.stats.dropped += 1;
    }
  }

  private pruneLeaderRecent(nowMs: number): void {
    for (const [payload, entry] of this.leaderRecentPayloads) {
      if (nowMs - entry.ts >= this.dedupeWindowMs) this.leaderRecentPayloads.delete(payload);
    }
  }

  /**
   * Returns true when the round cap has been hit (caller should drop).
   * The cap-reached notice is injected into the leader exactly once per
   * capped window; `resetRound()` or auto-reset re-arms the notice.
   */
  private enforceRoundCap(targetLabel: string, payload: string): boolean {
    if (this.maxRoundsPerTask <= 0) return false;
    if (this.currentRound < this.maxRoundsPerTask) return false;
    this.stats.dropped += 1;
    this.output.appendLine(
      `[orch.roundCap] dropped → ${targetLabel} (round ${this.currentRound} ≥ cap ${this.maxRoundsPerTask}): ${preview(payload)}`,
    );
    if (!this.roundCapNotifyFired) {
      this.roundCapNotifyFired = true;
      // v0.5.0 — When the round cap is first hit, flip the routing pause
      // switch. The existing notify already tells the leader to stop
      // delegating, but the leader often keeps trying for a few more
      // turns (the model doesn't parse "paused" as a hard stop). Flipping
      // `routingPaused` converts those continued attempts into cheap
      // `[orch.paused]` drops instead of letting them re-enter the dedupe
      // / debounce path. `resetRound()` re-enables routing.
      this.routingPaused = true;
      this.routingPausedByRoundCap = true;
      this.scheduleLeaderNotify(
        `round cap reached (${this.maxRoundsPerTask}). Further worker routing is paused — summarize what you have and reply to the user, or ask to reset.`,
      );
    }
    return true;
  }

  private armDispatchTimer(workerId: string, payload: string): void {
    const existing = this.pendingRoute.get(workerId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.tryDispatchPending(workerId, payload), this.dispatchDebounceMs);
    this.pendingRoute.set(workerId, { payload, timer });
  }

  /** v0.3.4 · Mirror of `armDispatchTimer` for worker→leader routing. */
  private armLeaderDispatchTimer(sourcePaneId: string, payload: string): void {
    const existing = this.pendingLeaderInject.get(sourcePaneId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(
      () => this.tryDispatchPendingLeader(sourcePaneId, payload),
      this.dispatchDebounceMs,
    );
    // v0.7.3 — Preserve leaderGateStartedAt across re-arms so the
    // cumulative wait toward LEADER_IDLE_WAIT_MAX_MS is honored. A
    // re-arm is an extension of the same pending inject, not a fresh
    // one; if we reset the stamp every debounce cycle the cap would
    // never be reached.
    this.pendingLeaderInject.set(sourcePaneId, {
      payload,
      timer,
      leaderGateStartedAt: existing?.leaderGateStartedAt,
    });
  }

  private tryDispatchPendingLeader(sourcePaneId: string, payload: string): void {
    // Gate on the SOURCE worker's idle state — same rationale as
    // `tryDispatchPending` gates on leaderIdle. If the source is still
    // emitting assistant output, an Ink re-wrap of the @leader: line may
    // land a longer version in the next few hundred ms; re-arm and wait.
    const source = [...this.workers.values()].find((w) => w.cfg.paneId === sourcePaneId);
    if (source && !source.idle.isIdle) {
      const ms = source.idle.msSinceOutput;
      this.output.appendLine(
        `[orch.debounce] re-arm leader←${sourcePaneId} (source busy, msSinceOutput=${ms}ms): ${preview(payload)}`,
      );
      this.armLeaderDispatchTimer(sourcePaneId, payload);
      return;
    }
    // v0.7.3 — Also gate on LEADER idle. Claude's Ink TUI sometimes
    // does not honor the submit (`\r`) key while the leader is
    // streaming its own response — the body bytes land in the bottom
    // input box but the submit is eaten by the in-progress render, so
    // the user has to press Enter manually. Waiting for leader idle
    // sidesteps that. Bounded by LEADER_IDLE_WAIT_MAX_MS so we never
    // lose an inject if the leader never settles.
    const pending = this.pendingLeaderInject.get(sourcePaneId);
    const waited = pending?.leaderGateStartedAt !== undefined
      ? this.nowFn() - pending.leaderGateStartedAt
      : 0;
    if (this.leaderIdle && !this.leaderIdle.isIdle && waited < LEADER_IDLE_WAIT_MAX_MS) {
      if (pending && pending.leaderGateStartedAt === undefined) {
        pending.leaderGateStartedAt = this.nowFn();
      }
      const ms = this.leaderIdle.msSinceOutput;
      this.output.appendLine(
        `[orch.debounce] re-arm leader←${sourcePaneId} (leader busy, waited=${waited}ms/${LEADER_IDLE_WAIT_MAX_MS}ms, leader msSinceOutput=${ms}ms): ${preview(payload)}`,
      );
      this.armLeaderDispatchTimer(sourcePaneId, payload);
      return;
    }
    this.output.appendLine(`[orch.debounce] commit leader←${sourcePaneId}: ${preview(payload)}`);
    this.pendingLeaderInject.delete(sourcePaneId);
    this.commitLeaderInject(payload, sourcePaneId);
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
      // v0.3.7 · Field diagnostic: log every re-arm so silent stalls are
      // visible. Field log showed the pending debounce looping forever when
      // leaderIdle misjudged busy; without this log the loop was invisible.
      const ms = this.leaderIdle.msSinceOutput;
      this.output.appendLine(
        `[orch.debounce] re-arm ${workerId} (leaderIdle=busy, msSinceOutput=${ms}ms): ${preview(payload)}`,
      );
      this.armDispatchTimer(workerId, payload);
      return;
    }
    this.output.appendLine(`[orch.debounce] commit ${workerId}: ${preview(payload)}`);
    this.pendingRoute.delete(workerId);
    const w = this.workers.get(workerId);
    if (w) this.commitRoute(w, payload);
  }

  private commitRoute(w: WorkerRuntime, payload: string): void {
    // v0.3.7 · Entry log — field diagnostic for stalls between commit and inject.
    this.output.appendLine(
      `[orch.commit] ${w.cfg.id} (idle=${w.idle.isIdle}, queueLen=${w.queue.length}): ${preview(payload)}`,
    );
    // Redraw dedupe: Claude's Ink UI repaints the same line on every status
    // tick. Suppress any payload we've seen for this worker within the dedupe
    // window. First hit logs as dedup-suppressed; silent for subsequent hits.
    //
    // v0.4.2 · (A) Key normalization
    // -------------------------------
    // Pre-v0.4.2 the dedupe key was the full payload string. Ink alt-screen
    // scrollback repaints sometimes shift payload boundaries — e.g. the first
    // emission folds a trailing narration sentence into the payload
    // (`"banana"...마세요. 두 워커의 응답을 기다리겠습니다.`) but the repaint
    // yields the parser a bare `"banana"...마세요.`. Different strings, so
    // the full-payload key missed and the worker got re-injected.
    // Normalizing to the first line (up to 100 chars) makes the key stable
    // across such boundary wobbles while still distinguishing legitimately
    // different tasks (which virtually always diverge within the first line).
    const nowMs = this.nowFn();
    this.pruneRecent(w, nowMs);
    const key = this.dedupeKey(payload);
    const lastSeen = w.recentPayloads.get(key);
    // v0.5.0 (B) same-turn dedupe + v0.7.3 cross-turn dedupe window.
    // Same-turn repeat → drop. Different turn with SAME key within
    // CROSS_TURN_DEDUPE_MS → also drop (catches Ink scrollback repaints
    // that span turn boundaries). Different turn older than the window
    // → allowed through for legitimate re-delegation.
    if (lastSeen !== undefined) {
      if (lastSeen.turnId === this.leaderTurnId) {
        this.stats.deduped += 1;
        this.output.appendLine(
          `[orch.commit] ${w.cfg.id} deduped (same turn=${this.leaderTurnId}, key="${preview(key, 40)}")`,
        );
        return;
      }
      if (nowMs - lastSeen.ts < CROSS_TURN_DEDUPE_MS) {
        this.stats.deduped += 1;
        this.output.appendLine(
          `[orch.commit] ${w.cfg.id} deduped (cross-turn within ${CROSS_TURN_DEDUPE_MS}ms: prior turn=${lastSeen.turnId}, cur=${this.leaderTurnId}, key="${preview(key, 40)}")`,
        );
        return;
      }
    }
    // v0.3.0: enforce round cap AFTER dedupe so Ink redraws of a single
    // commit don't exhaust the budget. Once the cap is hit the route is
    // dropped and a single notice fires (see enforceRoundCap).
    if (this.enforceRoundCap(w.cfg.id, payload)) return;
    w.recentPayloads.set(key, { turnId: this.leaderTurnId, ts: nowMs });
    this.currentRound += 1;
    this.lastRouteAt = nowMs;

    if (w.idle.isIdle) {
      this.inject(w, payload);
    } else {
      w.queue.push(payload);
      this.stats.queued += 1;
      this.output.appendLine(
        `[orch] queue ${w.cfg.id} (busy, queue=${w.queue.length}, round ${this.currentRound}${this.maxRoundsPerTask > 0 ? `/${this.maxRoundsPerTask}` : ''}): ${preview(payload)}`,
      );
    }
  }

  /**
   * v0.6.0 — Save the worker's completed turn body to a drop file and
   * inject a short pty-safe "[drop from worker-N]" notice into the leader.
   *
   * The notice contains up to SPILL_PREVIEW_LINES lines of the body
   * (each capped at SPILL_PREVIEW_LINE_CHARS) so the user watching the
   * leader pane has immediate visibility into what the worker wrote,
   * and the leader itself has enough context to decide whether to Read
   * the full drop file before synthesizing.
   *
   * File path: `<attachedCwd>/.omc/team/drops/<worker>-turn<N>-seq<S>.md`
   * (`.omc/` is already gitignored at the project root).
   */
  private spillAndNotify(w: WorkerRuntime, turnBody: string): void {
    w.spillSeq += 1;
    const root = this.attachedCwd ?? process.cwd();
    const dir = path.join(root, '.omc', 'team', 'drops');
    const filename = `${w.cfg.id}-turn${this.leaderTurnId}-seq${w.spillSeq}.md`;
    const absPath = path.join(dir, filename);
    const relPath = path.posix.join('.omc', 'team', 'drops', filename);

    try {
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date().toISOString();
      const header =
        `# Drop: ${w.cfg.id} turn ${this.leaderTurnId} seq ${w.spillSeq}\n` +
        `timestamp: ${now}\n` +
        `bytes: ${turnBody.length}\n` +
        `---\n\n`;
      fs.writeFileSync(absPath, header + turnBody, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[orch.spill] write FAILED for ${filename} — ${msg}`);
      this.stats.dropped += 1;
      return;
    }

    const preview = this.buildSpillPreview(turnBody);
    const notice =
      `[drop from ${w.cfg.id} turn ${this.leaderTurnId}] 본문 저장됨: ${relPath}\n\n` +
      `미리보기:\n${preview}\n\n` +
      `전체 본문은 위 파일을 Read 해서 확인하고 종합해 주세요.`;

    this.output.appendLine(
      `[orch.spill] ${w.cfg.id} → ${relPath} (${turnBody.length} bytes); notifying leader`,
    );

    // Route via the same worker→leader path as a normal `@leader:` directive.
    // This pays round-counter + dedupe + routing-pause the same as a
    // parser-yielded message, keeping accounting consistent.
    this.route({ workerId: 'leader', payload: notice }, w.cfg.paneId);
  }

  /**
   * v0.6.0 — Build the preview block shown inside a drop notice.
   * Up to SPILL_PREVIEW_LINES lines, each prefixed with "> " (markdown
   * block-quote style so it reads cleanly in the leader's context),
   * each capped at SPILL_PREVIEW_LINE_CHARS chars with an ellipsis when
   * truncated. An extra "> …" line indicates the body continues beyond
   * the preview.
   */
  private buildSpillPreview(body: string): string {
    const lines = body.split(/\r?\n/);
    const taken: string[] = [];
    for (let i = 0; i < Math.min(lines.length, SPILL_PREVIEW_LINES); i++) {
      const raw = lines[i];
      const trimmed =
        raw.length > SPILL_PREVIEW_LINE_CHARS
          ? raw.slice(0, SPILL_PREVIEW_LINE_CHARS - 1) + '…'
          : raw;
      taken.push(`> ${trimmed}`);
    }
    if (lines.length > SPILL_PREVIEW_LINES) taken.push('> …');
    return taken.join('\n');
  }

  private pruneRecent(w: WorkerRuntime, nowMs: number): void {
    for (const [payload, entry] of w.recentPayloads) {
      if (nowMs - entry.ts >= this.dedupeWindowMs) w.recentPayloads.delete(payload);
    }
  }

  /**
   * v0.4.2 — Dedupe key normalization (strategy "A" from the dedupe ladder).
   *
   * Two payloads that represent the same routing intent but differ at the
   * edges (because the Ink-repaint sometimes folds a trailing narration
   * sentence into the payload, sometimes doesn't) should collapse to the
   * same dedupe key. Use the first logical line, trimmed, capped at 100
   * characters. Legitimate different tasks practically always differ within
   * the opening line, so false-positive collisions are very rare; the gain
   * is that Ink boundary wobble stops leaking ghost injections.
   *
   * Memo: if this still leaks in the field log, the next rung on the ladder
   * is strategy "B" (turn-based dedupe — one route per worker per leader
   * turn, regardless of payload content).
   */
  private dedupeKey(payload: string): string {
    const firstLine = payload.split(/\r?\n/, 1)[0] ?? '';
    return firstLine.trim().slice(0, 100);
  }

  private inject(w: WorkerRuntime, payload: string): void {
    // v2.7.13: on Windows+Claude, split body and submit. Writing a long
    // UTF-8 body plus the Win32 Enter KEY_EVENT in one `pty.write` call was
    // observed to lose the Enter for worker-2 (the second of two back-to-
    // back dispatches) even though worker-1 with a shorter payload fired
    // fine. A short macrotask gap lets ConPTY flush the body bytes through
    // win32-input-mode before the submit sequence arrives.
    //
    // v0.6.1 — Mark the worker as having a pending reply. The next
    // busy→idle edge will treat its transcript slice as a real reply
    // (flush + maybe-spill). Boot output and idle repaints happening
    // BEFORE any inject arrives are skipped to avoid spurious drop
    // notices and the meta-analysis cascade they triggered in v0.6.0.
    w.hasPendingReply = true;
    // v0.7.0 — Symmetric spill. A long leader→worker payload (the
    // delegation body, especially when the leader pastes code or a
    // full review request) fragments through the pty pipeline just like
    // worker→leader replies did in v0.5.2. Check size here and, above
    // SPILL_THRESHOLD_CHARS, divert to a drop file and inject only a
    // short pty-safe notice. The worker is taught (via workerProtocol)
    // to Read the file before starting the task.
    const effective = this.maybeSpillLeaderToWorker(w, payload);
    const paneId = w.cfg.paneId;
    const opts = { agent: w.cfg.agent };
    try {
      if (needsWin32KeyEvents(opts)) {
        const { body, submit } = splitSubmitPayload(effective, opts);
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
        const bytes = buildSubmitPayload(effective, opts);
        this.panel.writeToPane(paneId, bytes);
      }
      w.idle.markBusy();
      this.stats.injected += 1;
      this.output.appendLine(`[orch] → ${w.cfg.id}: ${preview(effective)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[orch] inject → ${w.cfg.id} FAILED — ${msg}`);
      this.stats.dropped += 1;
    }
  }

  /**
   * v0.7.0 — Leader→Worker symmetric spill.
   *
   * When the leader routes a payload larger than SPILL_THRESHOLD_CHARS
   * toward a worker (typically: long code review request, multi-line
   * task spec with embedded snippets), skip direct pty injection and
   * instead:
   *   1. Save the full body to `.omc/team/drops/to-<worker>-turn<N>-seq<S>.md`
   *   2. Return a short pty-safe notice to inject instead, with the
   *      relative file path and a 5-line preview.
   * The worker's system prompt (workerProtocol DROP HANDLING section)
   * instructs it to Read the file before starting the task.
   *
   * Short payloads pass through unchanged.
   *
   * File-write failures fall back to injecting the original payload
   * (best-effort: fragmentation is worse than nothing, but losing the
   * task entirely is worse than fragmentation).
   */
  private maybeSpillLeaderToWorker(w: WorkerRuntime, payload: string): string {
    if (payload.length < SPILL_THRESHOLD_CHARS) return payload;
    w.spillSeq += 1;
    const root = this.attachedCwd ?? process.cwd();
    const dir = path.join(root, '.omc', 'team', 'drops');
    const filename = `to-${w.cfg.id}-turn${this.leaderTurnId}-seq${w.spillSeq}.md`;
    const absPath = path.join(dir, filename);
    const relPath = path.posix.join('.omc', 'team', 'drops', filename);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const now = new Date().toISOString();
      const header =
        `# Drop: leader → ${w.cfg.id} turn ${this.leaderTurnId} seq ${w.spillSeq}\n` +
        `direction: leader → ${w.cfg.id}\n` +
        `timestamp: ${now}\n` +
        `bytes: ${payload.length}\n` +
        `---\n\n`;
      fs.writeFileSync(absPath, header + payload, 'utf8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(
        `[orch.spill] leader→${w.cfg.id} write FAILED — ${msg}; falling back to direct inject`,
      );
      return payload;
    }
    const preview = this.buildSpillPreview(payload);
    this.output.appendLine(
      `[orch.spill] leader → ${w.cfg.id}: ${relPath} (${payload.length} bytes); injecting notice`,
    );
    return (
      `[drop for you from leader turn ${this.leaderTurnId}] 본문 저장됨: ${relPath}\n\n` +
      `미리보기:\n${preview}\n\n` +
      `전체 본문은 위 파일을 Read 해서 확인한 뒤 task를 수행해 주세요.`
    );
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
    // v2.7.32: restore grace closes on wall-clock deadline ONLY.
    //
    // History — why the idle-gate was removed
    // ----------------------------------------
    // v2.7.29 added `leaderIdle.msSinceOutput >= 1000ms` as an early-close
    // signal. Broken: `IdleDetector.lastOutputAt` is seeded at construction,
    // so silence accumulated during Claude CLI's post-spawn session-loading
    // gap and closed grace with `dropped 0` before scrollback arrived.
    //
    // v2.7.31 tried `leaderIdle.isIdle` (prompt pattern + ≥500ms silence)
    // thinking the prompt appears only at the END of replay. Also broken:
    // Claude CLI paints its input box (`>` + `[OMC#x.y.z] | ...` + `⏵⏵ bypass
    // permissions on`) IMMEDIATELY on spawn as part of the welcome UI,
    // before session load even starts. `hasPromptPattern()` therefore
    // returned true from t=0, and `isIdle` fired as soon as the welcome
    // banner stopped printing (~500ms post-spawn) — again before the
    // scrollback replay burst landed. Field log 2026-04-22 showed:
    //   [orch.restoreGrace] window closed (leader-idle) — dropped 0
    //   ...
    //   [orch.trace] parser yielded 2 msg(s): worker-1=..., worker-2=...
    //   [orch] → worker-1: ...   <- replayed directive routed live
    //
    // Conclusion: there is no leader-side signal that reliably indicates
    // "scrollback replay finished." The prompt pattern exists before
    // replay starts, silence exists before replay starts, and the
    // `● @worker-N:` bullet that actually signals end-of-replay is
    // indistinguishable from a live leader response. The only safe gate
    // is wall-clock — wait the full `restoreGraceMs` window (default 15s),
    // drop everything the parser yields during it. Tradeoff: the first
    // 15s after restore drops ALL parser directives, including any the
    // user might type. Acceptable because restore UX naturally has a
    // settle period, and re-execution of prior turns is a much worse bug.
    if (this.restoreGraceEndsAt !== null) {
      if (this.nowFn() >= this.restoreGraceEndsAt) {
        this.output.appendLine(
          `[orch.restoreGrace] window closed (deadline) — dropped ${this.restoreGraceDroppedCount} directive(s) from scrollback replay; live routing active`,
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
      // v0.5.2 / v0.6.0 — Worker busy→idle edge
      // ----------------------------------------
      // At the moment the worker goes idle, we pick one of two paths
      // depending on how much it wrote during this turn:
      //
      //   (a) Short reply (< SPILL_THRESHOLD_CHARS): run the existing
      //       parser.flush() path so pending `@leader:` / `@worker-N:`
      //       directives drain even without an `@end` terminator.
      //       This is the v0.5.2 behavior.
      //
      //   (b) Long reply (>= SPILL_THRESHOLD_CHARS): abandon the
      //       parser. Long bodies fragment unpredictably through the
      //       Ink repaint + pty chunk + ANSI strip pipeline; the
      //       parser yielded only the first 20–80 bytes of real code
      //       answers in v0.5.2 field tests. Instead, write the entire
      //       turn body to a drop file and inject a short pty-safe
      //       notice into the leader with a preview + file path.
      //       The leader uses its Read tool to ingest the full body.
      //       See SPILL_THRESHOLD_CHARS for rationale.
      if (w.parser && w.idle.isIdle && !w.wasIdle) {
        if (w.hasPendingReply) {
          // Worker was addressed (inject fired) and has now settled. Treat
          // the transcript slice as a real reply: spill-or-flush.
          const turnBody = w.transcript.slice(w.currentTurnStart);
          if (turnBody.length >= SPILL_THRESHOLD_CHARS) {
            this.spillAndNotify(w, turnBody);
            // Drain anything the parser had buffered — we just superseded
            // it via the drop file, and leaving it would let half-parsed
            // fragments route on the NEXT idle edge.
            w.parser.flush();
          } else {
            const pending = w.parser.flush();
            if (pending.length > 0) {
              this.stats.flushed += pending.length;
              this.output.appendLine(
                `[orch] ${w.cfg.id} idle — flushed ${pending.length} pending directive(s)`,
              );
              for (const m of pending) this.route(m, w.cfg.paneId);
            }
          }
          w.hasPendingReply = false;
        } else {
          // v0.6.1 — No inject was routed to this worker since the last
          // idle edge. The transcript growth is boot UI, status-tick
          // repaint, or ambient noise — NOT a reply. Skip spill/flush so
          // we do not emit spurious drop notices into the leader or
          // re-route stale fragments from the parser buffer. Still drain
          // the buffer so it does not accumulate.
          if (w.parser) w.parser.flush();
          this.output.appendLine(
            `[orch] ${w.cfg.id} idle edge skipped (no pending reply — boot/repaint)`,
          );
        }
        // Always advance the turn-start marker so the next real reply
        // slices from the right offset, regardless of which branch ran.
        w.currentTurnStart = w.transcript.length;
        w.wasIdle = true;
      } else if (!w.idle.isIdle) {
        w.wasIdle = false;
      }
      if (w.queue.length > 0 && w.idle.isIdle) {
        const next = w.queue.shift();
        if (next !== undefined) this.inject(w, next);
      }
    }

    // v0.3.0 · Auto-reset the round counter when the team has been quiet
    // for `autoResetRoundMs`. Lets the user's next prompt start from round
    // 0 without manual resetRound(). Gated on: (a) currentRound > 0 or cap
    // notice fired, (b) leader idle, (c) all workers idle, (d) no routing
    // activity within the window.
    if (
      this.autoResetRoundMs > 0 &&
      (this.currentRound > 0 || this.roundCapNotifyFired) &&
      this.lastRouteAt > 0 &&
      this.nowFn() - this.lastRouteAt >= this.autoResetRoundMs &&
      (!this.leaderIdle || this.leaderIdle.isIdle) &&
      [...this.workers.values()].every((w) => w.idle.isIdle && w.queue.length === 0)
    ) {
      this.resetRound();
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
