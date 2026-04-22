// Phase 2 · v2.7.9 — `@worker-N` routing token parser + Claude leader-output
// projector.
//
// Syntax (Option A — our own, no OMC compat):
//
//   Single-line form:
//       @worker-1: Summarize the plan in three bullets.
//       @worker-2: Meanwhile draft a name for the product.
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
  /** Worker identifier, e.g. `worker-1`. */
  workerId: string;
  /** Payload text (multi-line bodies joined with `\n`). Never has trailing newline. */
  payload: string;
}

const TOKEN_RE = /@(worker-\d+):/g;
const END_RE = /@end\b/;
const CLAUDE_ASSISTANT_START_RE = /^\s*●(?:\s+|(?=@worker-))/;
const CLAUDE_ASSISTANT_CONT_RE = /^(?:\s{2,}\S|@worker-\d+:|@end\b)/;
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
    if (payload.length === 0) return drained;
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
      if (payload.length > 0) {
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
      const startsWithWorker = /^[ \t]*@worker-\d+:/.test(peek);
      const startsWithEnd = /^[ \t]*@end\b/.test(peek);
      const isBlank = peek.length === 0 || /^[ \t]*(?:\r?\n|\r|$)/.test(peek);
      const isContinuation = isIndented && !startsWithWorker && !startsWithEnd && !isBlank;

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
  if (line.trim().length === 0) return 'blank';
  if (CLAUDE_PROMPT_RE.test(line)) return 'prompt';
  if (CLAUDE_STATUS_RE.test(line)) return 'status';
  if (CLAUDE_CHROME_RE.test(line)) return 'chrome';
  if (CLAUDE_ASSISTANT_CONT_RE.test(line)) return 'assistant-cont';
  return 'other';
}
