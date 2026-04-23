// Phase 2 · v2.7.9 / v0.3.0 — `@leader:` and `@worker-N:` routing token parser
// + Claude pane-output projector. v0.3.0 extended the token set so workers
// can also emit directives (ping-pong + worker-to-worker discussion).
//
// Syntax (Option A — our own, no OMC compat):
//
//   Single-line form:
//       @worker-1: Summarize the plan in three bullets.
//       @worker-2: Meanwhile draft a name for the product.
//       @leader: Done. Summary: ...
//
//   Multi-line form (for longer prompts):
//       @worker-1:
//       Paragraph one.
//       Paragraph two.
//       @end
//
// Why terminator-based, not line-based (v2.7.6 rewrite)
// -----------------------------------------------------
// Claude Code v2.1+ renders its assistant output with an Ink TUI that uses
// absolute cursor positioning instead of newlines between visual rows. So a
// block like
//     ● @worker-1: task one
//       @worker-2: task two
// arrives on the pty (after stripAnsi) as a single logical string with no
// `\n` between the rows — something like `●@worker-1:task one@worker-2:task
// two` (the "visual" spaces come from cursor-forward sequences that vanish
// with ANSI stripping). A strict line-anchored regex can never match this.
//
// We now scan for every `@worker-\d+:` in the streaming buffer and take the
// payload up to the EARLIEST of: the next token, `\n`, or explicit `@end`.
// If no terminator has arrived yet, we leave the token pending in the buffer
// and wait for more bytes.
//
// Important boundary (v2.7.9)
// ---------------------------
// `WorkerPatternParser` is intentionally UI-agnostic: it assumes the caller
// has ALREADY removed prompt-echo rows, status lines, and input-box chrome.
// Feeding raw Claude PTY output directly into this parser is incorrect on
// v2.1+ because the stream includes:
//   - user-typed prompt echo (`> @worker-1: ...`)
//   - input-box borders (`────...`)
//   - idle/status rows (`[OMC#...]`)
// PodiumOrchestrator now runs Claude leader chunks through a lightweight
// assistant-output projector first and only then calls `feed()`.
//
// No boundary guard
// -----------------
// An earlier design required the char before `@` to be non-alphanumeric (to
// reject e.g. `user@worker-1:`). That broke Claude's cursor-positioned
// compact form where the previous token's payload ends in an alphanumeric:
// `...payloadA@worker-2:...`. Without newlines separating tokens, we cannot
// distinguish "@worker-N:" inside an identifier from one that legitimately
// follows payload text. We accept the false-positive risk for prose like
// `user@worker-1:` — users writing explicit routing directives phrase them
// unambiguously.

export interface RoutedMessage {
  /**
   * Target identifier. `'leader'` for @leader: directives, otherwise a
   * worker id like `'worker-1'`. v0.3.0 widened this from worker-only so
   * workers can route back to the leader or a peer.
   */
  workerId: string;
  /** Payload text (multi-line bodies joined with `\n`). Never has trailing newline. */
  payload: string;
}

const TOKEN_RE = /@(leader|worker-\d+):/g;
const END_RE = /@end\b/;

// v0.4.0 — Protocol template / placeholder noise guard
// -----------------------------------------------------
// Two failure modes observed in field logs:
//
//   1. Leader, while acknowledging the protocol on its first turn, types a
//      template block that quotes the delegation syntax back, e.g.:
//         @worker-1: ... / @worker-2: ... (컬럼 0에서 시작)
//         - 라운드 예산: 작업당 10회
//         - Effort: max
//      The tokenizer happily yields directives with payloads like `... /`
//      and `... (컬럼 0에서 시작) - 라운드 예산: 작업당 10회`, which then
//      route to workers as if they were real tasks.
//
//   2. System-prompt example rows like `@worker-1: <task for worker-1>`
//      occasionally bleed through repaints; same class of problem.
//
// Filter payloads at yield-time so the orchestrator never sees them.
// Conservative by design: only drop payloads that are OBVIOUSLY template or
// placeholder content — never a legitimate user task.
const PLACEHOLDER_PAYLOAD_RE = /^[\s…./\-*·●•]+$/;
const PROTOCOL_META_RE = /컬럼\s*0\s*에서\s*시작|라운드\s*예산|작업당\s*\d+\s*회|Effort\s*[::]|<task for\b/;

function isProtocolNoise(payload: string): boolean {
  if (!payload) return true;
  const trimmed = payload.trim();
  if (trimmed.length === 0) return true;
  if (PLACEHOLDER_PAYLOAD_RE.test(trimmed)) return true;
  if (PROTOCOL_META_RE.test(trimmed)) return true;
  return false;
}
const CLAUDE_ASSISTANT_START_RE = /^\s*●(?:\s+|(?=@(?:worker-|leader:)))/;
const CLAUDE_ASSISTANT_CONT_RE = /^(?:\s{2,}\S|@(?:worker-\d+|leader):|@end\b)/;
// v0.3.6 · Bare routing directive at column 0 (no leading `●` bullet, no
// indent). Claude's assistant output sometimes drops into a new paragraph
// after a blank line, which classifies as 'other' and kicks the projector
// out of its assistant block; a subsequent `@worker-N:` / `@leader:`
// directive on its own line then gets suppressed. Treating such lines as
// assistant-start lets them both re-enter the block and make it to the
// WorkerPatternParser. Safe against prompt echo because prompt echoes
// always carry a `>` or `│ >` prefix (see CLAUDE_PROMPT_RE), so they
// never match a bare `@target:` start.
const CLAUDE_BARE_DIRECTIVE_RE = /^@(?:worker-\d+|leader):/;
const CLAUDE_PROMPT_RE = /^(?:>\s.*|>\s*$|│\s*>\s*.*)$/;
const CLAUDE_STATUS_RE = /^(?:\[OMC#[\d.]+\].*|⏵⏵\s+bypass permissions.*)$/;
const CLAUDE_CHROME_RE = /^[\s─━│┃╭╮╰╯┌┐└┘┏┓┗┛]+$/;

/**
 * Claude Code v2.1+ mixes assistant bullets, prompt echo, status rows, and
 * box-drawing chrome into the same PTY stream. This projector keeps ONLY the
 * assistant-visible region (`● ...` plus its continuation rows) so routing is
 * driven by model output, never by unsent user input.
 */
export class ClaudeLeaderRoutingProjector {
  private inAssistantBlock = false;
  /**
   * Partial line held between `feed()` calls. v2.7.14 fix for worker-2 drop:
   *
   * ConPTY splits the leader's output at arbitrary byte boundaries — a single
   * assistant line like `  @worker-2: 1부터 20까지의 짝수만 더해줘.` might
   * arrive as chunk A = `  @worker-2: 1부터 20까` followed by chunk B =
   * `지의 짝수만 더해줘.\n`.
   *
   * Pre-v2.7.14 the projector classified each chunk's tail as a full line.
   * Chunk A's tail matched `assistant-cont` (starts with `@worker-`) and was
   * emitted fine, but chunk B's lead (`지의 짝수만…`) started with a Hangul
   * syllable, classified as `other`, closed the assistant block, and got
   * dropped — stranding the parser's worker-2 token pending forever.
   *
   * Holding the trailing partial (everything after the last newline) until
   * the next feed makes classification operate on complete lines only, which
   * restores worker-2's continuation.
   */
  private partial = '';
  /** Sanity cap — if a "line" grows past this with no newline, assume the
   *  TUI is doing something unusual and reset to avoid unbounded memory use.
   *  8 KB is far larger than any realistic single visual line. */
  private static readonly MAX_PARTIAL = 8192;

  feed(chunk: string): string {
    if (!chunk) return '';
    const combined = this.partial + chunk;
    this.partial = '';

    let out = '';
    let consumed = 0;
    const re = /\r\n|\r|\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(combined)) !== null) {
      const lineEnd = m.index;
      const newlineEnd = re.lastIndex;
      const line = combined.slice(consumed, lineEnd);
      const newline = combined.slice(lineEnd, newlineEnd);
      consumed = newlineEnd;
      out += this.processLine(line, newline);
    }

    // Hold the trailing partial (no newline yet) for the next feed().
    const rest = combined.slice(consumed);
    if (rest.length > ClaudeLeaderRoutingProjector.MAX_PARTIAL) {
      // Unreasonable — flush as-is and reset, better than a silent memory leak.
      out += this.processLine(rest, '');
      this.partial = '';
      this.inAssistantBlock = false;
    } else {
      this.partial = rest;
    }
    return out;
  }

  private processLine(line: string, newline: string): string {
    const kind = classifyClaudeLine(line);
    if (kind === 'assistant-start') {
      this.inAssistantBlock = true;
      return line + newline;
    }
    if (!this.inAssistantBlock) return '';
    if (kind === 'assistant-cont' || kind === 'blank') {
      return line + newline;
    }
    // v2.7.30 — Ink-repaint tolerance
    // -------------------------------
    // Claude Code v2.1+'s Ink TUI continuously repaints the bottom input-box
    // prompt, status bar, and box chrome in the same PTY stream as the
    // assistant's streaming response. Pre-v2.7.30, the projector closed the
    // assistant block on any `prompt`/`status`/`chrome` line — which is
    // wrong, because those are cosmetic UI frames, not content boundaries.
    // When leader's response was long enough for Ink to sneak a repaint of
    // `> @worker-1: ...` between the `●` bullet and a later continuation
    // row, the block closed prematurely and the continuation `@worker-N:`
    // directive was stripped. Route silently failed.
    //
    // Fix: drop those cosmetic lines (return empty) but keep the assistant
    // block open. Only genuinely unknown 'other' content (model output that
    // doesn't match any recognized UI element) marks the block as ended.
    if (kind === 'other') {
      this.inAssistantBlock = false;
    }
    return '';
  }

  reset(): void {
    this.inAssistantBlock = false;
    this.partial = '';
  }
}

export class WorkerPatternParser {
  private buffer = '';

  /**
   * Feed a chunk of ANSI-stripped text. Returns every fully-terminated routed
   * message discovered in this chunk (in order). Partial content remains
   * buffered — the next `feed()` or a `flush()` call will surface it once a
   * terminator arrives.
   */
  feed(chunk: string): RoutedMessage[] {
    if (!chunk) return [];
    this.buffer += chunk;
    return this.drainComplete();
  }

  /**
   * Return any dangling routed message whose terminator hasn't arrived yet.
   * Call when the leader goes idle so a pending `@worker-1:…` (no trailing
   * `\n`, no next token) doesn't get stuck in the buffer forever.
   */
  flush(): RoutedMessage[] {
    const drained = this.drainComplete();
    const remaining = this.scanPendingToken();
    if (!remaining) return drained;
    const { workerId, payloadStart } = remaining;
    const payload = this.normalize(this.buffer.slice(payloadStart));
    this.buffer = '';
    if (payload.length === 0 || isProtocolNoise(payload)) return drained;
    return [...drained, { workerId, payload }];
  }

  private drainComplete(): RoutedMessage[] {
    const out: RoutedMessage[] = [];
    while (true) {
      const token = this.findTokenAfter(0);
      if (!token) return out;

      // Detect multi-line form: colon followed by (optional whitespace) then
      // newline, i.e. no same-line content. Multi-line payloads keep their
      // newlines and only terminate on `@end` or the next routing token.
      const afterColon = this.buffer.slice(token.endPos);
      const isMultiline = /^[ \t]*\r?\n/.test(afterColon);

      const terminator = isMultiline
        ? this.findMultilineTerminator(token.endPos)
        : this.findSingleLineTerminator(token.endPos);

      if (!terminator) {
        // No terminator yet → keep token+partial payload in buffer for next feed.
        this.buffer = this.buffer.slice(token.startPos);
        return out;
      }
      const rawPayload = this.buffer.slice(token.endPos, terminator.payloadEndPos);
      const payload = isMultiline
        ? this.normalizeMultiline(rawPayload)
        : this.normalize(rawPayload);
      if (payload.length > 0 && !isProtocolNoise(payload)) {
        out.push({ workerId: token.workerId, payload });
      }
      this.buffer = this.buffer.slice(terminator.advanceTo);
    }
  }

  /** Scan for the next routing token starting at or after `from`. */
  private findTokenAfter(
    from: number,
  ): { startPos: number; endPos: number; workerId: string } | null {
    TOKEN_RE.lastIndex = from;
    const m = TOKEN_RE.exec(this.buffer);
    if (!m) return null;
    return { startPos: m.index, endPos: m.index + m[0].length, workerId: m[1] };
  }

  private scanPendingToken(): { workerId: string; payloadStart: number } | null {
    const token = this.findTokenAfter(0);
    if (!token) return null;
    return { workerId: token.workerId, payloadStart: token.endPos };
  }

  /**
   * Single-line payload ends at earliest of: next @worker-N:, @end, or a
   * newline *not* followed by a 2-space-indented continuation row.
   *
   * v2.7.15 — continuation lookahead
   * --------------------------------
   * Claude's Ink TUI wraps long assistant lines by inserting a newline and a
   * 2-space indent between visual rows. Pre-v2.7.15 the parser terminated at
   * the first `\n`, so a multi-row directive like
   *
   *     @worker-1: Translate X, format as Y, example: Z.
   *       Step-by-step details on another row.
   *
   * got truncated to `Translate X, format as Y, example: Z.` (or earlier).
   * Now we peek past each `\n`: if the next line is a proper continuation
   * (2+ space indent, not a new `@worker-N:`, not `@end`, not a blank line)
   * we skip the newline and keep scanning.
   */
  private findSingleLineTerminator(
    from: number,
  ): { payloadEndPos: number; advanceTo: number } | null {
    let scanFrom = from;
    // Loop so that consecutive continuation rows all fold into the payload.
    // Bounded by buffer length; terminates on any non-continuation candidate.
    while (scanFrom <= this.buffer.length) {
      const nextToken = this.findTokenAfter(scanFrom);
      const nextNewline = indexOfNewline(this.buffer, scanFrom);
      const nextEnd = searchEndSentinel(this.buffer, scanFrom);

      interface Candidate {
        payloadEnd: number;
        advance: number;
        kind: 'token' | 'newline' | 'end';
      }
      const candidates: Candidate[] = [];
      if (nextToken) {
        candidates.push({ payloadEnd: nextToken.startPos, advance: nextToken.startPos, kind: 'token' });
      }
      if (nextNewline >= 0) {
        const nlLen = this.buffer[nextNewline] === '\r' && this.buffer[nextNewline + 1] === '\n' ? 2 : 1;
        candidates.push({ payloadEnd: nextNewline, advance: nextNewline + nlLen, kind: 'newline' });
      }
      if (nextEnd) {
        candidates.push({ payloadEnd: nextEnd.start, advance: nextEnd.end, kind: 'end' });
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => a.payloadEnd - b.payloadEnd);
      const chosen = candidates[0];

      if (chosen.kind !== 'newline') {
        // Token or @end is a hard terminator regardless of what follows.
        return { payloadEndPos: chosen.payloadEnd, advanceTo: chosen.advance };
      }

      // Peek the next line. If it looks like a continuation row, skip this
      // newline and keep scanning. Otherwise terminate here.
      const afterNl = chosen.advance;
      const peek = this.buffer.slice(afterNl, afterNl + 40);
      const isIndented = /^[ \t]{2,}\S/.test(peek);
      const startsWithTarget = /^[ \t]*@(?:worker-\d+|leader):/.test(peek);
      const startsWithEnd = /^[ \t]*@end\b/.test(peek);
      const isBlank = peek.length === 0 || /^[ \t]*(?:\r?\n|\r|$)/.test(peek);
      // v0.4.2 · (C) Terminal-punctuation guard
      // ---------------------------------------
      // If the payload up to this newline already ends with sentence-terminal
      // punctuation (period, question, exclamation, including CJK variants,
      // optionally followed by a close quote/paren), the directive is clearly
      // a complete thought. A 2-space-indented follow-up that Ink wraps onto
      // the next visual row after a terminated sentence is almost always a
      // separate assistant paragraph (e.g. "두 워커의 응답을 기다리겠습니다."
      // tacked after "@worker-2: "banana"이라고만 답하세요."), not a logical
      // continuation of the directive. Do NOT fold across terminal punctuation.
      // Multi-line directives that legitimately span sentences can still use
      // the explicit `@end` sentinel form documented at the top of this file.
      const payloadSoFar = this.buffer.slice(from, chosen.payloadEnd);
      const endsWithTerminalPunctuation =
        /[.!?。！？](?:["'"'')）\]]+)?\s*$/.test(payloadSoFar);
      const isContinuation =
        isIndented &&
        !startsWithTarget &&
        !startsWithEnd &&
        !isBlank &&
        !endsWithTerminalPunctuation;

      if (!isContinuation) {
        return { payloadEndPos: chosen.payloadEnd, advanceTo: chosen.advance };
      }

      // Fold this continuation row into the payload; keep scanning past it.
      scanFrom = afterNl;
    }
    return null;
  }

  /** Multi-line payload ends at @end OR next @worker-N: only. Newlines are content. */
  private findMultilineTerminator(
    from: number,
  ): { payloadEndPos: number; advanceTo: number } | null {
    const nextToken = this.findTokenAfter(from);
    const nextEnd = searchEndSentinel(this.buffer, from);

    const candidates: { payloadEnd: number; advance: number }[] = [];
    if (nextToken) {
      candidates.push({ payloadEnd: nextToken.startPos, advance: nextToken.startPos });
    }
    if (nextEnd) {
      candidates.push({ payloadEnd: nextEnd.start, advance: nextEnd.end });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.payloadEnd - b.payloadEnd);
    const chosen = candidates[0];
    return { payloadEndPos: chosen.payloadEnd, advanceTo: chosen.advance };
  }

  /**
   * Single-line normalize: strip leading bullet/indent, fold continuation
   * rows (\n + 2+ space indent) back to a single space, trim trailing
   * whitespace. v2.7.15: the continuation fold mirrors the terminator
   * lookahead — without it the raw slice would contain the raw `\n  `
   * sequences that Ink used for visual wrapping, and the worker would see
   * an awkwardly-broken prompt.
   */
  private normalize(raw: string): string {
    return raw
      .replace(/^[ \t●•\-*]+/, '')
      .replace(/\r?\n[ \t]{2,}/g, ' ')
      .replace(/[ \t\r\n]+$/g, '');
  }

  /** Multi-line normalize: keep internal newlines, trim boundary blank lines. */
  private normalizeMultiline(raw: string): string {
    const lines = raw.split(/\r?\n/);
    while (lines.length && lines[0].trim() === '') lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n');
  }
}

function indexOfNewline(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') return i;
    if (c === '\r') return i;
  }
  return -1;
}

function searchEndSentinel(s: string, from: number): { start: number; end: number } | null {
  const slice = s.slice(from);
  const m = END_RE.exec(slice);
  if (!m) return null;
  return { start: from + m.index, end: from + m.index + m[0].length };
}

type ProjectedLine = { line: string; newline: string };

function splitLinesPreservingEnd(input: string): ProjectedLine[] {
  const parts = input.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  const out: ProjectedLine[] = [];
  for (const part of parts) {
    if (part === '') continue;
    let newline = '';
    if (part.endsWith('\r\n')) newline = '\r\n';
    else if (part.endsWith('\n') || part.endsWith('\r')) newline = part.slice(-1);
    const line = newline ? part.slice(0, -newline.length) : part;
    out.push({ line, newline });
  }
  return out;
}

function classifyClaudeLine(
  line: string,
): 'assistant-start' | 'assistant-cont' | 'prompt' | 'status' | 'chrome' | 'blank' | 'other' {
  if (CLAUDE_ASSISTANT_START_RE.test(line)) return 'assistant-start';
  // v0.3.6 · Bare directive line at column 0 — re-enter the assistant block
  // so the projector emits it even if an earlier 'other' paragraph had
  // closed the block. Checked before CLAUDE_PROMPT_RE et al, but after the
  // bullet-prefixed CLAUDE_ASSISTANT_START_RE so the existing "start" path
  // stays authoritative for normally-formatted leader responses.
  if (CLAUDE_BARE_DIRECTIVE_RE.test(line)) return 'assistant-start';
  if (line.trim().length === 0) return 'blank';
  if (CLAUDE_PROMPT_RE.test(line)) return 'prompt';
  if (CLAUDE_STATUS_RE.test(line)) return 'status';
  if (CLAUDE_CHROME_RE.test(line)) return 'chrome';
  if (CLAUDE_ASSISTANT_CONT_RE.test(line)) return 'assistant-cont';
  return 'other';
}

// v0.3.0 — workers emit the same Ink TUI output as the leader, so the
// projector is agent-role-agnostic. This alias makes the reuse explicit
// at worker-side call sites without breaking legacy imports.
export { ClaudeLeaderRoutingProjector as ClaudeRoutingProjector };
