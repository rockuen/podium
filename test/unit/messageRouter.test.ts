import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ClaudeLeaderRoutingProjector,
  WorkerPatternParser,
  type RoutedMessage,
} from '../../src/orchestration/core/messageRouter';

// ─── Parser ───

test('router: single-line terminated by \\n', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: hello there\n');
  assert.deepEqual(msgs, [{ workerId: 'worker-1', payload: 'hello there' }]);
});

test('router: two tokens on separate lines', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: summarize\n@worker-2: name it\n');
  assert.deepEqual(msgs, [
    { workerId: 'worker-1', payload: 'summarize' },
    { workerId: 'worker-2', payload: 'name it' },
  ]);
});

test('router: compact form — two tokens glued on one line', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '●@worker-1:1부터5까지숫자를한줄로써줘.@worker-2:2글자단어세개를쉼표로구분해서써줘.',
  );
  assert.deepEqual(msgs, [
    { workerId: 'worker-1', payload: '1부터5까지숫자를한줄로써줘.' },
  ]);
  assert.deepEqual(p.flush(), [
    { workerId: 'worker-2', payload: '2글자단어세개를쉼표로구분해서써줘.' },
  ]);
});

test('router: chunk split mid-payload is buffered until terminator', () => {
  const p = new WorkerPatternParser();
  const a = p.feed('@worker-1: hel');
  const b = p.feed('lo there\n');
  assert.deepEqual(a, []);
  assert.deepEqual(b, [{ workerId: 'worker-1', payload: 'hello there' }]);
});

test('router: CRLF line endings are handled', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: windows line\r\n@worker-2: next\r\n');
  assert.deepEqual(msgs, [
    { workerId: 'worker-1', payload: 'windows line' },
    { workerId: 'worker-2', payload: 'next' },
  ]);
});

test('router: multi-line block with @end sentinel preserves newlines', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1:\nfirst paragraph\n\nsecond paragraph\n@end\n');
  assert.deepEqual(msgs, [
    { workerId: 'worker-1', payload: 'first paragraph\n\nsecond paragraph' },
  ]);
});

test('router: flush returns dangling single-line token', () => {
  const p = new WorkerPatternParser();
  p.feed('@worker-1: uncompleted payload');
  assert.deepEqual(p.flush(), [{ workerId: 'worker-1', payload: 'uncompleted payload' }]);
  assert.deepEqual(p.flush(), []);
});

test('router v0.8.7: long directive wrapped across two pty chunks is NOT truncated', () => {
  // Field bug: leader emitted a long directive Ink-wrapped at a comma.
  // First pty chunk ended exactly at the wrap newline; second chunk
  // carried the 2-space-indented continuation. Pre-v0.8.7 the parser
  // terminated single-line at the first `\n` (peek empty → isBlank
  // treated as non-continuation), yielded the truncated row, advanced
  // past the token, and then had no way to pick up the continuation —
  // it hit the stream with no `@worker-N:` prefix and got absorbed
  // as narrative. Drop file carried the comma-cut payload unusable to
  // the worker. Reference: session 2026-04-24, drop
  // `to-worker-2-turn6-seq1.md` = 69 bytes mid-sentence.
  //
  // Fix: when (a) we are on the first iteration (no folding yet), (b)
  // the chosen newline is the LAST byte in the buffer, and (c) the
  // payload is long (>=30 chars) and not sentence-terminated, hold
  // the partial in the buffer and wait for the next feed.
  const p = new WorkerPatternParser();
  // Chunk 1 mimics the field capture: directive, 69-ish bytes, comma
  // at end, newline is buffer's last byte.
  const msgs1 = p.feed(
    '@worker-2: .omc/team/artifacts/reverseString.js 파일을 읽고 두 버전(reverseStringSimple,\n',
  );
  assert.equal(msgs1.length, 0, 'must hold until continuation arrives');

  // Chunk 2 brings the 2-space-indented wrap continuation + final
  // period which terminates the directive.
  const msgs2 = p.feed(
    '  reverseStringUnicode)을 검토해줘.\n',
  );
  assert.equal(msgs2.length, 1);
  assert.equal(msgs2[0].workerId, 'worker-2');
  assert.match(msgs2[0].payload, /reverseStringSimple/);
  assert.match(msgs2[0].payload, /reverseStringUnicode/);
  assert.match(msgs2[0].payload, /검토해줘/);
});

test('router v0.8.7: short directive at end-of-buffer still yields (no hold regression)', () => {
  // Guard: the v0.8.7 hold must NOT fire for short, sentence-complete
  // directives that happen to land a newline at the buffer tail. This
  // is the pattern of the legacy single-directive tests.
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: say ok.\n');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].payload, 'say ok.');
});

test('router v0.11.2: wrap-suspect partial is HELD by flush (not released)', () => {
  // v0.8.7 originally released held partials on flush so the leader-idle
  // edge surfaced any dangling token. Field finding 2026-04-25 (parseCSV
  // 52B truncation) showed that path POISONS the dedupe map: idleDetector
  // briefly mis-reads inter-chunk silence as "leader idle", flush() yields
  // the truncated first chunk, dispatch commits it, and any longer
  // continuation is dedup-dropped under the same first-line key. v0.11.2
  // flips the policy: a wrap-suspect partial (newline buffer-last + no
  // terminal punctuation + ≥30 chars) STAYS HELD across flush. The next
  // feed() either completes the payload or the dispatch wall-clock cap
  // surfaces it via the dispatch path with the latest accumulated bytes.
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-1: implement reverseString with Intl.Segmenter and full test coverage,\n',
  );
  assert.equal(msgs.length, 0, 'hold until further data');
  const flushed = p.flush();
  assert.equal(flushed.length, 0, 'wrap-suspect partial must stay held on flush');
});

test('router v0.11.2: sentence-complete partial without newline is released by flush', () => {
  // The held-partial fallback is preserved for the safe shape: payload ends
  // with terminal punctuation (no Ink wrap risk) AND no trailing newline
  // (so the wrap-suspect "newline buffer-last" guard never fires). flush()
  // surfaces it as before.
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: implement reverseString and run all tests.');
  assert.equal(msgs.length, 0, 'no terminator yet');
  const flushed = p.flush();
  assert.equal(flushed.length, 1);
  assert.match(flushed[0].payload, /run all tests\.$/);
});

test('router v0.11.2: short partial without newline released by flush', () => {
  // Short dangling tokens (no trailing newline) bypass the new wrap-suspect
  // hold because endsWithNewline is false. The legacy "dangling-single-line
  // token surfaces on flush" path is preserved for this safe shape.
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: short task');
  assert.equal(msgs.length, 0, 'no terminator');
  const flushed = p.flush();
  assert.equal(flushed.length, 1);
  assert.match(flushed[0].payload, /short task/);
});

// ─────────────────────────────────────────────────────────────────────
// v0.8.9 — indent-less wrap continuation.
//
// Field evidence (2026-04-23 session, drop `to-worker-2-turn4-seq1.md`,
// 60B): leader emitted
//     @worker-2: .omc/team/artifacts/reverseString.js의 구현을 리뷰해줘. 체크할 포인트: (1)\nIntl.Seg...
// in a SINGLE pty chunk. The `\n` after "(1)" was an Ink visual wrap,
// but the wrapped row `Intl.Seg...` had NO 2-space indent. v0.8.7's
// continuation rule required indent AND end-of-buffer hold only fires
// when `\n` is buffer-last — neither matched, so parser yielded the
// truncated "체크할 포인트: (1)" payload. Worker-2 received unusable
// instructions and had to reconstruct from context.
//
// Fix: when (a) payload-so-far is wrap-suspect (≥30 chars, no terminal
// punctuation), and (b) next line is not a new `@target:` / `@end` /
// blank, fold into the directive even without the 2-space indent. The
// legitimate leader-multi-line-prose case is handled by the terminal-
// punctuation guard (v0.4.2) and the blank-line guard.
//
// Pairs with `normalize()` update: single-line folded `\n` (with any
// or no indent) collapses to a single space.
// ─────────────────────────────────────────────────────────────────────

test('router v0.8.9: indent-less wrap continuation in same chunk folds', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-2: .omc/team/artifacts/reverseString.js의 구현을 리뷰해줘. 체크할 포인트: (1)\nIntl.Segmenter fallback을 확인해줘.\n',
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].workerId, 'worker-2');
  assert.match(msgs[0].payload, /체크할 포인트: \(1\)/);
  assert.match(msgs[0].payload, /Intl\.Segmenter fallback/);
});

test('router v0.8.9: indent-less wrap across two pty chunks folds', () => {
  // Stronger form: the v0.8.7 chunk-split fix required indent on the
  // continuation. This asserts no-indent continuation also works.
  const p = new WorkerPatternParser();
  const msgs1 = p.feed(
    '@worker-2: .omc/team/artifacts/reverseString.js의 구현을 리뷰해줘. 체크할 포인트: (1)\n',
  );
  assert.equal(msgs1.length, 0, 'v0.8.7 end-of-buffer hold must fire');
  const msgs2 = p.feed('Intl.Segmenter fallback을 확인해줘.\n');
  assert.equal(msgs2.length, 1);
  assert.match(msgs2[0].payload, /체크할 포인트: \(1\)/);
  assert.match(msgs2[0].payload, /Intl\.Segmenter fallback/);
});

test('router v0.8.9: short payload without terminal punct does NOT force-fold', () => {
  // Guard against over-holding. "apple" is too short to be mid-wrap —
  // a real wrap only happens when the line is long enough for Ink to
  // break it. Threshold = 30 chars (consistent with v0.8.7).
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: apple\nother text\n');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].payload, 'apple');
});

test('router v0.8.9: terminal punct ends directive even with long no-indent follow', () => {
  // Payload ends with `.` — clearly complete. Follow-up line must NOT
  // be folded regardless of length.
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-1: this is a long enough directive ending with a period.\nseparate narrative that should not be folded in.\n',
  );
  assert.equal(msgs.length, 1);
  assert.equal(
    msgs[0].payload,
    'this is a long enough directive ending with a period.',
  );
});

test('router v0.8.9: next @target directive terminates a long no-punct payload', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-1: long directive without terminal punct but another target follows\n@worker-2: second task.\n',
  );
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].workerId, 'worker-1');
  assert.equal(
    msgs[0].payload,
    'long directive without terminal punct but another target follows',
  );
  assert.equal(msgs[1].workerId, 'worker-2');
  assert.equal(msgs[1].payload, 'second task.');
});

test('router v0.8.9: blank line after long no-punct payload still terminates', () => {
  // Blank line is a stronger signal than absence of terminal punct —
  // it says "paragraph ended here". Do not fold across blank lines.
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-1: long directive without terminal punct that keeps going\n\nfollowing paragraph is separate.\n',
  );
  assert.equal(msgs.length, 1);
  assert.equal(
    msgs[0].payload,
    'long directive without terminal punct that keeps going',
  );
});

// ─── Claude leader projector ───

test('projector: ignores user prompt echo and input-box chrome', () => {
  const projector = new ClaudeLeaderRoutingProjector();
  const projected = projector.feed(
    '> @worker-1: "apple, banana, cherry"를 한글로 번역해서 답해줘.\n' +
    '  @worker-2: 1부터 10까지 합을 계산해서 답만 숫자로 줘.\n' +
    '────────────────────────────────────\n',
  );
  assert.equal(projected, '');
});

test('projector: keeps assistant bullet block and drops trailing chrome/status', () => {
  const projector = new ClaudeLeaderRoutingProjector();
  const projected = projector.feed(
    '● @worker-1: task A\n' +
    '  @worker-2: task B\n' +
    '────────────────────────────────────\n' +
    '[OMC#4.12.0] | ctx:4%\n' +
    '⏵⏵ bypass permissions on (shift+tab to cycle)\n',
  );
  assert.equal(
    projected,
    '● @worker-1: task A\n' +
    '  @worker-2: task B\n',
  );
});

test('projector: keeps start-of-line continuation rows inside assistant block', () => {
  const projector = new ClaudeLeaderRoutingProjector();
  const projected = projector.feed(
    '● @worker-1: task A\n' +
    '@worker-2: task B\n' +
    '@end\n' +
    '────────────────────────────────────\n',
  );
  assert.equal(
    projected,
    '● @worker-1: task A\n' +
    '@worker-2: task B\n' +
    '@end\n',
  );
});

test('projector: buffers partial lines across chunk boundaries (v2.7.14 regression)', () => {
  // Reproduces the v2.7.12 worker-2 drop: ConPTY splits mid-line, chunk-1's
  // tail starts with `@worker-N:` (classifies as assistant-cont), but
  // chunk-2's opening bytes are a Hangul syllable (`지`) which would
  // classify as `other` and close the block. With partial-line buffering,
  // chunk-1's tail is held until chunk-2's newline so the complete line is
  // classified correctly.
  const projector = new ClaudeLeaderRoutingProjector();
  const chunkA =
    '● @worker-1: "red", "blue", "green" 이 세 단어를 각각 한글로\n' +
    '  번역해서 답해줘.\r\n' +
    '  @worker-2: 1부터 20까';
  const chunkB = '지의 짝수만 모두 더한 합계를 알려줘.\n  답해줘.\n\n';

  const outA = projector.feed(chunkA);
  const outB = projector.feed(chunkB);
  const combined = outA + outB;

  assert.ok(
    combined.includes('@worker-2: 1부터 20까지의 짝수만 모두 더한 합계를 알려줘.'),
    `worker-2 continuation lost across chunk boundary. projected=${JSON.stringify(combined)}`,
  );
  assert.ok(combined.includes('@worker-1:'));
});

test('router: single-line directive folds 2-space indented continuation rows (v2.7.15)', () => {
  // Real regression: Claude's Ink TUI wraps a long single-line @worker-N:
  // directive across visual rows by inserting `\n  ` between them. Parser
  // must treat the wrapped rows as a single payload, not terminate at the
  // first `\n`.
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-1: "red, blue, green" 세 단어를 한글로 번역해줘. 각\n' +
    '  단어당 한 줄씩, 영어 단어 옆에 한글 번역만 적어줘.\n' +
    '  @worker-2: 1부터 20까지의 숫자 중 짝수만 모두 더한 합계를\n' +
    '  계산해서 숫자 하나로만 답해줘. 풀이 과정은 생략하고 결과 숫자만.\n',
  );
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].workerId, 'worker-1');
  assert.equal(
    msgs[0].payload,
    '"red, blue, green" 세 단어를 한글로 번역해줘. 각 단어당 한 줄씩, 영어 단어 옆에 한글 번역만 적어줘.',
  );
  assert.equal(msgs[1].workerId, 'worker-2');
  assert.equal(
    msgs[1].payload,
    '1부터 20까지의 숫자 중 짝수만 모두 더한 합계를 계산해서 숫자 하나로만 답해줘. 풀이 과정은 생략하고 결과 숫자만.',
  );
});

test('router: blank line terminates single-line directive even with later indent', () => {
  // A blank line means the assistant ended the directive paragraph; anything
  // after belongs to a new block, not a continuation.
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: first task.\n\n  trailing prose (not part of task).\n');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].payload, 'first task.');
});

test('projector: Ink input-box repaint mid-stream does not close assistant block (v2.7.30)', () => {
  // Real regression from v2.7.29 field testing: leader responded with
  //   ● <narration...>
  //     <narration cont...>
  //     (blank)
  //     @worker-1: 안녕?
  // While the response was streaming, Ink's Ink TUI repainted the bottom
  // input-box echo `> @worker-1: 안녕?                      ` in the same
  // PTY stream. Pre-v2.7.30, that `>` line classified as `prompt` and closed
  // the assistant block, so the legitimate continuation `  @worker-1: 안녕?`
  // that arrived after was stripped and never routed.
  const projector = new ClaudeLeaderRoutingProjector();
  const projected = projector.feed(
    '● Podium 팀 프로토콜 확인했습니다. 네 알겠습니다.\n' +
    '  전달해주시면 받겠습니다.\n' +
    '\n' +
    '> @worker-1: 안녕?                                                    \n' +
    '  @worker-1: 안녕?\n',
  );
  // Both the pre-repaint narration and the post-repaint continuation must
  // survive. Only the `> ...` repaint line should be dropped.
  assert.ok(projected.includes('Podium 팀 프로토콜 확인했습니다.'), `pre-repaint stripped: ${JSON.stringify(projected)}`);
  assert.ok(projected.includes('  @worker-1: 안녕?'), `post-repaint stripped: ${JSON.stringify(projected)}`);
  assert.ok(!projected.includes('> @worker-1'), `prompt echo leaked: ${JSON.stringify(projected)}`);
});

test('projector: status/chrome mid-stream also does not close assistant block (v2.7.30)', () => {
  const projector = new ClaudeLeaderRoutingProjector();
  const projected = projector.feed(
    '● assistant opens\n' +
    '  first cont line\n' +
    '[OMC#4.12.0] | 5h:53% | ctx:0%\n' +
    '────────────────────────────────────\n' +
    '⏵⏵ bypass permissions on (shift+tab to cycle)\n' +
    '  @worker-1: late continuation\n',
  );
  assert.ok(projected.includes('assistant opens'));
  assert.ok(projected.includes('first cont line'));
  assert.ok(projected.includes('@worker-1: late continuation'));
  assert.ok(!projected.includes('[OMC#'));
  assert.ok(!projected.includes('bypass permissions'));
  assert.ok(!projected.includes('────'));
});

test('projector+parser: chunk-boundary split still dispatches both workers', () => {
  // End-to-end pipeline check: projector fix + parser together.
  const projector = new ClaudeLeaderRoutingProjector();
  const parser = new WorkerPatternParser();
  const chunks = [
    '● @worker-1: apple\n  @worker-2: banana',
    ' is the answer.\n',
  ];
  const msgs: RoutedMessage[] = [];
  for (const c of chunks) {
    const projected = projector.feed(c);
    msgs.push(...parser.feed(projected));
  }
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].workerId, 'worker-1');
  assert.equal(msgs[0].payload, 'apple');
  assert.equal(msgs[1].workerId, 'worker-2');
  assert.equal(msgs[1].payload, 'banana is the answer.');
});

test('projector v0.3.6: bare @worker-N: after plain paragraph is emitted', () => {
  // Regression for v0.3.5 field log: leader opened with `●` bullet, wrote a
  // multi-paragraph reply, then emitted a bare `@worker-1:` directive on
  // its own line. Pre-fix, the plain-paragraph line ("먼저 worker-1에게…")
  // classified as 'other' and kicked the projector out of its assistant
  // block; the subsequent directive was dropped and never reached the
  // parser. v0.3.6 classifies bare `@target:` lines as assistant-start so
  // they re-enter the block.
  const proj = new ClaudeLeaderRoutingProjector();
  const input =
    '● 좋습니다. 이 볼트 환경과 관련된 작업입니다.\n' +
    '  파일명 파서가 필요합니다.\n' +
    '\n' +
    '먼저 worker-1에게 초안을 맡기겠습니다.\n' +
    '\n' +
    '@worker-1: TypeScript 함수 초안을 작성해줘.\n';
  const projected = proj.feed(input);
  const parser = new WorkerPatternParser();
  const msgs = parser.feed(projected);
  assert.equal(msgs.length, 1, `expected 1 routed msg, got ${msgs.length}; projected=${JSON.stringify(projected)}`);
  assert.equal(msgs[0].workerId, 'worker-1');
  assert.ok(msgs[0].payload.startsWith('TypeScript 함수'));
});

test('projector v0.3.6: bare @leader: line from worker re-enters assistant block', () => {
  // Symmetric case on the worker side. Worker's reply contains a plain
  // paragraph followed by a `@leader:` reply directive — must not be
  // suppressed.
  const proj = new ClaudeLeaderRoutingProjector();
  const input =
    '● 구현 완료했습니다. 함수 2개 작성함.\n' +
    '\n' +
    '결과를 리더에게 전달하겠습니다.\n' +
    '\n' +
    '@leader: 구현 완료, 함수 2개.\n';
  const projected = proj.feed(input);
  const parser = new WorkerPatternParser();
  const msgs = parser.feed(projected);
  assert.equal(msgs.length, 1, `expected 1 routed msg, got ${msgs.length}; projected=${JSON.stringify(projected)}`);
  assert.equal(msgs[0].workerId, 'leader');
  assert.ok(msgs[0].payload.startsWith('구현 완료'));
});

test('projector v0.7.2: indented @worker-N: directive re-enters closed assistant block', () => {
  // Field regression from v0.7.1: leader emits a delegation whose "@worker-2:"
  // line is INDENTED (Ink wraps it under a preceding bullet, but a 'other'
  // diagnostic narration line has meanwhile closed the assistant block).
  // Pre-v0.7.2 the indented "@worker-2:" matched only CLAUDE_ASSISTANT_CONT_RE,
  // which drops when the block is closed — so the whole delegation was
  // suppressed and worker-2 was never routed to. v0.7.2 relaxes the bare-
  // directive classifier to allow leading whitespace, so any "@target:"
  // line anywhere in the stream re-opens the block and reaches the parser.
  const proj = new ClaudeLeaderRoutingProjector();
  const input =
    '● 중간에 진단 문장을 넣었다.\n' +
    '이건 other 라인이라 assistant 블록을 닫는다.\n' + // 'other' → closes block
    '    @worker-2: worker-1의 reverseString 초안을 리뷰해줘.\n';
  const projected = proj.feed(input);
  const parser = new WorkerPatternParser();
  const msgs = parser.feed(projected);
  assert.equal(msgs.length, 1, 'indented @worker-2: directive must route');
  assert.equal(msgs[0].workerId, 'worker-2');
  assert.match(msgs[0].payload, /리뷰해줘/);
});

test('projector v0.7.2: prompt echo still dropped after bare-directive relaxation', () => {
  // Negative control: prompt echo lines carry a `>` prefix, not a
  // whitespace-plus-@ prefix, so the relaxed regex does not match them.
  // Falls through to CLAUDE_PROMPT_RE which drops as before.
  const proj = new ClaudeLeaderRoutingProjector();
  const input =
    '>   @worker-1: I typed this as input, echo only.\n' +
    '────────────\n';
  const projected = proj.feed(input);
  const parser = new WorkerPatternParser();
  const msgs = parser.feed(projected);
  assert.equal(msgs.length, 0, 'indented prompt echo must not route');
});

test('projector v0.3.6: prompt echo with bare @worker- still dropped', () => {
  // Prompt echo ALWAYS carries a `>` prefix, so bare @worker-N at column 0
  // can never be a pasted echo. The new bare-directive classifier must not
  // accidentally admit prompt echoes.
  const proj = new ClaudeLeaderRoutingProjector();
  const input =
    '> @worker-1: I typed this as input, echo only.\n' +
    '────────────\n';
  const projected = proj.feed(input);
  const parser = new WorkerPatternParser();
  const msgs = parser.feed(projected);
  assert.equal(msgs.length, 0, 'prompt echo must not route');
});

// ─── v0.4.0 · protocol-template noise guard ───

test('router v0.4.0: placeholder-only payload `... /` is dropped', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: ... /\n');
  assert.equal(msgs.length, 0, 'ellipsis-slash placeholder must not route');
});

test('router v0.4.0: pure ellipsis payload is dropped', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: ...\n');
  assert.equal(msgs.length, 0, 'pure ellipsis must not route');
});

test('router v0.4.0: protocol meta keywords drop the directive', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-2: ... (컬럼 0에서 시작) - 라운드 예산: 작업당 10회 - Effort: max\n',
  );
  assert.equal(msgs.length, 0, 'protocol meta payload must not route');
});

test('router v0.4.0: system-prompt template row `<task for worker-1>` is dropped', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: <task for worker-1>\n');
  assert.equal(msgs.length, 0, 'template placeholder must not route');
});

test('router v0.4.0: real task mentioning ellipsis still routes', () => {
  // Negative control: payloads with real content that happens to CONTAIN
  // ellipsis must still go through — only payloads that are ENTIRELY
  // placeholder text should be suppressed.
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: 피보나치 수열을 1, 1, 2, 3, 5, ... 로 출력해줘.\n');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].workerId, 'worker-1');
  assert.match(msgs[0].payload, /피보나치/);
});

test('router v0.4.0: multi-directive chunk drops template, keeps real task', () => {
  // Reproduces the v0.3.9 field log where a single projected chunk yielded
  // both a template row and a real task row. Only the real task survives.
  const p = new WorkerPatternParser();
  const chunk =
    '@worker-1: ... /\n' +
    '@worker-2: ... (컬럼 0에서 시작) - 라운드 예산: 작업당 10회 - Effort: max\n' +
    '@worker-1: "apple"이라고만 말해줘. 다른 말은 붙이지 말고.\n' +
    '@worker-2: "banana"라고만 말해줘. 다른 말은 붙이지 말고.\n';
  const msgs = p.feed(chunk);
  assert.equal(msgs.length, 2, 'only the two real task directives survive');
  assert.equal(msgs[0].workerId, 'worker-1');
  assert.match(msgs[0].payload, /apple/);
  assert.equal(msgs[1].workerId, 'worker-2');
  assert.match(msgs[1].payload, /banana/);
});

// ─── v0.4.2 · strategy C — terminal-punctuation guard ───

test('router v0.4.2: period-terminated directive does not fold Ink follow-up narration', () => {
  // Field reproduction: leader emitted
  //   @worker-2: "banana"라고만 답하세요. 다른 말은 일절 하지 마세요.
  //     두 워커의 응답을 기다리겠습니다.
  // Pre-v0.4.2, the 2-space indented next line was folded into worker-2's
  // payload, so the dedupe key mutated between the original emission and
  // the Ink-repaint replay (which dropped the narration tail). v0.4.2
  // refuses to fold across sentence-terminal punctuation.
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-2: "banana"라고만 답하세요. 다른 말은 일절 하지 마세요.\n' +
    '  두 워커의 응답을 기다리겠습니다.\n',
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].workerId, 'worker-2');
  assert.equal(
    msgs[0].payload,
    '"banana"라고만 답하세요. 다른 말은 일절 하지 마세요.',
    'narration tail must NOT be folded into the directive payload',
  );
});

test('router v0.4.2: question/exclamation terminators also block folding', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-1: 왜 이 코드가 느릴까요?\n' +
    '  다음 지시를 기다립니다.\n' +
    '@worker-2: 속도를 개선하세요!\n' +
    '  그리고 벤치마크를 포함해주세요.\n',
  );
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].payload, '왜 이 코드가 느릴까요?');
  assert.equal(msgs[1].payload, '속도를 개선하세요!');
});

test('router v0.4.2: CJK full-width terminators (。！？) also block folding', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-1: 설명해주세요。\n' +
    '  추가 문장.\n',
  );
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].payload, '설명해주세요。');
});

test('router v0.4.2: non-terminated first line still folds continuation (v2.7.15 compat)', () => {
  // Negative control: the pre-existing v2.7.15 behavior (folding legitimate
  // Ink-wrapped continuation rows of a single logical sentence) must be
  // preserved when the first visual row does NOT end in terminal punctuation.
  const p = new WorkerPatternParser();
  const msgs = p.feed(
    '@worker-1: "red, blue, green" 세 단어를 한글로 번역해줘. 각\n' +
    '  단어당 한 줄씩 적어줘\n',
  );
  assert.equal(msgs.length, 1);
  assert.equal(
    msgs[0].payload,
    '"red, blue, green" 세 단어를 한글로 번역해줘. 각 단어당 한 줄씩 적어줘',
  );
});

// ─── v0.5.0 · bullet-only payload drop ───

test('router v0.5.0 (P3): `●` bullet-only payload is dropped', () => {
  // Field log showed `worker-1 yielded 1 directive(s): leader=●` — the
  // assistant bullet character slipped through as payload when Ink's
  // alt-screen emitted an isolated `● ` row right after `@leader:` on
  // the previous line. The bullet carries no content and should not
  // route back to the leader.
  const p = new WorkerPatternParser();
  const msgs = p.feed('@leader: ●\n');
  assert.equal(msgs.length, 0, '`●` alone must not route');
});

test('router v0.5.0 (P3): `• ` bullet variant is also dropped', () => {
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: •\n');
  assert.equal(msgs.length, 0);
});

test('router v0.5.0 (P3): bullet prefix with real content still routes (negative control)', () => {
  // The bullet-strip at the front of `normalize()` should still allow a
  // real payload that was typographically prefixed with a bullet to route.
  const p = new WorkerPatternParser();
  const msgs = p.feed('@worker-1: ● real task body\n');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].payload, 'real task body');
});
