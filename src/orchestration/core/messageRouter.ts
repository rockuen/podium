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
// v0.3.6 / v0.7.2 · Bare or indented routing directive. Classify as
// assistant-start so the projector re-enters the assistant block whenever
// a `@worker-N:` / `@leader:` directive appears, regardless of leading
// whitespace.
//
// Why the relaxed (v0.7.2) match
// ------------------------------
// v0.3.6 required column 0 (no leading whitespace). Field logs of the
// v0.7.1 reverseString task chain showed Claude leaders frequently emit
// their delegation lines INDENTED (as part of an Ink-wrapped continuation
// of a preceding bullet paragraph that the projector has meanwhile closed
// because a 'other' line — diagnostic narration, status repaint — kicked
// it out). The subsequent `    @worker-2: ...` line then matched only
// CLAUDE_ASSISTANT_CONT_RE, which drops when the block is closed. Result:
// the entire `@worker-2: ...` directive (and its body continuation rows)
// got suppressed, worker-2 was never routed to, and the leader filled
// the gap by hallucinating a reply.
//
// Safe against prompt echo: echoes always carry a `>` or `│ >` prefix
// (see CLAUDE_PROMPT_RE), which matches before this check.
const CLAUDE_BARE_DIRECTIVE_RE = /^[ \t]*@(?:worker-\d+|leader):/;
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
   * v0.7.2 — Last non-blank line classification. Used to disambiguate an
   * indented `@worker-N:` / `@leader:` line: at column 1+ the pattern
   * looks identical in two very different contexts:
   *
   *   (a) An assistant-emitted delegation whose directive got Ink-
   *       indented under a preceding bullet — legitimate routing; we
   *       want to re-open the assistant block.
   *   (b) The 2nd+ line of a multi-worker PROMPT ECHO. The user's
   *       original input rendered as:
   *         > @worker-1: ...
   *           @worker-2: ...   ← indented, no `>` prefix
   *       The second line looks like (a) by regex alone, but is in fact
   *       pure echo and must stay dropped.
   *
   * We distinguish them by the most-recent non-blank classification:
   * after a `prompt` line, any subsequent indented directive is still
   * prompt-echo territory until we see something clearly not-prompt
   * (assistant-start, chrome, status, or other).
   */
  private lastKind: 'prompt' | 'chrome' | 'status' | 'assistant-start' | 'assistant-cont' | 'other' | null = null;
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
    let kind = classifyClaudeLine(line);
    // v0.7.2 / v0.14.0 — Prompt-echo continuation guard.
    //
    // v0.7.2 demoted INDENTED `@worker-N: ...` directives that landed
    // right after a prompt line back to `prompt` kind, treating them as
    // echo continuation of the user's multi-line input box.
    //
    // v0.14.0 — Field evidence (parseCSV, 2026-04-26): Ink TUI also
    // fragments multi-line input echoes such that the second line
    // arrives at column 0 (the leading `│ `/spaces are split into a
    // separate chunk that the projector classifies as chrome and drops,
    // leaving a bare `@worker-N:` line). The original indent gate
    // therefore failed to demote those echoes and the parser yielded
    // the user's own message text as a fresh directive — which the
    // v0.13.0 file-system gate then rejected, producing the false
    // "재촉" reject loop the user reported. Drop the indent restriction
    // so prompt-context column-0 directives are also demoted.
    //
    // Safe against legitimate column-0 routing: a real LLM delegation
    // begins with `●` (assistant-start) which opens the block FIRST,
    // so by the time its directive line is processed `inAssistantBlock`
    // is already true and this guard does not fire.
    if (
      kind === 'assistant-start' &&
      this.lastKind === 'prompt' &&
      !this.inAssistantBlock
    ) {
      kind = 'prompt';
    }
    if (kind === 'assistant-start') {
      this.inAssistantBlock = true;
      this.lastKind = kind;
      return line + newline;
    }
    if (kind !== 'blank') this.lastKind = kind;
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
    this.lastKind = null;
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
   *
   * v0.11.2 — wrap-suspect hold on flush
   * ------------------------------------
   * Field finding 2026-04-25 (parseCSV directive, 52B truncation): leader
   * emitted `@worker-1: JavaScript 함수 parseCSV(csv, options)를 RFC 4180\n`
   * as the first chunk. The buffer-last newline + no terminal punct + 50+
   * chars puts the parser in v0.8.7 hold from drainComplete. But idleDetector
   * read a brief inter-chunk silence as "leader idle", PodiumOrchestrator
   * called flush(), and flush() unconditionally yielded the partial — which
   * then committed to dedupe map under its first-line key, blocking ALL
   * subsequent longer-payload yields as same-key duplicates. The 52B drop
   * was the result.
   *
   * Fix: when the dangling partial is wrap-suspect (newline buffer-last + no
   * terminal punctuation + ≥30 chars) AND has no continuation chunk yet,
   * keep holding instead of flushing. The pending payload stays in the
   * buffer; the next chunk has a chance to complete it. If the leader
   * genuinely never produces a continuation, the wall-clock force-commit in
   * tryDispatchPending eventually surfaces it via the dispatch path (which
   * uses the LATEST yield, not the truncated one).
   */
  flush(): RoutedMessage[] {
    const drained = this.drainComplete();
    const remaining = this.scanPendingToken();
    if (!remaining) return drained;
    const { workerId, payloadStart } = remaining;
    const rawPayload = this.buffer.slice(payloadStart);
    const trimmedTail = rawPayload.replace(/\s+$/, '');
    const endsWithTerminalPunct =
      /[.!?。！？](?:["'"'')）\]]+)?$/.test(trimmedTail);
    const endsWithNewline = /\r?\n\s*$/.test(rawPayload);
    const WRAP_SUSPECT_THRESHOLD = 30;
    if (
      endsWithNewline &&
      !endsWithTerminalPunct &&
      trimmedTail.length >= WRAP_SUSPECT_THRESHOLD
    ) {
      // Hold: don't flush a wrap-suspect partial. Buffer keeps the pending
      // token + payload; the next feed() drains the completed payload, or
      // the dispatch wall-clock cap surfaces the held partial through the
      // normal path. Either way we avoid poisoning dedupe map with a
      // truncated first-line key.
      return drained;
    }
    const payload = this.normalize(rawPayload);
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
      // v0.8.7 · Hold at end-of-buffer newlines when the payload is
      // wrap-suspect (long, not sentence-terminated).
      //
      // Field evidence (session 2026-04-24): the drop
      // `to-worker-2-turn6-seq1.md` was cut at 69 bytes mid-sentence
      // ("...reverseStringSimple,") because Ink visual-wrapped a long
      // directive at a comma, the wrapped row
      // ("  reverseStringUnicode) ...") arrived in a LATER pty chunk,
      // and the parser had already yielded the truncated first row and
      // advanced past the `@worker-2:` token — so the continuation hit
      // the stream with no token and was treated as narrative.
      //
      // Heuristic: hold only on the FIRST iteration (before any
      // continuation has been folded) when the newline is the buffer's
      // last byte AND the payload is not sentence-terminated. Once we
      // have folded at least one continuation row, the payload is
      // already multi-line and an end-of-buffer newline there is a
      // reasonable terminator — returning null would risk never
      // yielding (iteration count could grow with every chunk).
      //
      // Matched test fixtures that informed this shape:
      //  - v2.7.15 compat (folding across chunks): scanFrom == from on
      //    iter 1, but the buffer ends AFTER content, so afterNl <
      //    buffer.length. Check doesn't trigger.
      //  - v0.4.2 non-terminated folding: iter 2 hits end-of-buffer
      //    newline; guard allows yield because scanFrom != from.
      //  - CRLF split directives: iter 1 on second token hits
      //    end-of-buffer but payload is 4 chars ("next") + terminal
      //    punctuation test still false — the LENGTH guard below
      //    short-circuits.
      //
      // Worst case if the continuation never arrives: the idle-edge
      // `flush()` path surfaces the partial as-is. Cost: ~ next chunk
      // arrival delay (tens to hundreds of ms).
      if (scanFrom === from && afterNl >= this.buffer.length) {
        const payloadSoFar = this.buffer.slice(from, chosen.payloadEnd);
        const WRAP_SUSPECT_THRESHOLD = 30;
        const endsWithTerminalPunct =
          /[.!?。！？…](?:["'"'')）\]]+)?\s*$/.test(payloadSoFar);
        if (!endsWithTerminalPunct && payloadSoFar.length >= WRAP_SUSPECT_THRESHOLD) {
          return null;
        }
      }
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
      // v0.8.9 · no-indent wrap continuation
      // -------------------------------------
      // Field evidence (2026-04-23 `to-worker-2-turn4-seq1.md`, 60B): Ink
      // occasionally wraps long directives onto the next visual row with
      // NO 2-space indent. v2.7.15 required indent to classify as
      // continuation, so these landed as premature terminators and the
      // worker received a directive cut mid-sentence at "(1)".
      //
      // When the payload is long enough that Ink would plausibly have
      // wrapped it (WRAP_SUSPECT_THRESHOLD chars, same as the v0.8.7
      // end-of-buffer hold) AND has no terminal punctuation, treat a
      // non-indented next line as continuation too — provided it's not a
      // new `@target:`, not `@end`, and not blank. Those three guards
      // still correctly terminate the legitimate leader-multi-line cases.
      //
      // Asymmetry rationale: under-fold is silent truncation (worker
      // gets unusable instructions, leader never notices). Over-fold is
      // recoverable (worker reads a few extra tokens of context). Prefer
      // over-fold when the signal is ambiguous.
      const WRAP_SUSPECT_THRESHOLD = 30;
      const isWrapSuspect =
        !endsWithTerminalPunctuation && payloadSoFar.length >= WRAP_SUSPECT_THRESHOLD;
      // v0.11.2 · list-intro blank fold
      // -------------------------------
      // Field finding 2026-04-25 (`to-worker-1-turn2-seq1.md`, 93B): leader
      // emitted a single-line directive ending in a colon ("...요구사항:")
      // followed by a blank line and a bullet list. The v0.4.2 blank-line
      // guard treated the blank as paragraph terminator, so the parser
      // yielded only the truncated first line and the spill drop file
      // held only that header. When the payload ends with a colon, the
      // blank line is almost always a list intro ("Requirements:\n\n- a"),
      // not a paragraph break. Peek past the blank: if a bullet/number/
      // indented content follows (and it is not a new `@target:` / `@end`),
      // accept the blank as a fold point. One-shot — only this blank folds.
      // The next blank line still terminates as before, so legitimate
      // multi-paragraph narrative after the list is not over-folded.
      const endsWithColon = /:\s*$/.test(payloadSoFar);
      // v0.11.2 — list-marker patterns the parser recognizes as "fold-able
      // continuation". Field finding 2026-04-25 (parseCSV directive, 93B
      // truncation): leader emitted `요구사항: (1) options로... (2) RFC 4180
      // ...` — parenthesized digit numbering, common in Korean-language
      // technical specs. The original `\d+[.)]\s` pattern only matched
      // `1.` / `1)` and missed `(1)`, so the blank line after `요구사항:`
      // didn't qualify for the list-intro fold and the directive truncated.
      // Patterns now covered:
      //   bullet:        `-` `*` `•` (followed by space)
      //   numbered:      `1.` `1)` `(1)` `[1]`
      //   alphabetic:    `(a)` `(가)`         (parenthesized letters / Hangul)
      //   bold:          `**foo`              (markdown bold start)
      //   header:        `#` `##` ... `######`
      //   indented:      any 1+ space + non-space (Ink wrap continuation)
      const LIST_MARKER_RE =
        /^\s*(?:[-*•]\s|\d+[.)]\s|\(\d+\)\s|\([A-Za-z가-힣]\)\s|\[\d+\]\s)/;
      let isListIntroBlank = false;
      if (isBlank && endsWithColon) {
        const blankMatch = peek.match(/^[ \t]*(?:\r\n|\r|\n|$)/);
        const blankLen = blankMatch ? blankMatch[0].length : 0;
        const followAfter = this.buffer.slice(afterNl + blankLen, afterNl + blankLen + 80);
        const followLooksLikeListItem =
          LIST_MARKER_RE.test(followAfter) || /^\s+\S/.test(followAfter);
        const followIsRouting =
          /^\s*@(?:worker-\d+|leader):/.test(followAfter) ||
          /^\s*@end\b/.test(followAfter);
        if (followLooksLikeListItem && !followIsRouting) {
          isListIntroBlank = true;
        }
      }
      // v0.11.2 — Same as isListIntroBlank but the trigger is the colon
      // appearing INLINE in the payload (no blank line in between). Field
      // finding 2026-04-25: `@worker-1: ...구현해줘. 요구사항: (1) options
      // 로...` arrives as a SINGLE chunk in one Ink visual row (Korean
      // collapses to fewer columns; no Ink wrap, no blank line). The parser
      // hits the newline at end of "요구사항:" with the next line starting
      // `(1) options로...` directly — followAfter starts with the list
      // marker, no blank between them. Treat that the same way: if payload
      // ends with a colon AND next line is a list marker, fold without
      // requiring the blank.
      let isInlineListAfterColon = false;
      if (!isBlank && endsWithColon) {
        const followAfter = this.buffer.slice(afterNl, afterNl + 80);
        const followLooksLikeListItem = LIST_MARKER_RE.test(followAfter);
        const followIsRouting =
          /^\s*@(?:worker-\d+|leader):/.test(followAfter) ||
          /^\s*@end\b/.test(followAfter);
        if (followLooksLikeListItem && !followIsRouting) {
          isInlineListAfterColon = true;
        }
      }
      // v0.11.2 — strong-marker continuation across terminal punct + blank.
      // Field finding 2026-04-25 (long parseCSV directive): leader emitted
      // `@worker-1: ...구현해주세요.\n\n**요구사항**\n- 시그니처: ...` —
      // multiple paragraphs of bold / bullet / numbered list / markdown
      // headers. The v0.4.2 terminal-punct guard terminated at "구현해
      // 주세요." and the spill drop held only the single-sentence header.
      // When `.`/`?`/`!` is followed by a blank line AND a STRONG markdown
      // marker (bullet `- * •`, numbered `1.` `1)`, bold `**foo**`,
      // markdown header `# Title`), treat the blank as intro-to-list/
      // section, not a paragraph break. Plain narrative continuations
      // ("I'll wait for your reply.") don't match the strong-marker check,
      // so the terminal-punct guard still fires for those.
      let isStrongMarkerBlank = false;
      if (isBlank && endsWithTerminalPunctuation) {
        const blankMatch = peek.match(/^[ \t]*(?:\r\n|\r|\n|$)/);
        const blankLen = blankMatch ? blankMatch[0].length : 0;
        const followAfter = this.buffer.slice(afterNl + blankLen, afterNl + blankLen + 80);
        // Strong marker = list marker (LIST_MARKER_RE) OR markdown bold start
        // (`**foo`) OR markdown header (`#`..`######`). All require strong
        // visual signal, never folds across narrative paragraphs.
        const followIsStrongMarker =
          LIST_MARKER_RE.test(followAfter) || /^\s*(?:\*\*\S|#{1,6}\s)/.test(followAfter);
        const followIsRouting =
          /^\s*@(?:worker-\d+|leader):/.test(followAfter) ||
          /^\s*@end\b/.test(followAfter);
        if (followIsStrongMarker && !followIsRouting) {
          isStrongMarkerBlank = true;
        }
      }
      const isContinuation =
        (isIndented || isWrapSuspect || isListIntroBlank || isStrongMarkerBlank || isInlineListAfterColon) &&
        !startsWithTarget &&
        !startsWithEnd &&
        (!isBlank || isListIntroBlank || isStrongMarkerBlank) &&
        (!endsWithTerminalPunctuation || isStrongMarkerBlank);

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
   * rows back to a single space, trim trailing whitespace. Mirrors the
   * terminator lookahead in `findSingleLineTerminator`.
   *
   * v2.7.15 folded `\n` + 2+ space indent (Ink's default wrap form).
   * v0.8.9 folds `\n` with any indent (including 0), because Ink
   * occasionally emits wraps without the 2-space indent and the parser
   * now accepts those as continuations when the payload is wrap-suspect.
   * Any `\n` that survived to this point is confirmed to be mid-payload
   * (the parser already ruled out target/end/blank/terminal-punct), so
   * collapsing it to a single space is always correct for single-line
   * bodies.
   */
  private normalize(raw: string): string {
    return raw
      .replace(/^[ \t●•\-*]+/, '')
      .replace(/\r?\n[ \t]*/g, ' ')
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
