// Phase 2a · v2.7.1 — Per-agent prompt idle detector.
//
// The orchestrator must not inject a worker message while that worker's CLI
// is still streaming a response — the keystrokes would interleave with the
// model's in-progress output and corrupt both. So before routing an
// `@worker-N:` payload, we wait for that worker to be visibly idle (prompt
// shown, no recent output bytes).
//
// Strategy: two-factor detection.
//   1. Pattern match  — the last N lines of stripped output match the CLI's
//      known prompt glyph (Claude box, Codex `user>`, Gemini `>`).
//   2. Silence window — no new output bytes for `silenceMs` milliseconds.
//
// Both must be satisfied. Either alone is too flaky: a prompt pattern can
// appear mid-stream (e.g. inside a code block the model writes), and silence
// alone can occur during model "thinking" pauses where the CLI has not yet
// rendered the next token. Combined, false positives are rare.
//
// The detector consumes raw (un-stripped) output chunks because timing is
// driven by byte arrival, but it strips ANSI internally for pattern matching.

import { stripAnsi, stripAnsiLines } from './ansi';
import type { AgentKind } from './agentSpawn';

// Lines that we treat as "cosmetic refreshes" — they appear because the CLI's
// Ink/React TUI periodically repaints its status row or hint footer, NOT
// because the model is emitting content. If a pty chunk (after ANSI strip)
// contains only lines matching these, we update the rolling tail but DO NOT
// reset the silence timer. This prevents OMC status-line ticks from
// permanently masking the worker's real idle state.
const COSMETIC_LINE_PATTERNS: RegExp[] = [
  /^\[OMC#[\d.]+\]/,            // OMC status row
  /^⏵⏵\s+bypass permissions/,   // Claude v2.1+ bypass hint
  /^>\s*$/,                      // bare prompt row
  /^user>\s*$/,                  // codex bare prompt
];

// v0.3.5 · Claude v2.1+ Ink alt-screen repaint.
//
// Ink writes the bottom UI (prompt + OMC status + bypass hint) using
// cursor-positioning escapes instead of newlines, so after `stripAnsi` the
// positioning codes vanish and the fragments concatenate into one logical
// "line" like:
//   `>                  [OMC#4.12.0] | 5h:51%... | ctx:4%    ⏵⏵ bypass permissions on (shift+tab to cycle)`
// None of the anchored patterns above match that shape, so `lastOutputAt`
// was refreshing on every Ink repaint (several times per second) and a
// worker pane sitting at its fresh prompt reported `isIdle === false`
// indefinitely — v0.3.4 field log: `queue worker-1 (busy, queue=2)` with
// no inject ever firing.
//
// These contains-patterns catch the concatenated form. Risk: if an assistant
// response literally quotes the OMC status bar we'd classify that line as
// cosmetic and delay the silence window by a tick — acceptable tradeoff.
const COSMETIC_CONTAINS_PATTERNS: RegExp[] = [
  // Any chunk carrying BOTH the status row and the bypass hint is an Ink
  // compact repaint — the two almost never co-occur in real assistant prose.
  /\[OMC#[\d.]+\].*?bypass\s+permissions/s,
  // Compact repaint that caught only the status + prompt (no bypass visible).
  /^\s*>\s+\[OMC#[\d.]+\]/,
];

function isCosmeticLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return true; // blank lines are cosmetic by definition
  if (COSMETIC_LINE_PATTERNS.some((re) => re.test(t))) return true;
  return COSMETIC_CONTAINS_PATTERNS.some((re) => re.test(t));
}

export interface IdleDetectorOptions {
  agent: AgentKind;
  /** Milliseconds of output silence required before declaring idle. */
  silenceMs?: number;
  /** Test injection: wall clock source. */
  now?: () => number;
  /**
   * How many trailing lines of the rolling buffer to check for the prompt.
   * Claude's box drawing can span several lines so we default to 8.
   */
  lookbackLines?: number;
}

const DEFAULTS = {
  silenceMs: 500,
  lookbackLines: 8,
} as const;

// Prompt regexes — conservative; tuned to avoid matching *inside* model output.
// Each is applied to a single stripped-and-trimmed line.
// Claude Code ≥ v2.1 dropped the boxed prompt in favor of a plain `>` row
// above an OMC status line. We keep the old box patterns so that sessions
// without OMC / older Claude builds still detect idle correctly.
//   v2.1+ (observed 2026-04-21):
//       >
//       [OMC#4.12.0] | 5h:28%(2h32m) … | session:0m | ctx:4%
//       ⏵⏵ bypass permissions on (shift+tab to cycle)
//   older (boxed):
//       ╭─────────────╮
//       │ >           │
//       ╰─────────────╯
const PROMPT_PATTERNS: Record<AgentKind, RegExp[]> = {
  claude: [
    /^\s*╰─+╯\s*$/,              // boxed bottom border
    /^\s*│\s*>\s*$/,             // boxed input row (empty)
    /^\s*│\s*>\s+/,              // boxed input row (with content)
    /^\s*╰──+/,                  // boxed bottom border (loose)
    /^\s*>\s*$/,                 // v2.1+ plain prompt row (v2.7.22: allow leading ws)
    /^\s*\[OMC#[\d.]+\]\s*\|/,   // v2.1+ OMC status line (v2.7.22: allow leading ws)
    /^\s*⏵⏵\s+bypass permissions/, // v2.7.22: bypass hint appears immediately after prompt
  ],
  // Codex CLI prints `user> ` at column 0 when awaiting input.
  codex: [/^user>\s*$/, /^user>\s+/],
  // Gemini CLI prints `> ` at column 0 (sometimes with leading space).
  gemini: [/^>\s*$/, /^>\s+$/],
};

export class IdleDetector {
  private readonly agent: AgentKind;
  private readonly silenceMs: number;
  private readonly lookback: number;
  private readonly now: () => number;
  private lastOutputAt: number;
  private rollingTail: string[] = [];

  constructor(opts: IdleDetectorOptions) {
    this.agent = opts.agent;
    this.silenceMs = opts.silenceMs ?? DEFAULTS.silenceMs;
    this.lookback = opts.lookbackLines ?? DEFAULTS.lookbackLines;
    this.now = opts.now ?? Date.now;
    this.lastOutputAt = this.now();
  }

  /**
   * Feed a raw pty chunk. Always refreshes the rolling prompt buffer; only
   * resets the silence timer when the chunk contains non-cosmetic content
   * (see `COSMETIC_LINE_PATTERNS`).
   */
  feed(rawChunk: string): void {
    if (!rawChunk) return;
    const lines = stripAnsiLines(rawChunk);
    let hasRealContent = false;
    for (const line of lines) {
      this.rollingTail.push(line);
      if (!isCosmeticLine(line)) hasRealContent = true;
    }
    if (hasRealContent) {
      this.lastOutputAt = this.now();
    } else if (stripAnsi(rawChunk).length === 0 && rawChunk.length > 0) {
      // Pure ANSI control traffic (cursor moves, SGR resets, alt-screen toggles)
      // with no visible text — also cosmetic.
    }
    if (this.rollingTail.length > this.lookback * 4) {
      this.rollingTail = this.rollingTail.slice(-this.lookback * 2);
    }
  }

  /**
   * True when both the silence window has elapsed *and* the recent output
   * ends with a recognized prompt pattern.
   */
  get isIdle(): boolean {
    if (this.now() - this.lastOutputAt < this.silenceMs) return false;
    return this.hasPromptPattern();
  }

  /** Expose for debugging / orchestration HUD. */
  get msSinceOutput(): number {
    return this.now() - this.lastOutputAt;
  }

  /** Reset after a message is injected — we expect new output to follow. */
  markBusy(): void {
    this.lastOutputAt = this.now();
    this.rollingTail = [];
  }

  private hasPromptPattern(): boolean {
    const tail = this.rollingTail
      .filter((l) => l.trim().length > 0)
      .slice(-this.lookback);
    const patterns = PROMPT_PATTERNS[this.agent];
    for (let i = tail.length - 1; i >= 0; i--) {
      for (const re of patterns) {
        if (re.test(tail[i])) return true;
      }
    }
    return false;
  }
}
