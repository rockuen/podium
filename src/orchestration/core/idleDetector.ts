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

export function isCosmeticLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return true; // blank lines are cosmetic by definition
  if (COSMETIC_LINE_PATTERNS.some((re) => re.test(t))) return true;
  return COSMETIC_CONTAINS_PATTERNS.some((re) => re.test(t));
}

// v0.8.5 — Ink TUI noise patterns used by the drop-file sanitizer.
//
// isCosmeticLine above stays narrow because IdleDetector.feed uses it to
// decide whether a chunk resets the silence timer. Expanding it would
// make the timer drift when Claude streams "Channelling…" updates for
// 30s straight. But the DROP FILE pipeline has no such constraint — it
// just needs to strip every Ink-rendered artifact that is not part of
// the worker's logical reply, so the leader's Read tool lands on real
// content. Field evidence (v0.8.4 drops worker-1-turn4-seq2.md = 16 KB
// of which maybe 200 bytes were the actual reply): the noise dominates.
//
// Pattern taxonomy (observed in 2026-04-24 session drops):
//
//   1. Spinner glyphs on their own line or paired with a fragment of a
//      thinking verb: "✻", "✶ C", "✢    n  l", etc.
//   2. Thinking verbs: "Channelling…", "Pouncing…", "Sautéed", "Cooked".
//      Claude rotates through dozens of these (Simmering, Harmonizing,
//      Contemplating, Ruminating, Brewing, Rendering, Reticulating,
//      Distilling, Marinating, Percolating, Manifesting, Musing,
//      Pondering, Processing, Thinking, …). Ink cursor-positions each
//      letter separately so they often arrive as fragmented 1–3 letter
//      scraps ("Po", "u", "n", "ci g…") — see FRAGMENT rule below.
//   3. Status / timing markers: "(2s · thinking)", "↓ 13 tokens ·
//      thinking)", "45 tokens · thinking".
//   4. Box drawing rules and the Claude logo art block:
//      "───────…", "▐▛███▜▌", "▝▜█████▛▘", "▘▘ ▝▝".
//   5. Tool-use chrome: "⎿ path", "● Reading 1 file…", "Found 1 settings
//      issue · /doctor for details", "ctrl+g to edit in Notepad".
const SPINNER_CHARS_RE = /[✻✶✢·✽]/;
const THINKING_VERB_RE = /^\s*[✻✶✢·✽]?\s*(Channelling|Pouncing|Saut[ée]ed|Cooked|Harmonizing|Manifesting|Thinking|Processing|Reticulating|Percolating|Distilling|Simmering|Brewing|Marinating|Rendering|Contemplating|Cogitating|Deliberating|Musing|Ruminating|Pondering|Reflecting|Noodling|Pouring|Whisking|Kneading|Braising|Poaching|Grilling|Roasting|Frying|Baking|Steaming|Broiling|Sizzling|Pickling|Curing|Aging|Fermenting|Smoking|Blending|Infusing|Reducing|Glazing|Searing)…?/i;
const TIMING_MARKER_RE = /\(\s*\d+s\s*·|·\s*thinking\)/;
const TOKEN_COUNTER_RE = /(?:^|\s)(?:↑|↓)?\s*\d+\s+tokens\b|\bthinking\b/;
const BOX_RULE_RE = /^[─━═╌╍\s]*$/;
const LOGO_RE = /^\s*[▐▛▜▌▝▘█▖▗▘▝▙▟◢◣]+/;
const BOX_CHROME_RE = /^\s*[│╭╮╰╯┤├┴┬┼]/;
const TOOL_LEADER_RE = /^\s*⎿/;
const BARE_BULLET_RE = /^\s*●\s*$/;
const READING_FILE_RE = /^\s*[●•]?\s*Reading\s+\d+\s+file/;
const SETTINGS_ISSUE_RE = /Found\s+\d+\s+settings?\s+issue/;
const CTRL_HINT_RE = /^\s*ctrl\+[a-z]\s+/;

export function isInkNoise(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false; // blank = caller decides

  // 1. Spinner + fragment: any line containing a dedicated spinner glyph
  //    (not `●`, which starts real assistant lines) that has no prose
  //    content beyond it.
  if (SPINNER_CHARS_RE.test(t)) {
    // A "real" line containing a spinner is vanishingly rare — prose
    // doesn't quote U+273B / U+273A / U+2733 / U+00B7 / U+273D. Treat
    // any spinner-containing line as noise.
    return true;
  }

  // 2. Thinking verb, optionally preceded by a spinner (already handled
  //    above) or plain.
  if (THINKING_VERB_RE.test(t)) return true;

  // 3. Timing / token markers.
  if (TIMING_MARKER_RE.test(t)) return true;
  if (TOKEN_COUNTER_RE.test(t) && t.length < 80) return true;

  // 4. Box-drawing only, Claude logo art, or a bare logo row.
  if (BOX_RULE_RE.test(t)) return true;
  if (LOGO_RE.test(t)) return true;
  if (BOX_CHROME_RE.test(t) && t.length < 80) return true;

  // 5. Tool-use chrome.
  if (TOOL_LEADER_RE.test(t)) return true;
  if (BARE_BULLET_RE.test(t)) return true;
  if (READING_FILE_RE.test(t) && t.length < 100) return true;
  if (SETTINGS_ISSUE_RE.test(t)) return true;
  if (CTRL_HINT_RE.test(t)) return true;

  // 6. Stream fragments: Ink splits thinking verbs character-by-character
  //    across cursor positions, so after stripAnsi we see short lines
  //    like "Po", "u", "ci g…", "h n". Any very short line consisting
  //    entirely of ASCII letters + glyph chars is almost certainly such
  //    a fragment. We cap at length 3 to avoid dropping legitimate
  //    single-word responses.
  if (t.length <= 3 && /^[A-Za-z…]+$/.test(t)) return true;

  return false;
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
    // v0.3.8 · Claude Ink alt-screen compact repaint. Cursor-positioning
    // escapes render prompt + status + bypass as one logical "line" after
    // stripAnsi: `>                [OMC#4.12.0] | ... | ctx:0%    ⏵⏵ bypass
    // permissions on (shift+tab to cycle)`. None of the anchored patterns
    // above match it, so hasPromptPattern() returned false even when the
    // worker/leader was clearly sitting at a fresh prompt (v0.3.7 field
    // log: 52s silence with re-arm loop — silence window satisfied but
    // prompt pattern kept failing). Contains-match catches the concat.
    /\[OMC#[\d.]+\]\s*\|/,       // OMC status present anywhere on the line
    /⏵⏵\s+bypass permissions/,   // bypass hint present anywhere on the line
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
