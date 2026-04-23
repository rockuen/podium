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
