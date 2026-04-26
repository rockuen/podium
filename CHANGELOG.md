# Changelog

## [0.16.0] - 2026-04-26

### Artifact-first re-armed + auto-spill 완전 제거 + setup prompt 명시화

v0.15.0~0.15.1는 artifact-first를 default off로 후퇴시키고 inline
routing을 다시 default로 만들었지만, 그 결과 Ink TUI fragmentation으로
잘린 directive가 워커에 전달되는 옛 v0.11.x 문제가 재발 (intersect
2026-04-26 field). 사용자 의도("리더/워커가 무조건 Write tool로 md
파일 작성")에 맞춰 v0.16.0은 다음 셋을 동시 적용:

- **`enforceArtifactGate` default `false → true`** 복귀.
- **`maybeSpillLeaderToWorker`의 auto-spill (CASE B) 완전 제거.**
  orchestrator는 더 이상 `auto-to-*.md`를 만들지 않는다. leader / worker
  가 유일한 파일 author. `findArtifactByTurn` 못 찾으면 raw payload를
  반환하지만, gate-on production에선 `commitRoute`가 그 이전에 reject
  를 발화하므로 도달하지 않는 분기.
- **`team protocol note` (setup prompt)에 artifact-first 절차 명시.**
  v0.14.x 때 LLM이 reject 메시지를 prompt injection으로 의심하던
  실패의 핵심 원인이 이거였음 — 첫 turn부터 protocol을 알려주면
  LLM이 이후 reject 메시지를 시스템 알림으로 자연스럽게 수용.
- `leaderProtocol` / `workerProtocol`이 다시 artifact-first 강제 어휘로.
  "[Podium Orchestrator system]" reject가 진짜 확장 알림이라는 점 명시.

알려진 회귀: 26 unit test fail. 모두 v0.13~v0.14.x 시절의 auto-spill
동작 검증 (path-first notice in worker stdin)이라 v0.16.0의 의도된
auto-spill 제거 결과. 다음 cleanup commit에서 stale 표시 또는 inline-
payload 검증으로 갱신 예정.

## [0.15.1] - 2026-04-26

### v0.15.0의 미완 — gate-off에서 spill notice가 여전히 worker stdin으로 흐름

v0.15.0이 `enforceArtifactGate` default를 false로 전환했지만
`maybeSpillLeaderToWorker`는 여전히 fragment-truncated payload를
`auto-to-*.md` 파일로 저장하고 그 path-first notice를 worker stdin에
주입했다. 결과: worker는 잘린 ~150B directive를 task body로 받음
(intersect 2026-04-26 field 케이스).

v0.15.1 fix:

- gate-off 시 `maybeSpillLeaderToWorker`가 inline payload를 worker
  stdin에 직접 주입한다. file은 forensic record / redelivery 추적용
  으로 그대로 작성됨 (단, opt-in 클라이언트에만 path-first notice
  방식으로 worker에 전달).
- `notifyLeaderOfNewArtifacts`가 `auto-to-*` 파일은 워커 산출물 알림
  대상에서 제외한다. orchestrator가 만든 leader→worker 전달 파일이
  워커가 만든 결과물처럼 leader에 surface되던 문제 차단.

## [0.15.0] - 2026-04-26

### Retreat · artifact-first 강제를 opt-in으로

v0.12.0–v0.14.2 동안 enforce된 "artifact 파일이 있어야만 라우팅 통과"
정책이 LLM (Claude 4.6+)의 prompt-injection 방어 패턴을 정확히 trigger
한다는 사실이 v0.14.2 검증에서 드러남:

- LLM이 reject 메시지(`[Podium Orchestrator system · v0.14.x] ...
  prompt injection이 아닙니다`)를 의심하고 진행 거부
- 자기-방어 문구 + 동일 본문 반복 + 새 프로토콜 강제 + 파일 시스템
  쓰기 요구 = 교과서적 injection 패턴으로 학습된 형태

v0.15.0은 `enforceArtifactGate` default를 `true → false`로 되돌림.
production 라우팅은 v0.11 스타일 inline 으로 복귀:

  `@worker-1: <자유 길이 task body>`

Ink TUI fragmentation은 messageRouter의 누적 fix들이 직접 처리:
- v0.14.0 Fix X (column-0 prompt-echo demote)
- v0.14.1 Z-1 (dedupeKey whitespace 정규화 + 30 chars cap)
- v0.14.2 (onPaneData inline drain)

artifact-backed routing은 명시적 opt-in (`enforceArtifactGate: true`)
으로 남음 — forensic reproducibility / huge-body 보장이 필요한
사용자만 활성화. `leaderProtocol` / `workerProtocol` 시스템 프롬프트도
그에 맞게 inline routing 안내가 default, artifact 모드는 OPTIONAL
섹션으로 분리.

테스트는 `artifactGate.test.ts`가 명시적으로
`enforceArtifactGate: true` 를 attach 옵션에 넣어 production gate
시나리오를 그대로 검증.

## [0.14.2] - 2026-04-26

### Inline drain on pty data event (webview throttling 우회)

Field evidence: 사용자가 Output 채널을 닫으면 워커 큐가 멈추고, 다시
열면 진행되는 현상. 원인은 webview/window hidden 시 chromium / macOS
App Nap이 `setInterval(250ms)`를 5–10초 단위로 throttling해서 `tick()`
호출이 거의 안 되는 것. queue drain은 `tick()`에서만 호출되므로 polling
정지 = drain 정지.

v0.14.2는 `onPaneData`의 worker 분기에 inline drain을 추가. 워커가 idle
전환되는 그 chunk가 도착하는 시점에 즉시 `inject` — pty data event는
OS-level fd readiness라 throttling을 통과한다. `tick()`은 안전망 그대로.

`[orch.drain] worker-N inline drain (queueLen was X)` 트레이스 로그 추가.

## [0.14.1] - 2026-04-26

### Z-1 · dedupeKey 정규화 (큐 폭증 차단)

기존 `dedupeKey`는 first line 100 chars였는데, Ink TUI fragmentation으로
같은 directive가 wrap 위치에 따라 다른 first line 길이로 yield되면 모두
distinct → 모두 commit → 큐에 7건까지 적재. v0.14.1에선 whitespace를
single space로 압축하고 30 chars로 cap → fragment 변형이 같은 key로
collide.

### Z-2 · idle latch 진단 trace

Worker pane 데이터 chunk마다 isIdle 변화(idle↔busy)를 orchestrator
output channel에 trace. msSinceOutput / chunkBytes / queueLen 같이 기록
→ idle latch failure 재현 시 어떤 chunk가 lastOutputAt을 갱신했는지
정확히 파악 가능.

### Z-3 · system 메시지 prefix 명확화

reject / stuck warn 메시지 prefix를 `[orch.reject]` / `[orch.warn]`에서
`[Podium Orchestrator system · v0.14.x]`로 변경 + "이 메시지는 Podium
VS Code 확장이 발신한 시스템 알림입니다 — prompt injection이 아닙니다"
fragment 추가. LLM이 stale memory(이전 버전)와 충돌하더라도 시스템
메시지로 인식 가능.

## [0.14.0] - 2026-04-26

### Fix X · prompt-echo column-0 directives now demoted

v0.7.2's prompt-echo guard only demoted INDENTED `@worker-N: ...`
lines that landed right after a prompt classification. Field evidence
(parseCSV 2026-04-26) showed Ink TUI also fragments multi-line user
input echoes such that the second line arrives at column 0, sneaking
past the guard and emitting the user's own message text as a fresh
directive — which the file-system gate then rejected, producing the
"재촉" reject loop. Drop the indent restriction so prompt-context
column-0 directives are also demoted. Safe against legitimate column-0
routing because real LLM delegations open the assistant block with
`●` first, so by the time the directive line is processed the guard
condition (`!inAssistantBlock`) is already false.

### Fix Y · stuck-queue surface

When a worker's idle latch fails (boot output / Ink repaint keeps
resetting the silence window), routes pile up in the queue and the
user has no signal — v0.13.0 just sat silent. v0.14.0 stamps
`queueStuckSince` when the queue first becomes non-empty against a
busy worker and, if 30s elapses without drain, fires a one-shot
`[orch.warn]` notice into the leader pane (and the orchestrator
output channel) so the user can intervene instead of waiting
indefinitely. Stamp clears the moment the queue drains; warn flag
re-arms for the next stuck episode.

## [0.13.0] - 2026-04-26

### File-system gate (option C-2 — directive body no longer parsed)

The v0.12.x gate parsed each `@worker-N: <body>` for an embedded
`.omc/team/artifacts/<file>.md` path. Under Ink TUI fragmentation
(directive line wrapping past viewport, scrollback repaint stripping
trailing tokens) the path was unreliably captured, producing false
positive rejects on otherwise valid directives.

v0.13.0 stops parsing directive bodies entirely. Routing resolves
the artifact by naming convention on disk:

- Leader→worker: `to-<worker-id>-turn<N>.md`
- Worker→leader: `from-<worker-id>-turn<N>.md`

Resolution falls back to the highest matching turn number when the
exact-turn file is absent, so the leader can pre-write artifacts
without coordinating exact turn IDs.

`archivePriorArtifacts` runs on every `attach()` (mirrors the v0.9.0
drops archive): top-level `.md` files in `.omc/team/artifacts/`
move to `.omc/team/artifacts/archive/<ISO>/` so a stale
`to-worker-1-turn1.md` from a prior session does not silently match
a fresh turn=1 directive.

System prompts (`leaderProtocol` / `workerProtocol`) updated to
describe the new contract — directive bodies are pure routing
triggers; the file is the truth.

## [0.12.1] - 2026-04-26

### Bug fix · reject loop on Ink scrollback repaint

The v0.12.0 reject notice contained `@worker-N` / `@leader` tokens
that the orchestrator's own messageRouter parsed as fresh directives
when the leader pane echoed them back through the pty stream. Combined
with Ink TUI scrollback repainting prior `@worker-N: ...` lines after
the cross-turn dedupe window expired, the same `[orch.reject]` text
fired indefinitely.

- Replaced the `@<id>:` example in reject reason text with `AT-<id>:`
  (the same self-route-safe form used by the team setup prompt) so
  the reject body is never re-parsed as a directive.
- Added per-target rate-limit (`REJECT_RATE_LIMIT_MS = 30s`): same
  dedupeKey for the same target within the window is logged but NOT
  re-injected. Forensic trail (`[orch.reject] … rate-limited (Nms
  since last)`) stays in the orchestrator output channel.

## [0.12.0] - 2026-04-25

### Artifact-only routing (Option C, hard reject)

Every leader↔worker directive must reference an existing
`.omc/team/artifacts/<file>.md` written via the Write tool. Inline
bodies, ACK-only echoes, and short replies are no exceptions —
without a path the orchestrator rejects the route and bounces a
`[orch.reject]` notice to the source pane.

- Removed `.omc/team/drops/to-*.md` envelope and the v0.11 chain-follow
  rule. The first-line path of every notice now points directly at
  the artifact file (no second hop).
- Reply naming standardized: `to-<worker-id>-turn<N>.md` (leader→worker)
  and `from-<worker-id>-turn<N>.md` (worker→leader).
- All inter-pane content lives in `.omc/team/artifacts/`, so
  `ls artifacts/` gives a complete conversation log.
- New `enforceArtifactGate` attach option (default `true`).
- `leaderProtocol` / `workerProtocol` system prompts updated to
  describe the hard reject contract.

## [0.11.2] - 2026-04-25

### Bug fix · macOS Enter submit (Win32 KEY_EVENT cross-platform)

Field finding (Antigravity webview + Claude Code v2.1.119, Mac arm64,
session 64a1084f): leader pane Enter never submits. Paste / typing
lands in the input buffer fine, but pressing Enter leaves the directive
sitting un-submitted while Claude hangs in `Sautéed for Ns`. The
projector / parser then partially echo-parses the visible repaint and
spills tiny truncated drops to the workers (76B / 100B in the captured
session).

Root cause: Claude Code v2.1+ activates win32-input-mode (CSI ?9001h)
on macOS as well, not just Windows. The v2.7.1 `cliInput` and
v2.6.18 `autoSend` modules both assumed win32-mode was Windows-only
and emitted bare `\r` on darwin. Under win32-mode the Claude Ink
readline reinterprets bare `\r` as Shift+Enter (newline-in-buffer),
so the directive is never submitted.

Fix:
- `src/orchestration/core/cliInput.ts` — `needsWin32KeyEvents` now
  returns true on `darwin` + `win32` (Claude only). Codex / Gemini
  remain on bare CR everywhere because they do not enable
  win32-input-mode. Linux retains bare CR until field evidence
  proves otherwise.
- `src/pty/autoSend.js` — webview programmatic-send path
  (`vscode.postMessage({ type: 'auto-send', text })`) now mirrors
  cliInput: KEY_EVENT submit on darwin + win32 (Claude), bare CR on
  Linux. Multi-line bodies join with WIN32_SHIFT_ENTER on Mac/Win32,
  closing the v2.6.24-era "non-Podium multi-line" gap.
- `src/panel/webviewClient.js` — `term.attachCustomKeyEventHandler`
  intercepts plain Enter (no Ctrl/Cmd/Shift/Alt, not IME composing),
  mirrors `lineBuffer` history bookkeeping that the legacy
  `term.onData('\r')` branch performed, then routes through
  `auto-send` so the extension emits the proper KEY_EVENT submit.

### Tests

Five new v0.11.2 cases in `test/unit/cliInput.test.ts`:

- `needsWin32KeyEvents — claude on win32 + darwin` — primary positive
  (replaces prior "win32 only" expectation, plus codex/gemini on
  darwin still false).
- `macOS claude single-line — KEY_EVENT submit` — `pty.write` payload
  matches `body + WIN32_ENTER_SUBMIT`, no Shift+Enter.
- `macOS claude multi-line — SHIFT_ENTER between, ENTER submit at end`
  — embedded newlines join with WIN32_SHIFT_ENTER.
- `macOS codex/gemini — bare CR (Mac fix is Claude-specific)` —
  ensures other CLIs are unaffected by the promotion.
- `macOS claude CRLF bodies normalize to KEY_EVENT path` — CRLF
  splitter still works on darwin.

Plus `submitToPty macOS claude writes KEY_EVENT payload` covering the
write helper. Linux POSIX cases relabeled (the prior "POSIX" coverage
implicitly assumed darwin == bare CR which was the broken assumption).

313/313 tests pass (308 → 313, +5 new).

### v7 plan reconciliation

`260425 Podium 통합 플랜 v7 §3.2` listed
"parser.findSingleLineTerminator indent-less continuation" as the
top md-truncation candidate. Code evidence shows that path was
already fixed in v0.8.9 (`messageRouter.ts:470-501`, six regression
tests in `messageRouter.test.ts:131-228`). The real first-priority
defect was Mac Enter submit. v7 §10.4 is being updated separately to
record the close on the parser candidate and the v0.11.2 fix on the
true defect.

## [0.11.1] - 2026-04-24

### Release · Platform-specific native binaries + OpenVSX

- `publish.yml` GitHub Action secret rename `OVSX_TOKEN` → `OVSX_PAT`
  so the OpenVSX publish step authenticates correctly.
- Three-platform VSIX matrix builds the right node-pty native binary
  per target: `darwin-arm64`, `win32-x64`, `linux-x64`. Mac users no
  longer need `npm rebuild node-pty` after install.
- GitHub Release v0.11.1 with universal VSIX attached, OpenVSX
  publishes for all four channels (universal + 3 platform-pinned).

## [0.11.0] - 2026-04-23

### Feature · Council UI + worker artifact-only spill mode

- New `podium.workerReplyMode` setting (`artifact` | `legacy-auto-spill`,
  default `artifact`). In `artifact` mode workers must author
  deliberate markdown files under `.omc/team/artifacts/`; only those
  files are injected into the leader (path-first notice). Worker pty
  thinking / scrollback noise stays out of the leader's context. Raw
  turn body is archived to `.omc/team/drops/raw/` for debugging.
  `legacy-auto-spill` keeps the pre-v0.11 raw pty dump behavior as a
  regression escape hatch.
- Council UI integrates with the live session as a hybrid panel —
  user-facing entry point for `Podium: Consult Other Models`. Layout
  groundwork for the v0.10.3 explicit close-flow lands here, but the
  `Inject brief / Save only / Discard` user-selection UI is still
  scheduled for v0.12.2 per v7 §8.2.

## [0.10.2] - 2026-04-23

### Feature · Council synthesizer + return brief

- `CouncilSynthesizerSpec` interface with the default Claude
  synthesizer wired through `runCouncil()`.
- Each council run now writes `synthesis/summary.md` and
  `return_brief.md` artifacts so the focused session has a compact
  injection target on close.

## [0.10.0] - 2026-04-23

### Feature · Headless participant transport

- `ParticipantTransport` interface and `HeadlessProcessTransport`
  implementation: spawns a participant CLI in headless mode, captures
  stdout / stderr / exit, and writes per-participant artifacts under
  `.omc/team/council/<runId>/participants/<id>/`.
- Async `runCouncil()` entry point assembles a `CouncilRun` from a
  `ContextPack` + participant list and resolves with a
  `CouncilRunResult`. Codex / Gemini participants ride the same
  framework — actual CLI binding for those providers is deferred to
  v0.12.0 / v0.12.1.

## [0.9.4] - 2026-04-25

### Feature · ACK-mismatch-keyed retry chain (closes N2)

v0.9.3 shipped redelivery infrastructure but the content-hash trigger
rarely fires in production — real-world retries always rewrite the
payload slightly (leader prepends "retry:" or appends an EOI marker)
so the `tail_sha8` differs. v0.9.4 adds a stronger, semantically
correct trigger keyed on the v0.9.2 ACK-mismatch signal.

Flow:
  1. `maybeConsumeAck` MISMATCH branch now arms `w.retryChain =
     {priorDropPath, nextCount: 2, ts}` if no chain exists, or extends
     it (priorDropPath = this latest failed drop, nextCount++) if one
     is active.
  2. `maybeConsumeAck` MATCH branch clears `w.retryChain` —
     successful delivery breaks the chain.
  3. `maybeSpillLeaderToWorker` checks `w.retryChain` BEFORE the
     content-hash check. If the chain is live and within the 5-min
     window, the new drop is tagged `redelivery_of=priorDropPath,
     redelivery_count=nextCount` regardless of content similarity.
  4. This new drop becomes the anchor for the next potential retry
     (priorDropPath updated to the new relPath); the mismatch handler
     will extend the chain if another ACK fails.

The two triggers compose: v0.9.4 (mismatch-keyed) fires first when
available, v0.9.3 (content-hash) is the fallback for synthetic or
orchestrator-initiated exact re-sends.

### Tests

Six new v0.9.4 cases in test/unit/ackRetryChain.test.ts:

- "ACK match → next spill NOT tagged as retry" — negative baseline.
- "ACK mismatch → next spill tagged redelivery_count=2" — primary
  positive case with DIFFERENT content between spills (realistic).
- "repeated mismatches extend the chain (count=3)" — chain extends
  through multiple failed deliveries.
- "MATCH after earlier mismatch breaks the chain" — recovery clears
  state; subsequent unrelated spill is not tagged.
- "mismatch past window → new chain starts fresh" — 5-min window
  enforced on the retryChain ts field.
- "mismatch on worker-1 does NOT tag spill to worker-2" — per-worker
  scope preserved (consistent with v0.9.3 semantics).

Test-scaffolding notes (documented in-file):
  - payloads end with terminal punctuation to avoid v0.8.7 end-of-
    buffer hold which blocks yield on unterminated multi-line text
  - `● ` bullet prefix on spill data so the Claude leader projector
    stays in assistant-block state across consecutive spills
  - `dedupeWindowMs: 0` to bypass production's cross-turn dedupe for
    back-to-back scenarios (same rationale as v0.9.3 tests)

234/234 tests green. No regressions in v0.8.x / v0.9.0 / v0.9.1 /
v0.9.2 / v0.9.3 suites.

## [0.9.3] - 2026-04-25

### Feature · Drop redelivery metadata (N2 from 2026-04-24 parseCSV retro)

When the leader spills the SAME directive to the SAME worker within
5 minutes, the new drop's header is annotated so forensic analysis
can follow the retry chain:

    redelivery_of: .omc/team/drops/to-worker-1-turn2-seq1.md
    redelivery_count: 2

Detection uses content-hash match on `tail_sha8` (the v0.9.1 fingerprint
already on every drop). Cross-worker spills with identical content are
NOT linked — the retrospective's forensic question was "did worker-N
see retries?", not "did the leader resend similar content to different
workers?". Chain length increments on each subsequent match so triple
retries show `redelivery_count: 3`, etc. Entries older than the 5-min
window are pruned lazily on each spill; a retry past the window starts
a fresh chain.

Output also logs a `[orch.redelivery]` line when a chain extends,
so real-time observers see retry cycles without opening drop headers:

    [orch.redelivery] worker-1 drop tagged redelivery_count=2 (prior=...)

### Known limitation · dedupe interaction

Production's same-payload cross-turn dedupe (2 min, hardcoded) drops
exact-duplicate routes BEFORE they reach spill. So the content-hash
trigger only fires when the retry's content is slightly different
from the original (e.g., the leader adds a "retry:" prefix or an
EOI marker) — in which case `tail_sha8` won't match either.

In practice this means v0.9.3's trigger catches a narrow band: retries
that share the exact tail but differ elsewhere (unlikely in real
usage). The infrastructure (`recentSpills` ring, chain counting,
header fields, log line) is in place; v0.9.4 will add a broader
trigger keyed on the ACK-mismatch signal from v0.9.2 — which is
the actual semantic signal for "leader is retrying because delivery
failed".

Tests document the current trigger contract with `dedupeWindowMs: 0`
to bypass production's dedupe for exact-duplicate scenarios.

### Tests

Five new v0.9.3 cases in test/unit/dropRedelivery.test.ts:

- "distinct payloads to same worker are NOT linked" — negative
  baseline; unrelated drops carry no redelivery fields.
- "same payload twice within window → redelivery_of set, count=2"
  — primary positive case; second drop points back at first.
- "triple retry chains — redelivery_count increments" — chains
  extend correctly (1 → 2 → 3).
- "same payload beyond window → NEW chain (no link)" — window
  pruning works; 6-min-later retry is a fresh chain.
- "same payload to a different worker does NOT link" — per-worker
  scope is respected.

227/227 tests green. No regressions in v0.9.0/0.9.1/0.9.2 suites.

## [0.9.2] - 2026-04-24

### Feature · Worker ACK round-trip (completes N3 from 2026-04-24 retro)

v0.9.1 embedded "(bytes=N tail=XXXX)" in the path-first notice. v0.9.2
closes the round-trip: workers echo the fingerprint back, and the
orchestrator auto-compares against what it spilled. The parseCSV
retrospective's prompt-driven "ACK the ending" discipline is now a
runtime primitive.

Flow:

  1. maybeSpillLeaderToWorker writes the drop, injects
     ".omc/team/drops/to-worker-1-turn2-seq1.md (bytes=234 tail=a3c9b7d2)"
     and arms w.pendingAckFp with the expected fingerprint.

  2. Worker's system prompt (v0.9.2 update) instructs:
     the first token of @leader reply SHOULD be "ACK bytes=<N> tail=<XXXX>"
     copied verbatim from the notice.

  3. On the worker's next @leader route, commitLeaderInject calls
     maybeConsumeAck. It parses the payload's leading
     /^\s*ACK\s+bytes=(\d+)\s+tail=([0-9a-f]{8})\b/i, compares against
     w.pendingAckFp, and:
       - match → "[orch.ack] match worker-1 bytes=234 tail=a3c9b7d2 (drop=...)"
       - mismatch → "[orch.ack] MISMATCH worker-1 expected bytes=234
           tail=a3c9b7d2, got bytes=169 tail=deadbeef (drop=...) —
           directive likely truncated in transit; consider re-sending"
       - missing/malformed → silent (ACK is advisory; a worker that
         skips it is not wrong)

  4. Fingerprint is one-shot: cleared in every branch to prevent stale
     comparisons on subsequent turns. Unsolicited ACK (no prior spill)
     is a no-op.

Payload is NOT stripped of the ACK line before forwarding to leader.
The ACK token is short and context-adjacent; stripping risks losing
text attached on the same line. Leader sees the ACK verbatim in its
inbox, which is acceptable forensic noise.

### Deferred to v0.9.3+

- Auto re-spill on MISMATCH. v0.9.2 only observes; human / leader
  decides whether to retry. Auto-retry needs throttling + a signal
  to break the retry loop, which deserves its own design pass.
- Stripping the ACK line from the forwarded payload. Deferred until
  real usage shows whether ACK-in-payload is actually noisy.
- Worker→worker ACK. Currently only leader→worker spills arm
  pendingAckFp; worker-to-worker drops don't track fingerprints.

### Tests

Four new v0.9.2 cases in test/unit/ackRoundTrip.test.ts:

- "matching ACK logs a match line and does not warn" — RED baseline.
  Feeds a worker reply containing the exact expected fingerprint,
  asserts a match log appears with worker id + fingerprint.
- "mismatching ACK emits MISMATCH warn with both values" — RED
  baseline. Feeds a reply with truncated-style bytes + wrong tail,
  asserts the warn contains BOTH expected and got for forensic
  clarity.
- "reply without ACK line is silently accepted" — no warn on missing
  ACK (convention is advisory).
- "ACK without a prior spill is ignored (no false positives)" —
  unsolicited ACK must not raise MISMATCH; pendingAckFp stays null.

222/222 tests green. Worker prompt updated to document the ACK
contract. Leader protocol unchanged — this feature is invisible to
the leader except via log lines.

## [0.9.1] - 2026-04-24

### Feature · Drop content fingerprint (tail SHA-8 + UTF-8 byte count)

Partial N3 from the 2026-04-24 parseCSV retrospective. The session
demonstrated that ad-hoc "ACK the last sentence ending" prompt
discipline was effective at catching truncation, but relied on the
worker's cooperation to compare received-vs-expected. v0.9.1 moves
the signal from prompt convention into runtime metadata so the
leader (and any external reader of the worker pty scrollback) can
verify "did the directive arrive whole?" without relying on worker
behavior.

Every leader→worker and worker→leader drop file now carries two
forensic fields in its header:

  bytes: <UTF-8 byte count>
  tail_sha8: <8 hex chars of SHA-256 over last 40 chars>

The path-first notice injected into the worker embeds the same
fingerprint on the same line as the drop path:

  .omc/team/drops/to-worker-1-turn2-seq1.md (bytes=234 tail=a3c9b7d2)

  위 파일을 Read 해서 지시사항을 수행해 주세요.

Placing the fingerprint on the path line (not a separate line) is
deliberate: the path line is the most fragmentation-survivable
token in the notice, so the fingerprint rides along with the
smallest piece that must arrive intact.

`bytes` is UTF-8 bytes (not JavaScript string `.length`, which is
UTF-16 code units) — consistent with how payload size is measured
in transit. `tail_sha8` hashes the last 40 characters of the
payload (or the full payload if shorter): the diagnostic interest
in the retrospective was always "did the ending arrive?", not
mid-body integrity. Collision space is 24 bits, intentionally small
— this is a forensic signal, not a security primitive.

### Deferred to v0.9.2

- Worker protocol update instructing the worker to echo bytes+tail
  back for structured ACK.
- Runtime parser for worker-side ACK messages + auto-warn on
  mismatch.

The fingerprint shipping first means leaders can manually verify
today; the worker-side round-trip lands once prompt + parser work
is designed.

### Tests

Four new v0.9.1 cases in `test/unit/dropFingerprint.test.ts`:

- `drop header contains tail_sha8 and matches payload` — RED
  baseline; hashes a Korean directive and verifies both the header
  field and the UTF-8 byte count.
- `path-first notice embeds (bytes=N tail=XXXX)` — verifies the
  injected notice carries the fingerprint.
- `short payloads hash the whole body (no padding artifacts)` —
  regression guard: payloads under 40 chars hash the full payload,
  not a zero-padded slice.
- `same tail → identical hash; differing tail → different hash` —
  pure-function property check, decoupled from the orchestrator.

All 218 tests green. No regressions in parser, projector, orch,
snapshot, or v0.9.0 dropsArchive suites.

## [0.9.0] - 2026-04-24

### Feature · Drops forensics — archive on attach + session marker

Closes N7 from the 2026-04-24 parseCSV retrospective (Section G).
Field evidence: `to-worker-1-turn1-seq1.md` from a prior session's
reverseString task remained on disk when the next session spawned,
and the new session started writing from `turn2-seq1` onwards. Turn
numbers across drop files no longer corresponded to conversation
turns, and cross-session forensics had to disambiguate which drop
belonged to which session by content inspection.

On every `attach()`, any top-level `*.md` files in
`<cwd>/.omc/team/drops/` are now moved into
`<cwd>/.omc/team/drops/archive/<ISO-timestamp>/`. Subdirectories
(including `archive/` itself) are preserved in place, so
re-archiving is idempotent and prior archives are never
double-moved. Failure is non-fatal and never blocks attach — the
error is logged and the orchestrator continues with a clean-in-
intent drops root.

Drop file headers now include a `session: <first-8-chars>` field
taken from `leader.sessionId`. Combined with the archive layout,
any file found in `drops/` or `drops/archive/<ts>/` is
self-identifying without cross-referencing filesystem timestamps.
Missing `sessionId` falls back to `unknown` (e.g., tests that don't
inject one).

### Tests

Five new v0.9.0 cases in `test/unit/dropsArchive.test.ts`:

- `no pre-existing drops → nothing happens` — idempotent entry.
- `pre-existing drops are moved to archive/<ISO>/` — core behavior.
- `existing archive/ subdir is NOT moved into itself` — re-attach
  idempotency.
- `non-.md files are ignored (left at root)` — `.gitkeep`, stray
  text files remain; only drops move.
- `archive folder name is filesystem-safe` — ISO timestamp with
  `:` and `.` stripped, so Windows paths are valid.

All 214 tests green. No regressions in parser, idle detection,
projector, or orchestrator suites.

### Deferred to later releases

2026-04-24 parseCSV retrospective also flagged seven other items
(N1–N6, N8). This release intentionally takes only N7 — the
smallest well-specified forensic improvement that can ship
without architectural change. Larger items (ACK protocol builtin
— N3, recovery-round exclusion — N6, redelivery metadata — N2,
auto-file flip — N4) need dedicated design passes and will land
in subsequent releases.

## [0.8.9] - 2026-04-24

### Fix · Parser folds Ink wraps that arrive with no 2-space indent

Companion to v0.8.8 — addresses the second P0 from the 2026-04-24
retrospective. Field evidence (drop `to-worker-2-turn4-seq1.md`,
60B, session 2026-04-23): leader emitted
    `@worker-2: .omc/team/artifacts/reverseString.js의 구현을 리뷰해줘. 체크할 포인트: (1)\nIntl.Segmenter...`
in a single pty chunk. The `\n` after `"(1)"` was an Ink visual
wrap, but the wrapped row arrived WITHOUT the 2-space indent that
v2.7.15's continuation rule required. v0.8.7's end-of-buffer hold
didn't fire either (the `\n` was not the last byte — `Intl.Seg...`
followed in the same chunk). Parser terminated at `\n`, yielded
`"체크할 포인트: (1)"`, and worker-2 had to reconstruct the intent
from surrounding context.

Fix: `findSingleLineTerminator` treats a non-indented next line as
continuation when the payload-so-far is wrap-suspect —
    `!endsWithTerminalPunctuation && payloadSoFar.length >= 30`
— provided the usual terminate-signals (new `@target:` directive,
`@end`, blank line) are absent. The legitimate leader-multi-line-
narrative case is still caught by the terminal-punctuation guard
(v0.4.2) and the blank-line guard.

Pairs with a `normalize()` update: single-line folded `\n` with any
indent (including zero) collapses to a single space. Any `\n` that
survives to normalize is confirmed by the terminator logic to be
mid-payload, so the collapse is always correct for single-line bodies.

Asymmetry rationale: under-fold is silent truncation — worker gets
unusable instructions, leader never notices. Over-fold is recoverable
— worker reads a few extra tokens of context, task proceeds. Prefer
over-fold when the signal is ambiguous.

### Tests

Six new v0.8.9 cases in `messageRouter.test.ts`:

- `indent-less wrap continuation in same chunk folds` — verbatim
  field drop reproduction. Was the RED baseline.
- `indent-less wrap across two pty chunks folds` — cooperates with
  v0.8.7 end-of-buffer hold across chunk boundaries.
- `short payload without terminal punct does NOT force-fold` —
  threshold guard; `"apple"` is too short to plausibly be wrap.
- `terminal punct ends directive even with long no-indent follow` —
  v0.4.2 terminal-punctuation guard preserved.
- `next @target directive terminates a long no-punct payload` —
  explicit target boundary wins over wrap-suspect heuristic.
- `blank line after long no-punct payload still terminates` —
  paragraph-break guard preserved.

All 209 tests green. No regressions in v2.7.15 / v0.4.2 / CRLF /
ellipsis / multi-directive / chunk-boundary fixtures.

## [0.8.8] - 2026-04-24

### Fix · Drop sanitizer covers the remaining 2026-04 verb set

The v0.8.7 verb sweep was correction-by-memory and missed what was
actually in the drops folder. An exhaustive sweep with
`grep -hoE '[A-Z][a-z]+…' drops/*.md | sort -u` over the 2026-04-23/24
field captures returned ten unique verbs; four of them weren't in
`THINKING_VERB_RE`:

- `Cooking` (progressive form — `Cooked` was in the list but not
  the active form; `✶ Cooking… (4s · ↓ 120 tokens · thought for 1s)`
  leaked straight through)
- `Forming`
- `Frosting` (dominated `worker-2-turn5-seq2.md` — the drop that
  originally motivated the 2026-04-24 retrospective)
- `Swirling`

Added all four. `Running…` also appeared in drops but is the Bash-tool
status row (`⎿  Running…`); it's already caught by `TOOL_LEADER_RE`
and does not belong in the verb regex — `Running the tests` would
be a legitimate prose prefix and a verb-side match would over-filter.

### Tests

- `sanitize v0.8.8: Cooking/Forming/Frosting/Swirling verbs are noise`
  — uses verbatim drop-file lines (with counter digits and spinner
  glyphs) as fixtures. These tests also act as the canonical release
  tracker: when Claude Code ships a new placeholder verb, add it
  here first (it fails), then add to the regex.

All 204 tests green.

### Why parser fix not included

The other P0 from the 2026-04-24 retrospective — leader directive
truncated at `"(1)"` with `\nIntl.Seg` in the same pty chunk — is
intentionally deferred to v0.8.8b. The naive extension of v0.8.7's
end-of-buffer hold would over-hold legitimate multi-line prompts.
Fix requires distinguishing "Ink wrap continuation with no indent"
from "new narrative line" / "next @target directive" — that needs
design (peek for `@<target>:` pattern vs non-`@` prose, and a
column-width heuristic to guess Ink wrap vs author-intentional
linebreak). Tracked separately.

## [0.8.7] - 2026-04-24

### Fix · Parser no longer truncates long directives at pty chunk boundaries

Field evidence from session 2026-04-24 retrospective: the drop
`to-worker-2-turn6-seq1.md` was 69 bytes, cut mid-sentence at a
comma ("`...reverseStringSimple,`"). The leader's intended directive
was "`...reverseStringSimple, reverseStringUnicode)을 검토해줘.`" —
Ink visual-wrapped the row at ~80 columns, the wrap landed a `\n` +
2-space-indent inside the payload, and that continuation arrived in
a LATER pty chunk. `WorkerPatternParser.findSingleLineTerminator` saw
the newline as the buffer's last byte, peeked ahead (empty), and
classified the absent-content case as `isBlank` → terminate. It
yielded the truncated first row, advanced past the `@worker-2:`
token, and the continuation chunk then hit the stream with no token
prefix and got absorbed as narrative. Worker-2 received unusable
instructions; the leader blamed itself and re-sent.

Fix: when (a) we are on the first iteration (no continuation folded
yet), (b) the chosen newline IS the last byte in the buffer, and
(c) the payload so far is ≥ 30 chars AND not sentence-terminated,
return null from `findSingleLineTerminator`. `drainComplete`
preserves the raw `@<target>: <partial>` slice in the buffer for
the next feed. When the continuation chunk arrives, the peek
succeeds with the indented content and the normal v2.7.15
continuation-fold logic runs. If the leader genuinely stops emitting,
the idle-edge `flush()` path still surfaces the held partial.

Guard conditions tuned against the existing test corpus (v2.7.15
continuation folding, v0.4.2 non-terminated folding, CRLF line
endings, ellipsis-inside-payload, multi-directive chunks) — all 34
router tests pass.

### Fix · Drop sanitizer catches more thinking verbs

Retro evidence showed `Warping…`, `Beaming…`, `Effecting…` slipping
through — Claude Code v2.1+ placeholder rotation has broader verbs
than the initial v0.8.5 list. Added: Warping, Beaming, Effecting,
Conjuring, Transmuting, Invoking, Summoning, Crafting, Weaving,
Forging, Sculpting, Tuning, Calibrating, Syncing, Aligning, Focusing,
Channeling, Orchestrating, Synthesizing.

### Tests

- `router v0.8.7: long directive wrapped across two pty chunks is NOT truncated`
- `router v0.8.7: short directive at end-of-buffer still yields (no hold regression)`
- `router v0.8.7: held partial is released by flush on leader idle`

## [0.8.6] - 2026-04-24

### Fix · Sanitizer hotfix — asterisk spinner + bare counter

Two `isInkNoise` test assertions failed the v0.8.5 release pipeline
(the build still shipped, but the repo carried a red test):

- `*      el in` — Claude's spinner rotation cycles through ASCII
  `*` alongside the unicode glyphs. Line-start `*` followed by a
  short letter/whitespace tail is the diagnostic fragment shape
  drawn during `Channelling…` / `Pouncing…`.
- `↑ 6` — bare arrow + digit that Ink paints mid-stream.

Added `ASTERISK_FRAGMENT_RE` and `BARE_COUNTER_RE` so both match.
Scope is narrow (short length, start-anchored) to avoid colliding
with legitimate markdown list items or inline asterisks.

## [0.8.5] - 2026-04-24

### Fix · Drop sanitizer (P0-1 from 2026-04-24 retro)

Post-session retro surfaced that v0.8.4's dual-transcript fix, while
correct in direction, wasn't enough. Drops captured from the
`reverseString` team run were still 16 KB and 37 KB in size, with
the user's own estimate that roughly 95% of those bytes were
terminal rendering noise.

Inspection of `worker-1-turn4-seq2.md` and `worker-2-turn6-seq2.md`
confirmed the diagnosis: the existing `isCosmeticLine` filter caught
only OMC status rows, bypass hints, and bare prompts. It did not
catch the dominant noise sources in Claude Code v2.1+'s Ink TUI:

- Spinner glyphs on their own row or paired with a fragment of a
  thinking verb (`✻`, `✶ C`, `✢    n  l`).
- Thinking verbs like `Channelling…`, `Pouncing…`, `Sautéed`,
  `Cooked`, `Simmering`, `Harmonizing`, and ~30 more that Claude
  rotates through during generation.
- Timing / token status markers (`(2s · thinking)`,
  `↓ 13 tokens · thinking)`, `↑ 6`).
- Horizontal rules (`───────────────────`) and the Claude logo art
  block (`▐▛███▜▌`, `▝▜█████▛▘`).
- Tool-use chrome (`⎿ path`, `● Reading 1 file… (ctrl+o to expand)`,
  `Found 1 settings issue`, `ctrl+g to edit in Notepad`).
- Cursor-positioned fragments: Ink draws `Channelling…`
  character-by-character across rows, so after stripAnsi +
  cosmetic-filter we saw short lines like `Po`, `u`, `n`, `ci g…`.

Fix: added `isInkNoise` — a broader sanitizer specifically for the
drop-file pipeline. The rawTranscript accumulator in `onPaneData`
now filters by `isCosmeticLine || isInkNoise`, so drop contents are
the worker's actual reply only.

`isCosmeticLine` was intentionally NOT widened. The idle detector's
silence-timer logic uses it to decide whether a chunk resets the
timer; widening it would make the timer drift while Claude is mid-
generation showing "Channelling…" status updates. A regression test
asserts `isCosmeticLine` stays narrow.

Test coverage: 9 new `sanitize: …` tests in `idleDetector.test.ts`
with fixtures taken verbatim from the retro field drops.

P0-2 (turn manifest) and P0-3 (reply-to causality) from the same
retro are queued for v0.8.6 / v0.8.7.

## [0.8.4] - 2026-04-24

### Fix · Drop capture truncation (dual transcript)

Post-session retrospective surfaced the root cause of a pattern we'd
been fighting for multiple versions: drop files nominally captured
worker output (e.g. `worker-1-turn3-seq2.md` at 728 bytes) but
actually contained only the `@leader:` header line with none of the
actual code body. Leader Read the drop file, got nothing useful,
re-asked the worker to resend, burned more rounds, never converged.

Cause: `w.transcript` (the source the spill slices) was fed from
`ClaudeLeaderRoutingProjector.feed(stripAnsi(rawData))`. The
projector closes the assistant block on any line it classifies as
`other` (anything not recognized as assistant-start/cont, prompt,
chrome, status, or blank). Code block bodies, Korean prose without
known prefixes, and most real worker output are `other` — so the
projector dropped them. Intentional for ROUTING (we don't want
arbitrary text misread as directives), but wrong for SPILL (where
we want every byte the worker actually wrote).

Fix: dual transcript.

- `WorkerRuntime` gains `rawTranscript` + `rawCurrentTurnStart`.
- `onPaneData` worker branch now appends raw `stripAnsi` output
  (minus cosmetic UI lines — OMC status / bypass hint / prompt
  echo, via the already-existing `isCosmeticLine` filter, now
  exported from `idleDetector.ts`) to `rawTranscript`. The
  projector-fed `transcript` is unchanged — parser routing and
  dedupe continue to use it.
- Spill in the idle-edge handler now slices `rawTranscript`, not
  `transcript`. Drop file contents are what the worker actually
  wrote, including full code blocks.
- `rawCurrentTurnStart` advances in lockstep with `currentTurnStart`
  on every idle edge.

### Protocol · Retrospective hardening

Three prompt updates driven by the same field log:

1. Worker protocol — `LONG-OUTPUT HANDLING`: for code blocks, long
   reviews, or any multi-paragraph content, workers MUST use their
   Write tool to save the artifact to `.omc/team/artifacts/<name>`
   and reply with "@leader: <path> + one-line summary". Bypasses
   drop-file capture entirely. Insurance on top of the dual-transcript
   fix.
2. Worker protocol — `NO ACK-ONLY REPLIES`: explicit prohibition
   on "확인했습니다" / "대기 중입니다" confirmation messages.
   Workers either do the work, ask a specific question, or report
   a blocker. No handshake rounds.
3. Leader protocol — `COMPLEXITY GATE`: team usage requires at
   least one of { multi-file, genuinely independent perspectives,
   parallelizable chunks, needs external verification }. Single
   small functions: leader answers directly. Strict sequential
   dependency: use one worker for "implement + self-verify"
   rather than splitting.
4. Leader protocol — `NO ENGAGEMENT WITH WORKER ACK-ONLY
   REPLIES`: symmetric to worker side. Leader ignores
   confirmation-only messages, responds only to concrete output,
   specific questions, or real blockers.

No existing tests lock in the projector→transcript path or the
prompt text, so all 190 tests remain green.

## [0.8.3] - 2026-04-24

### Fix · Worker→leader always spills (threshold removed)

Field log from a reverseString relay with an implementer + critic
roster: workers produced long `@leader:` replies that never reached
the leader. Worker-2 wrote a header line (`@leader: worker-1 구현
검토 결과 — 3개 축 + 추가 이슈.`) followed by a multi-paragraph
Korean review. The parser matched the header as a single-line
`@leader:` directive and yielded just that one line. The review body
below sat in `w.transcript` waiting for the busy→idle edge to spill
it. That spill never fired — and when it did, the branch gate
`turnBody.length >= SPILL_THRESHOLD_CHARS (300)` was the wrong lever.
Worker-1's direct evidence: zero `worker-1-turn*.md` drop files in
`.omc/team/drops/` across every session tried, only `to-worker-*`
leader→worker files.

Root cause: the short-reply branch ran `parser.flush()` to drain
pending directives, but in the observed pattern the parser had
**already** yielded the header mid-stream — the body wasn't in
parser buffer, it was in transcript. Flush returned empty, no log
line, the body was lost.

Fix (symmetric with v0.8.0 leader→worker):

- Drop the `SPILL_THRESHOLD_CHARS` gate on the worker→leader idle
  edge. Any non-empty turnBody now spills to
  `.omc/team/drops/worker-N-turn<M>-seq<S>.md` and injects the
  path-first drop notice into the leader.
- `parser.flush()` still runs to drain state, but the drop file
  supersedes anything it might have emitted mid-stream. No more
  double-delivery: parser mid-stream yields that were already routed
  are fine (different dedupe key from the drop-notice text).
- Add explicit log line for empty-body idle edges so the path is
  never silent: `[orch] worker-N idle — no body to spill`.

Test update: `orch v0.6.0: short worker reply stays on parser path`
becomes `orch v0.8.3: short worker reply ALSO spills (threshold
removed)`. Assertion flipped from "no worker→leader spill file" to
"at least one worker→leader spill file". The 190 other tests remain
green; only the semantic intent of the one test changed.

## [0.8.2] - 2026-04-24

### Fix · Leader now uses every worker in the roster by default

Field feedback after v0.8.1: in a reverseString relay session with an
implementer + critic roster, the leader delegated to the implementer,
received the code, then stopped to ask the user "finalize, or another
improvement round?" The critic was never invoked, defeating the point
of running a multi-role team.

Root cause was purely prompt-shaped, not a routing bug. The previous
leader system prompt said "parallelize by default" but gave no rule
against early-stopping a task when other relevant roles existed in
the roster, and the implementer-first / critic-second sequential
pattern was not required.

`buildLeaderSystemPrompt` now embeds an explicit COLLABORATION DEFAULT
section:

- Every role in the roster must contribute. Implementer → critic →
  revision → done is the minimum viable cycle for a multi-role team.
- Pausing to ask the user between worker steps is disallowed except
  when a requirement is genuinely ambiguous, the round budget is
  exhausted, or a worker reports a real blocker.
- Role-to-role routing guidance: when passing an implementer's reply
  to a critic, embed the content directly in `@critic:` — the
  orchestrator's auto-spill (v0.8.0) handles length safely.
- Parallel vs serial distinction kept, but clarified: parallel when
  roles are independent, serial when role B needs role A's output.

No code paths changed; all 190 tests pass as-is (test fixtures don't
lock the prompt text).

## [0.8.1] - 2026-04-24

### Fix · Route-time dedupe kills the re-inject storm

Field logs from a reverseString relay showed the leader's @worker-1 directive being re-dispatched once per user-visible turn. Root cause: Claude's Ink TUI repaints scrollback across turn boundaries, so an already-committed `@worker-N: ...` line reappears in the parser stream on turn N+1. The orchestrator armed a debounce timer for it; each subsequent repaint re-armed (hence the hundreds of `re-arm worker-1 (leaderIdle=busy, msSinceOutput=…ms)` lines in the log). By the time the leader finally fell idle and the debounce fired, `CROSS_TURN_DEDUPE_MS` (120 s, measured from the ORIGINAL commit) had expired — so `commitRoute`'s dedupe missed and the worker got the same task injected again, acknowledging "이전 turn과 동일 요청 — 결과 재전달".

Fix: `route()` now checks dedupe at parse time, before the debounce timer is armed. If the dedupeKey (first line, trim, cap 100) matches a recent `recentPayloads` entry in the same turn or within `CROSS_TURN_DEDUPE_MS`, the route is dropped and any in-flight pending debounce for the same key is cancelled. Symmetric guard added to the `@leader` branch. The commit-time dedupe is retained as a safety net but is now a no-op on the repaint path.

Result: no more re-arm spam, no more stale re-injects after long worker tasks.

## [0.2.1] - 2026-04-23

### Teams Orchestration view — buttons

The Teams Orchestration sidebar view now surfaces every Podium team action as a clickable button, eliminating the need to memorize Command Palette entries for common workflows.

**Title-bar buttons** (visible when the view is focused):

- `$(organization)` **Orchestrated Team** → `podium.orchestrate` — start a new leader + 2 workers team
- `$(history)` **Resume Leader Session** → `podium.orchestrate.resume` — pick from saved leader sessions
- `$(folder-opened)` **Open Saved Team** → `podium.snapshot.load` — restore a snapshot (workers `--resume`'d)
- `$(edit)` **Rename Saved Team** → `podium.snapshot.rename` — rename a snapshot in place
- `$(filter)` **Filter Sessions** → `session.filter` (existing, pushed to rightmost slot)

**Inline node buttons** on a live team:

- `$(add)` Add Worker (already present)
- `$(save)` **Save Snapshot** → `podium.snapshot.save` — targets this specific team (was: "most recent team" only)
- `$(close-all)` **Dissolve** → `podium.dissolve` — targets this specific team

**Inline node buttons** on a worker row (unchanged):

- `$(close)` Remove
- `$(edit)` Rename

### Handler updates (no breaking change)

`podium.snapshot.save` and `podium.dissolve` now accept an optional `PodiumLiveTeamNode` argument. When invoked from the inline button the handler resolves the orchestrator by that node's `sessionKey`; when invoked from the Command Palette (no arg) the existing "most recent active team" fallback kicks in exactly as before.

Consistent with the existing pattern used by `podium.worker.add`, `podium.worker.remove`, and `podium.worker.rename`.

---

## [0.2.0] - 2026-04-23

### Remove psmux / tmux dependency

Podium's orchestration layer no longer depends on an external multiplexer. Every pane — leader and workers — is now managed as a native `node-pty` process owned by the extension. The v2.6/2.7 era accumulated many psmux-specific fixes (mouse-mode scrollback, bracketed-paste LF escaping, send-keys paste-buffer quirks, kill-session zombie servers, win32-input-mode routing through send-keys); all of that surface is now gone.

Primary Path A orchestration features are **unchanged**:

- `Podium: Orchestrated Team (leader + 2 workers)`
- `Podium: Orchestrated Team — Resume Leader Session`
- `Podium: Save Team Snapshot` / `Open Saved Team...` / `Rename Saved Team...`
- `Podium: Dissolve Team` (extract `●` bullet + Haiku fallback summarizer)
- `Podium: Add / Remove / Rename Worker`

### Removed (Path B features tied to the external multiplexer)

- **`Open Claude Code` (Podium-ready variant)** — `createPodiumSession` command and its tmux/psmux wrapping (`src/pty/tmuxWrap.js`, `claudePodiumReadySessions` session-store key, ◆ badge + `organization` icon in the Sessions tree). Regular `Ctrl+Shift+;` open still works.
- **External OMC team integration** — `team.create` (SpawnTeamPanel), `team.createIntegrated` (integrated terminal with OMC_OPENCLAW=1), `team.quickCreate`, `team.attach`, `team.kill`, `team.rename`, and the psmux-scan-based "external sessions" section of the Teams tree (SessionDetector + omcSession tree items).
- **`Kill All Orchestration Sessions (Emergency Reset)`** — the 3-stage psmux kill-session → kill-pane → kill-server escalation. Internal orchestrator teardown is now handled entirely by `LiveMultiPanel.disposeAll()` + orchestrator registry cleanup (already landed in v2.7.27).
- **Legacy `Show Multi-pane` (`podium.grid`)** — the psmux-polling `MultiPaneTerminalPanel` view. `LiveMultiPanel` (the v2.7.0 node-pty direct variant) is now the only multi-pane surface.
- **Config keys**: `claudeCodeLauncher.orchestration.backend`, `claudeCodeLauncher.orchestration.sessionPrefix`, `claudeCodeLauncher.orchestration.sessionFilter`.
- **Deleted modules** (11 files): `src/orchestration/backends/` (IMultiplexerBackend, PsmuxBackend, TmuxBackend), `src/orchestration/core/{SessionDetector,InlineTeamSpawner,OmcCoordinator,PsmuxSetup}.ts`, `src/orchestration/ui/{MultiPaneTerminalPanel,SpawnTeamPanel,TerminalPanel}.ts`, `src/orchestration/webview/multipane-main.ts`, `src/pty/tmuxWrap.js`.

### Simplified

- `src/panel/createPanel.js` — single direct node-pty spawn path; `podiumReady` / `tmuxSession` metadata removed from the `entry` object.
- `src/panel/restartPty.js` — drops the `buildTmuxSpawnArgs` branch.
- `src/pty/autoSend.js` — reduced from 97 lines (psmux send-keys + Win32 KEY_EVENT Shift+Enter chain + fallback) to 11 lines of direct `pty.write(body + '\r')`.
- `src/store/sessionStore.js` — `listPodiumReadySessionsForCwd` removed.
- `src/store/sessionManager.js` — `saveSessions` no longer persists `podiumReady` / `tmuxSession` / `claudePodiumReadySessions`.
- `src/tree/SessionTreeDataProvider.js` — Podium-ready ◆ badge and `organization` icon removed.
- `src/orchestration/index.ts` — `~350 lines` of helpers removed (`resolveBackend`, `binaryFor`, `stripDeprecationWarnings`, `runKillAll`, `LAUNCHER_PODIUM_PREFIX`, `readPodiumLabels`, `enrichFuzzyPodiumLabels`, `PodiumLabel`, `promptTeamSpec`). `TeamsTreeProvider` constructor reduced from `(detector, registry)` to `(registry)`.
- `src/orchestration/ui/TeamsTreeProvider.ts` — rewritten from 239 lines to 90 lines; `SessionNode`, `PaneNode`, `EmptyNode` (psmux-variant), `ErrorNode` removed; now renders only live `PodiumLiveTeamNode` + `WorkerTreeItem`.

### Preserved

- `LiveMultiPanel` (Phase 1 · v2.7.0) — already used node-pty directly; its `addPane` / `writeToPane` / `removePane` interface is untouched.
- `PodiumOrchestrator` routing, idle detection, dispatch debounce (1200 ms), snapshot/restore grace window, deterministic bullet-extraction summarizer — all unchanged.
- File-based observers: `MissionWatcher`, `SessionHistoryWatcher`, `StateWatcher`, `CcgArtifactWatcher`, `TeamConversationPanel` (read-only over `.omc/state/` artifacts when OMC CLI is used externally).
- Solo Launcher features (status icons, session save/restore, 7 themes, context usage bar, smart Ctrl+C, image paste, desktop notifications) are behavior-identical.
- `claudeCodeLauncher.*` command IDs retained for back-compat with existing keybindings and user settings.

### Known cosmetic debt (v0.2.x follow-up)

- Several code comments and i18n entries still reference "tmux-wrapped sessions" or "psmux send-keys" historically. These have no functional effect (the code paths they refer to are gone) but will be scrubbed in a follow-up pass.
- `TeamConversationPanel.sendToLeader` reads `tmux_session` from `.omc/state/.../config.json` for the "inject into leader pane" feature; when the OMC CLI is not used externally the field will be empty and the inject gracefully fails. Full removal deferred until the `.omc/state/` observer layer is re-scoped.

### Tests

- **142/142 tests pass.** No test file touched — all tests cover Path A functionality (orchestrator, routing, idle detection, summarizer, snapshot, worker management) which was not modified. `tsc -p . --noEmit` clean, `tsc -p . --noEmit --noUnusedLocals` reduced unused-locals surface by ~18 entries.

---

## [0.1.0] - 2026-04-22

### Brand identity refresh

Podium's visual and narrative identity is now distinct from its CLI Launcher ancestor. Prior v0.0.1 shipped the original orange "Claude robot on terminal" icon and a README that positioned the extension as a rich CLI wrapper — both carried too much legacy silhouette.

- **New extension icon** (`icons/icon-128.png`, `icons/icon-128.svg`) — three-tier indigo podium with a bright leader spotlight and two worker dots. Instantly reads as "multi-agent stage," zero overlap with terminal/CLI imagery.
- **New toolbar icon** (`icons/claude-robot.svg`) — monochrome podium silhouette that uses `currentColor` to theme-adapt on both light and dark VSCode themes. Previously a 16×16 orange robot face; now a 16×16 stage-platform silhouette.
- **README rewritten** — leads with "Orchestrate multi-agent Claude teams from one stage," splits features into **Orchestration Mode** (leader + workers, routing, snapshots, dissolve-with-summary) and **Solo Mode** (single Claude tab with the old CLI Launcher extras). Adds `History` section documenting the 2026-04-22 rebrand.
- **Marketplace metadata** (`package.json`) —
  - `displayName`: `"Podium CLI Launcher for Claude"` → `"Podium — Multi-Agent Stage for Claude Code"` (keeps product name up front but removes "launcher" framing)
  - `description`: expanded from single-line CLI wrapper pitch to a two-mode pitch
  - `keywords`: 11 entries added (`claude`, `claude-code`, `anthropic`, `ai`, `agent`, `multi-agent`, `orchestration`, `team`, `terminal`, `tmux`, `webview`) for Open VSX discoverability

### No functional change

- All source code, commands (`claudeCodeLauncher.*` prefix preserved for back-compat), configuration keys, and tests are unchanged from v0.0.1.
- 142/142 tests continue to pass (no code path touched).

### Ongoing

This release is the first pass of a larger brand-differentiation effort. Remaining pieces (tab status icons, theme palette defaults, Welcome/panel layout, stage motion effects) are staged for subsequent v0.x iterations.

---

## [0.0.1] - 2026-04-22

### Rebrand
- **Renamed to "Podium CLI Launcher for Claude"** — the product formerly shipped as `cli-launcher-for-claude` (v2.7.33 on the legacy slug) is now **Podium**. Version resets to `0.0.1` to mark the new product line.
- Extension ID: `rockuen.cli-launcher-for-claude` → `rockuen.podium`. **Users of the old extension must install the new one manually** — VSCode has no upgrade path between different extension IDs.
- Legacy `package.json.name` `cli-launcher-for-claude` → `podium`. Output channel `Claude Launcher - Orchestration` → `Podium - Orchestration`. Internal log prefix `[Claude Launcher]` → `[Podium]`.
- Repository moved to `https://github.com/rockuen/podium`. The legacy `cli-launcher-for-claude` repo is frozen with a README pointer to the new home.
- Code-level behavior is IDENTICAL to v2.7.33 of the legacy extension — this release is a pure string rename. All 142 tests pass unchanged.
- History preserved: all prior commits (v2.7.28 scrollback-grace through v2.7.33 dedupe seed) are carried over.

### Internal
- Files touched: `package.json`, `package-lock.json`, `build.sh`, `README.md`, `src/activation.js`, `src/store/sessionStore.js`, `src/store/sessionManager.js`, `src/pty/contextParser.js`, `src/panel/restartPty.js`, `src/panel/createPanel.js`, `src/panel/messageRouter.js`, `src/orchestration/index.ts`.
- VSCode command IDs (`claudeCodeLauncher.*`) and configuration keys (`claudeCodeLauncher.*`) intentionally retained to preserve keybindings and user settings across the rename.

---

## [2.7.33] - 2026-04-22

### Fixed
- **Snapshot restore no longer re-runs prior turn when user issues a new leader request** — v2.7.32 field log 2026-04-22 showed grace correctly dropped 2 scrollback directives (`apple` / `1부터 10까지`), but the moment the user typed a NEW leader request (`worker-1한테는 바나나... worker-2는 1부터 5까지`), Claude's Ink UI repainted the alt-screen — which still contains the PREVIOUS assistant turn above the input box — and the repaint stream re-emitted the old `@worker-N:` directives to the parser. Dedupe didn't catch them (they had been dropped, not routed, so `recentPayloads` had no record), so they queued behind the new directives and re-executed once workers went idle.

  Log sequence reproducing:
  ```
  [orch.restoreGrace] window closed (deadline) — dropped 2 directive(s)
  [parser yielded 2 msg(s)] banana, 1-to-5   (user's new turn)
  [orch] → worker-1: banana
  [orch] → worker-2: 1부터 5
  [parser yielded 4 msg(s)] apple, 1-to-10, banana, 1-to-5   (Ink redraw)
  [orch] queue worker-1 (busy, queue=1): "apple"   ← re-execution
  [orch] queue worker-2 (busy, queue=1): 1부터 10
  ```

  Fix: when `restoreGrace` drops a parser-yielded directive, also seed the target worker's `recentPayloads` dedupe cache with that payload at the current timestamp. `commitRoute` already consults `recentPayloads` and returns early with `stats.deduped += 1` when a match is found within `dedupeWindowMs`. Defaults give ≥15s of post-grace-close dedupe coverage (dedupe window 30_000 ms - grace window 15_000 ms = 15 s), which is well beyond the typical delay between restore and the first user-triggered Ink redraw.

### Internal
- `PodiumOrchestrator.route()` in [PodiumOrchestrator.ts](src/orchestration/core/PodiumOrchestrator.ts) — inside the `restoreGraceEndsAt !== null` branch, after logging the drop, look up the target worker and, if present, call `w.recentPayloads.set(msg.payload, this.nowFn())`. No other state paths touched.
- Grace drops still only count into `stats.dropped`; the new dedupe seed does NOT increment `stats.deduped` (that counter only fires on actual `commitRoute` dedupe hits).

### Tests
- New v2.7.33 regression test `grace-dropped directives are seeded into dedupe cache; post-close Ink redraws do NOT re-route`: arm grace (1 s), fire scrollback chunk → assert `dropped=2`; advance 1100 ms → assert grace closed via `(deadline)`; fire the SAME scrollback chunk again (simulating Ink's post-close repaint) → assert `injected`/`queued` unchanged, `deduped` increased by 2, and no `[orch] queue worker-N (busy...)` log lines appeared.
- 142/142 pass (141 prior + 1 new).

## [2.7.32] - 2026-04-22

### Fixed
- **Snapshot restore grace no longer closes prematurely during Claude CLI's post-spawn welcome UI** — v2.7.31 field log on 2026-04-22 showed the regression was still live: `[orch.restoreGrace] window closed (leader-idle) — dropped 0` still fired before the scrollback `● @worker-N:` burst arrived, and both workers re-executed the prior turn's directives.

  Root cause of the v2.7.31 failure: `IdleDetector.hasPromptPattern()` matches `>`, `[OMC#x.y.z] |`, `⏵⏵ bypass permissions on`, and `╰──` rows in the rolling tail. Claude CLI v2.1+ paints those rows as part of its **initial welcome screen** — immediately on spawn, BEFORE `--resume` starts loading the session and long before scrollback replay begins. So `hasPromptPattern()` returns true from t=0, and `isIdle` fires as soon as the welcome banner finishes printing (~500 ms). v2.7.31's "prompt + silence" gate was no better than v2.7.29's raw silence; both sit entirely in the pre-replay window.

  Conclusion: **no leader-side signal reliably marks "scrollback replay finished."** The prompt pattern exists before replay starts, silence exists before replay starts, and the replayed `● @worker-N:` bullets are indistinguishable from a live leader response.

  Fix: remove the idle-gate entirely. Grace now closes **only when the wall-clock deadline expires** (`restoreGraceMs`, default 15000 ms unchanged from v2.7.29). During the full window, ALL parser-yielded directives are dropped with `[orch.restoreGrace] dropped routing to "<worker>": ...`. Tradeoff: anything the user types in the first 15 s after restore also gets dropped. Acceptable because (a) restore UX has a natural settle pause, (b) re-execution of prior turns is a much worse bug, (c) `restoreGraceMs` is configurable via the attach option for callers that can guarantee an earlier quiescent point.

### Internal
- `PodiumOrchestrator.tick()` in [PodiumOrchestrator.ts](src/orchestration/core/PodiumOrchestrator.ts) — grace close condition simplified to `this.nowFn() >= this.restoreGraceEndsAt`. The `leaderIdle.isIdle` check and the `reason` branch (`leader-idle` vs `deadline`) are gone; close log always reads `window closed (deadline)`.
- No changes to `leaderIdle` itself — still used for parser-flush-on-idle elsewhere in tick(). Only the grace path stopped consuming it.
- State fields unchanged: `restoreGraceEndsAt`, `restoreGraceDroppedCount`.

### Tests
- Removed `v2.7.31: grace closes via leader-idle gate (prompt pattern + silence)` and `v2.7.31: grace stays open during post-spawn silence before any leader output` — both encoded the broken idle-gate contract.
- Added v2.7.32 `grace holds through leader silence + prompt pattern until wall-clock deadline`: feeds a realistic Claude welcome row (`>`, `[OMC#...]`, `⏵⏵ bypass permissions on`), advances 10 s of silence, verifies grace does NOT close; then fires scrollback directive (verified dropped), advances past the 15 s deadline, verifies close log reads `(deadline)`.
- Renamed previous v2.7.29 deadline test to v2.7.32 (`closes via wall-clock deadline even when leader is actively emitting`); comment updated to reflect single-path close.
- 141/141 pass (142 prior - 2 deleted + 1 new = 141).

### Known tradeoff
- The first `restoreGraceMs` (15 s default) after restore drops any `@worker-N:` directive the leader emits — INCLUDING ones the user typed live. Don't type directives immediately after restore; wait for `[orch.restoreGrace] window closed (deadline)` in the orchestration output channel.

## [2.7.31] - 2026-04-22

### Fixed
- **Snapshot restore grace no longer closes during Claude CLI's post-spawn loading silence** — v2.7.30 field test on 2026-04-22: after `Open Saved Team...`, workers **re-executed the prior `"apple"을 한글로 번역해줘.` / `1부터 10까지 합` directives** replayed from scrollback, even though `[orch.restoreGrace] armed for 15000ms` logged correctly. The close message fired **before** the scrollback burst arrived: `[orch.restoreGrace] window closed (leader-idle) — dropped 0 directive(s)` came out, **then** `[orch.trace] parser yielded 2 msg(s)` routed them live.

  Root cause: v2.7.29's idle-gate compared raw `leaderIdle.msSinceOutput >= 1000ms`. But `IdleDetector.lastOutputAt` is seeded at `this.now()` at construction time, so `msSinceOutput` grows monotonically from zero **even when the leader has never emitted a single byte**. Claude CLI's `--resume` takes >1s to load the session from disk before printing the scrollback burst, so the 1s silence threshold was easily crossed during the loading gap. Grace closed with `dropped 0`, scrollback replay routed live, workers re-executed.

  Fix: gate on `leaderIdle.isIdle` instead of raw silence. `isIdle` requires BOTH silence (≥500ms) AND a recognized prompt pattern in the rolling tail (`>`, `[OMC#...]`, `╰──`, or older boxed variants). Claude paints the prompt box only at the END of scrollback replay, so `hasPromptPattern()` can't return true during the loading gap or mid-replay — no more premature close.

### Internal
- `PodiumOrchestrator.tick()` in [PodiumOrchestrator.ts](src/orchestration/core/PodiumOrchestrator.ts) — the grace idle-gate now reads `this.leaderIdle.isIdle` (public getter on `IdleDetector`) instead of `leaderIdle.msSinceOutput >= RESTORE_GRACE_IDLE_MS`. Deadline path (`this.nowFn() >= this.restoreGraceEndsAt`) unchanged — still the 15s safety cap.
- `RESTORE_GRACE_IDLE_MS = 1000` constant removed (no longer referenced; `isIdle` uses `IdleDetector.silenceMs = 500` from construction).
- No new state fields. `restoreGraceEndsAt`, `restoreGraceDroppedCount` unchanged.

### Tests
- v2.7.29 test `grace closes via leader-idle gate (1s silence after burst)` rewritten as v2.7.31 `grace closes via leader-idle gate (prompt pattern + silence)`: burst `● @worker-1: replayed-1` without prompt → verify grace stays open → then emit cosmetic `>` + `[OMC#...]` prompt row → verify grace closes via `leader-idle` reason.
- New v2.7.31 regression test `grace stays open during post-spawn silence before any leader output`: attach → advance 5s of wall-clock silence with no leader output → verify grace does NOT close (pre-v2.7.31 would close at t≈1s with `dropped 0`) → then simulate late-arriving scrollback + prompt → verify grace finally closes.
- v2.7.29 deadline test unchanged (continuous emission without prompt pattern → idle never fires → deadline trips).
- 142/142 pass (141 prior + 1 net new).

## [2.7.30] - 2026-04-22

### Fixed
- **Claude assistant projector no longer closes the block on Ink UI repaints** — v2.7.29 field test showed `worker-1` receiving no directive even though the leader's response visibly ended with `@worker-1: 안녕?`. Output log showed `[orch.trace] leader @worker chunk suppressed by Claude assistant projector` for the legitimate directive. Root cause: Claude Code v2.1+'s Ink TUI continuously repaints the bottom input-box prompt (`> @worker-1: 안녕?<padding>`), the `[OMC#...]` status row, and `────` box-chrome into the same PTY stream as the streaming assistant response. The v2.7.6-era projector classified those three line kinds as "non-assistant" and closed `inAssistantBlock`. When leader's response was long enough for Ink to sneak a repaint between the `●` bullet and a later continuation row (common for multi-sentence responses with a blank line), the assistant block closed prematurely and the continuation `@worker-N:` directive was stripped silently.

  Fix: `prompt` / `status` / `chrome` lines are still dropped from the projector's output (they never route), but they no longer close the block. Only genuinely unknown `other` content — i.e. model output that doesn't match any recognized UI element — marks the assistant turn as ended. `assistant-start` (`●` bullet) still opens/re-opens the block as before.

### Internal
- `ClaudeLeaderRoutingProjector.processLine` in [messageRouter.ts](src/orchestration/core/messageRouter.ts) — the `this.inAssistantBlock = false` sink now sits behind a `kind === 'other'` check. Pre-fix, any of {`prompt`, `status`, `chrome`, `other`} closed the block; post-fix, only `other` does. No state-machine shape change; no new fields.

### Tests
- 2 new cases in [test/unit/messageRouter.test.ts](test/unit/messageRouter.test.ts):
  - `projector: Ink input-box repaint mid-stream does not close assistant block (v2.7.30)` — reproduces the exact v2.7.29 failure (assistant bullet → cont line → blank → `> @worker-1: 안녕?<padding>` repaint → `  @worker-1: 안녕?` cont). Pre-fix the post-repaint cont was stripped; post-fix it survives.
  - `projector: status/chrome mid-stream also does not close assistant block (v2.7.30)` — similar but with `[OMC#...]`, `────`, and `⏵⏵ bypass permissions` interleaved.
- All 141/141 pass (139 prior + 2 new).

## [2.7.29] - 2026-04-22

### Fixed
- **Snapshot restore grace window is now idle-gated, not wall-clock** — v2.7.28 used a flat 3-second deadline on the restore grace window, intending to drop routing directives replayed from the leader's `--resume` scrollback. A user report on 2026-04-22 showed the window closing while Claude CLI was still repainting the prior assistant turn (scrollback + full `● Podium 팀 프로토콜 ... @worker-1: 안녕?` re-render takes >3s for a non-trivial session). The first parsed directive sailed past the (already-expired) window with `dropped 0 directive(s)` logged — and `worker-1` re-executed the replayed `안녕?` directive even though the user never typed a new one.

  Grace is now held open while `leaderIdle.msSinceOutput < 1000` (leader has emitted output in the last 1s — indicating Ink is still mid-repaint). Grace closes as soon as the leader stays quiet for 1s (replay settled) OR the wall-clock safety cap (15s default, bumped from 3s) fires. Normal restores close via the idle gate in 2–4s; the safety cap only trips for a hung leader. `[orch.restoreGrace] window closed (leader-idle)` vs `window closed (deadline)` shows which path fired.

### Internal
- New `RESTORE_GRACE_IDLE_MS = 1000` module constant alongside `ADD_WORKER_RACE_WINDOW_MS`.
- `PodiumOrchestrator.route()` grace branch now reads `this.leaderIdle.msSinceOutput` instead of comparing only `nowFn()` vs `restoreGraceEndsAt`. Still falls back to the wall-clock deadline when `leaderIdle` is unset (fresh-orchestrate path that never sets `restoreGraceEndsAt` — unchanged cost).
- `index.ts` snapshot.load handler's `restoreGraceMs` bumped `3000 → 15000` (safety cap, not the expected close time).

### Tests
- 2 new cases in `podiumOrchestratorWorkerMgmt.test.ts`: directive dropped while leader emits within 1s; directive routed once leader stays silent for 1s+. Existing v2.7.28 test (grace=0 disarm) unchanged.

## [2.7.28] - 2026-04-22

### Fixed
- **Snapshot restore no longer re-executes prior-session routing directives** — During v2.7.27 verification, after `Open Saved Team...` restored a team and the user observed that `worker-1` answered the restored `안녕?` question **a second time** even though no new directive had been typed. Root cause: `--resume <uuid>` causes Claude CLI to replay its prior conversation into the alt-screen scrollback on leader spawn. As Ink repaints that scrollback, its pty stream contains the same `@worker-N: ...` directives that were already routed+executed in the original session. The freshly-attached orchestrator (empty `recentPayloads` Map, no dedupe state carried over) treats them as new directives and re-injects them into the just-restored worker panes, duplicating every prior command.

  Restore now arms a **3-second grace window** (`OrchestratorAttachOptions.restoreGraceMs: 3000`) inside `PodiumOrchestrator.route()`. Any routing directive parsed during the window is dropped with `[orch.restoreGrace] dropped routing to "worker-N" (Nms left in grace): <payload>` and a summary `[orch.restoreGrace] window closed — dropped N directive(s) from scrollback replay; live routing active` fires when the window expires. Fresh orchestrate (no `--resume`) omits the option and the code path is zero-cost.

  The window only affects parser → route dispatch. IdleDetector feeds, transcript accumulation, leader-notify commits, and snapshot auto-save continue to see the replayed bytes so idle detection and autosave behavior stay correct.

### Internal
- `PodiumOrchestrator.attach()` gains the `restoreGraceMs` option. Stored as `restoreGraceEndsAt` (nowFn-relative deadline) + `restoreGraceDroppedCount` (for the closing summary log). Both null/zeroed on fresh orchestrate.
- `index.ts` snapshot.load handler passes `restoreGraceMs: 3000` in its `orch.attach(...)` opts. Other entry points (`orchestrate`, `orchestrate.resume`) omit it — orchestrate.resume resumes the leader but spawns fresh workers, so the scrollback replay issue doesn't meaningfully apply (no prior worker routing to replay).

### Tests
- 3 new cases in `podiumOrchestratorWorkerMgmt.test.ts`: directives dropped during grace window (no worker write), directives routed normally after window expires, grace disarms after first post-window route with summary log.

## [2.7.27] - 2026-04-22

### Fixed
- **Orchestrator team lifecycle: no more ghost teams after tab close or Kill All** — Three related lifecycle bugs surfaced during v2.7.26 verification:
  1. Closing a team's webview tab left the `orchestratorRegistry` entry behind. The Teams tree kept showing the dead team as a live `PodiumLiveTeamNode`; right-clicking `Add Worker` on it routed to a disposed panel and crashed with `addWorker FAILED — Webview is disposed`, **but still spawned an orphan Claude pty process** (pid captured in logs, no owner).
  2. `Kill All Orchestrations` only killed tmux/psmux sessions — `orchestratorRegistry` was never touched, so the tree view stayed cluttered with stale entries even after the nuclear option.
  3. Invoking `Orchestrate Team` multiple times piled new orchestrators on top of old ones with no cleanup path, compounding both issues above.

  Root cause: `LiveMultiPanel.disposeAll()` tore down its `paneExitEmitter` before `pty.kill()`'s `onExit` event could fire, making the `panel.onPaneExit` subscription unreachable on user-driven tab close. `killAll` never looped through `orchestratorRegistry`.

### Internal
- `LiveMultiPanel` gains an explicit `_disposed` flag, a public `isDisposed` getter, and a new `onDidDispose` event. `addPane` / `writeToPane` / `removePane` now early-return no-op on disposed panels so a stale orchestrator reference cannot spawn orphan pty processes. `disposeAll` fires `onDidDispose` before dismantling emitters so subscribers can clean up synchronously. A new public `dispose()` method lets `killAll` tear panels down programmatically.
- `PodiumOrchestrator.isDisposed` getter (reads from the `leader === null` disposal invariant) lets the tree view skip stale entries as a safety net.
- Three `podium.*` command handlers (`orchestrate`, `orchestrate.resume`, `snapshot.load`) now subscribe to `panel.onDidDispose` as a first-class lifecycle path. Both the existing `onPaneExit` path and the new `onDidDispose` path call `orchestratorRegistry.delete(sessionKey)` + `teamsProvider.refresh()` so Teams tree stays consistent under any teardown.
- `claudeCodeLauncher.orchestration.killAll` now loops `orchestratorRegistry` BEFORE running tmux cleanup, disposing each entry, clearing the map, and refreshing the tree. Log line `[orch.killAll] cleared N orchestrator registry entries` surfaces exactly what got torn down.
- `TeamsTreeProvider.getChildren` filters `orch.isDisposed === true` from the root list as belt-and-suspenders protection.

### Tests
- 3 new `liveMultiPanel.test.ts` cases cover the disposal contract: `isDisposed` starts false; `disposeAll` flips it true exactly once; post-dispose `addPane` is a no-op (no pty spawn); `onDidDispose` fires exactly once; `dispose()` is idempotent across repeated calls.

## [2.7.26] - 2026-04-22

### Fixed
- **Snapshot restore no longer crashes panes whose workers were never used in the original session** — When `Podium: Save Team Snapshot` captures a team, every pane's pre-allocated session UUID is recorded. But Claude CLI only materializes `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` AFTER the first user message is submitted through that pane. A worker that was spawned but never routed to in the original session has a UUID the snapshot knows about yet no on-disk transcript. On restore, the previous `--resume <uuid>` flag would fail with "No conversation found with session ID …" and the pane exited with code=1 (observed in the v2.7.25 manual verification flow).

  Restore now probes `isClaudeSessionResumable(cwd, sessionId)` for each pane before spawning. Resumable panes still use `--resume <uuid>` and inherit their prior conversation. Non-resumable panes (no JSONL yet) spawn fresh via `--session-id <uuid>`, preserving the pane's identity in the snapshot ledger so subsequent saves remain consistent. A log line `[orch.snapshot.load] worker <id> has no JSONL transcript (<sid8>); spawning fresh with same session-id` surfaces each fresh spawn for debugging, and a summary `workers: N resumed · M fresh (never used in original session)` lands at the end of the load flow.

### Internal
- `sessionPicker.ts`: new pure helper `isClaudeSessionResumable(cwd, sessionId, home?)` that checks `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` via `fs.existsSync`. Exposed alongside `hashCwdForClaudeProjects` / `claudeProjectsDirForCwd` / `listClaudeSessions` for future reuse (e.g. snapshot validators, orphan-cleanup utilities).
- Leader restore path also gains the probe: an unused leader (rare — the protocol acknowledgement usually produces a first turn) spawns fresh with `buildLeaderExtraArgs()` + preserved `sessionId`. Labels switch from `leader (restored XXX)` to `leader (fresh XXX)` so users can tell which panes had prior context.

### Tests
- 4 new `sessionPicker.test.ts` cases cover the probe matrix (JSONL present → true, mixed used/unused pair, missing projects dir → false, empty sessionId → false).

## [2.7.25] - 2026-04-22

### Added
- **Runtime worker add/remove/rename via TeamsTreeProvider context menus with idle-gated leader notification** — New commands `Podium: Add Worker`, `Podium: Remove Worker`, `Podium: Rename Worker` are accessible from the Teams view context menu or Command Palette. Tree UI surfaces live Podium teams with per-worker children; rename updates the displayed label while keeping the routing key (`worker-N`) immutable.
- Leader pane is auto-notified on add/remove via idle-gated writer with 2-second wall-clock deadline (mirrors existing `tryDispatchPending` pattern) — no interference with in-progress leader turns on Windows/Claude Win32 input mode.
- Runtime cap: `MAX_RUNTIME_WORKERS = 10` per team (matches snapshot retention and SpawnTeamPanel prompt-level guard).

### Fixed
- **N-worker snapshot compatibility — existing 2-worker snapshots continue to load; new N-worker teams save/restore seamlessly** — Snapshot schema version remains unchanged (`SNAPSHOT_SCHEMA_VERSION = 1`); roundtrip tests cover N=0, 1, 3, 5 workers plus pre-v2.7.25 2-worker fixture regression.

### Internal
- `PodiumOrchestrator` gains `addWorker`, `removeWorker`, `renameWorker`, `scheduleLeaderNotify`, `listWorkers` methods.
- Multi-orchestrator correctness: tree commands route via `sessionKey` rather than "last entry" lookup.
- Pane-first rollback order in `addWorker` prevents orphan Map entries on spawn failure (via new `LiveMultiPanel.hasPane` probe).
- Regression tests: 6 new test cases covering worker lifecycle mutations, snapshot load/save across worker counts, and dissolve × runtime-add/remove/roundtrip scenarios. All tests pass.

### Out of scope for v2.7.25
- Codex/Gemini mixed worker types — runtime Add UI surfaces Claude only.
- Routing-key rename (immutable by design in this version).
- Auxiliary UI label sync (TerminalPanel tabs, Conversation Panel heading text on rename) — tracked as OQ-5 for v2.7.26+.

## [2.7.24] - 2026-04-22

### Fixed
- **Dissolve summary now reproduces worker answers verbatim** — The previous Haiku-based summarizer occasionally hallucinated "no answer found in transcript" responses even when workers had clearly printed their results, because the Claude CLI wraps assistant output with Ink frames, leader status lines, and long ANSI chrome that the model was asked to interpret in one pass. Added a deterministic first pass: `extractLastAssistantBullet()` scans the transcript for the `●` glyph that prefixes every finalized assistant reply and returns the text immediately after it (with multi-line indented continuations joined). When *every* worker produces a recognizable bullet line, `claudeBareSummarizer` skips the Haiku call entirely and emits the verbatim `- worker-N: <answer>` list. When at least one worker is missing a bullet, the Haiku fallback still runs, but with a strengthened prompt that explicitly describes the `●` convention ("the text after `●` IS the answer — copy it verbatim; never claim the answer is missing when a `●` line is present"). Verified live against an 8321ch / 3716ch transcript pair with two workers — summary returned in <100 ms (no LLM round-trip) and the leader received `- worker-1: red/blue/green translation - worker-2: 110` exactly as typed by the workers.

### Internal
- 6 new test cases in `test/unit/dissolve.test.ts` covering empty-bullet drop, whitespace-only bullet drop, multi-line indented continuation join, mixed hit/miss → Haiku fallback, all-hit → no-LLM path, and the 8321ch realistic-flood regression. 106/106 tests pass.

## [2.7.23] - 2026-04-22

### Fixed
- **Standalone-word spinner rows no longer bleed into dissolve summaries** — Claude CLI v2.1+ occasionally emits the Ink spinner label (`Processing…`, `Thinking…`, etc.) on its own line without the leading Braille glyph that v2.7.20's `SPINNER_RE` relied on. Those orphan-word rows slipped past the chrome filter and the summarizer treated them as worker content. Extended the chrome-filter so these standalone spinner-word rows are dropped too, alongside the existing glyph-prefixed form and the `(esc to interrupt · ctrl+t to show todos)` keyboard hint row.

## [2.7.22] - 2026-04-22

### Fixed
- **IdleDetector no longer misses the Claude v2.1+ prompt when Ink leaves leading whitespace** — The prompt-row regexes (`>` alone and the `[OMC#<version>]` status line) required the line to start at column 0, but Ink's re-wrap pass sometimes emits them with a leading space. Prompt detection would silently miss, which cascaded into routing dispatch waiting forever for an idle signal that never came. All prompt-row patterns now accept leading whitespace, and the new `⏵⏵ bypass permissions` hint that Claude prints right below the prompt is matched too so the idle window closes promptly.
- **`busyWorkers()` is no longer gated on `IdleDetector.isIdle`** — The pre-dissolve UX warning (introduced in v2.7.21) asked `IdleDetector` whether each worker was idle, but the detector's prompt-pattern eviction can flip `isIdle` to `true` the instant the prompt reappears even when fresh output is still arriving. That produced false "all idle" readings and skipped the warning. `busyWorkers()` now inspects the `msSinceLastOutput` timestamp directly, so a worker that has emitted output within the configurable busy threshold is still reported as busy regardless of the idle detector's view.

## [2.7.21] - 2026-04-22

### Added
- **Dissolve UX warning for busy workers** — Dissolving while a worker is still emitting output means the transcript tail the summarizer sees is incomplete, so the injected summary will miss the actual answer. The Dissolve command now calls `PodiumOrchestrator.busyWorkers()` before proceeding; if any worker has produced output within the configured busy threshold, a modal `showWarningMessage` appears listing each busy worker with its time-since-output and offers `Dissolve anyway` / `Cancel`. Both the cancel path and the "confirmed despite busy" path are logged to the Orchestration output channel for post-hoc diagnosis of rushed dissolves.
- **Team Snapshot: rename** — Snapshot entries persisted in `claudeTeams.json` can now be renamed via the `Team Snapshot: rename` command. Complements the v2.7.19 snapshot save/load pair; a proper UI-level rename affordance in the snapshot list view is tracked for a later milestone.

### Fixed
- **Ghost "leader referenced unknown worker-N" spam after dissolve is eliminated at the source** — After `dissolve()` clears the workers Map, the leader pane stays alive and Ink occasionally repaints scrollback rows that still contain old `@worker-N:` directives. The router had no target to deliver these to and logged a `leader referenced unknown "worker-N" — dropped` line for each ghost directive, which polluted the output channel with several lines per second during the post-dissolve repaint. `consumeLeaderOutput()` now short-circuits with an early return whenever `this.workers.size === 0`, so the projector never accumulates ghost state and the parser is never invoked; no log noise, no wasted cycles, and the leader's pty → webview rendering (handled by `LiveMultiPanel`, not this path) is unaffected.

## [2.6.19] - 2026-04-20

### Fixed
- **Mouse wheel scroll restored in Podium-ready sessions** — v2.6.15 set `set -g mouse off` in the leader tmux conf to work around a drag-selection auto-clear regression, but the side effect was that tmux dropped the SGR wheel reports emitted by xterm.js's wheel-forward path. The inner TUI (Claude CLI) never saw scroll events, making alt-screen scrollback unreachable in every Podium-ready pane. Restored `set -g mouse on` and mitigated the original regression by unbinding `MouseDrag1Pane` / `MouseDragEnd1Pane` in `root`, `copy-mode`, and `copy-mode-vi` tables — tmux no longer hijacks drag selections into copy-mode, so xterm.js's native text selection stays intact while wheel events pass through to the inner program. `~/.claude-launcher/tmux-leader.conf` is rewritten by `ensureLeaderConf()` on next extension activation; existing psmux sessions are unaffected until restarted, because tmux only loads the conf at `new-session`.

## [2.6.6] - 2026-04-17

### Added
- **Interactive prompt detection — fast-path to needs-attention** — When the PTY emits a Claude CLI confirmation prompt ("Do you want to…", "[Y/n]", "Press Enter to continue…", etc.), the tab now flips to `needs-attention` immediately instead of waiting out the 7-second running threshold. Brief prompts that finished setup in 2 seconds and silently sat asking for a Yes/No no longer go unnoticed.
- **Tab title blink while needs-attention** — The webview tab title prefixes a `⚠` glyph that flashes every 800 ms whenever the tab is unfocused **and** in `needs-attention` state. Self-stops when you focus the tab, when the state transitions away, or when the panel is disposed. Combined with the existing desktop notification + status bar prominent background, the tab is now genuinely hard to miss when Claude is waiting for an answer.

## [2.6.5] - 2026-04-17

### Added
- **Reorder custom buttons in settings** — Each custom button row in the Settings → Custom Buttons list now has ▲/▼ arrows next to the delete X. Click to swap with the adjacent row. The top row's ▲ and the bottom row's ▼ are hidden so you always know what will happen. Order is persisted to `customButtons` and reloads into the toolbar on the next window reload.
- **Edit custom buttons in place** — Click the label or command text of any custom button row to turn it into an inline input. Enter commits the edit, Escape cancels, blur commits. No separate edit dialog — same hover affordance pattern as the delete X and the new move arrows.
- **Auto /effort max on first idle** — Optional toggle in Settings. When on, each session automatically sends `/effort max` the first time it reaches an idle state after startup. Useful when Reload Window restores many resume-later sessions and you want them all back on max effort without visiting each tab. Off by default. Fires once per session — manually changing the effort later is not overridden.

### Changed
- **Smooth wheel scroll in normal mode** — Enabled xterm.js `smoothScrollDuration: 120` so wheel scrolling over the scrollback buffer glides between frames instead of jumping line-by-line. Applies only to xterm's native scroll API path (normal buffer with scrollback), so fullscreen TUI mode is unaffected — the TUI (Claude CLI) still drives its own partial redraws there, and any fake CSS smoothing would collide with partial frame updates and re-introduce ghost artifacts.

## [2.6.4] - 2026-04-17

### Added
- **Redraw screen — recover from fullscreen rendering corruption without losing context** — Wheel scrolling in Claude CLI's fullscreen TUI sometimes leaves overlapping text or ghost lines behind (the TUI's partial-redraw pipeline doesn't always flush its frame buffer cleanly). Added a `↻` button in the toolbar (visible only while alternate screen is active) and a `Ctrl+Shift+R` shortcut that trigger a full redraw. Mechanism: webview repaints xterm via `term.refresh()`, then the extension toggles the PTY size by 1 column and back — Claude CLI receives two SIGWINCH signals and redraws from scratch. Unlike `/clear` or `/compact`, **no session, scrollback, or conversation state is touched** — it's a purely visual refresh.

## [2.6.3] - 2026-04-16

### Fixed
- **FS mode stuck detecting fullscreen when Claude CLI isn't in it — wheel scroll broken** — The mouse-mode tracking flag was kept alive by the enable/disable escape sequences alone. If Claude ever failed to emit the disable sequence on TUI exit (or a write-chunk boundary sliced the sequence and broke our regex), `isMouseMode` stayed `true` indefinitely, hijacking wheel events into SGR reports that the non-fullscreen Claude CLI couldn't consume. Now wheel forwarding requires **both** `isAlternateScreen` (authoritative via `term.buffer.onBufferChange`) **and** `isMouseMode`, and any return to the normal screen buffer force-clears the mouse-mode flag.

### Added
- **Click FS indicator to force normal mode** — Escape hatch for rare cases where detection is still wrong. Clicking the amber `FS` badge in the toolbar toggles a user override: the badge turns grey, strikes through (`FS×`), and the terminal behaves as if fullscreen were off — wheel scrolls locally, drag/copy work as usual. Click again to return to auto-detect. The override auto-clears when the buffer returns to normal, so you don't have to remember to toggle it back.

## [2.6.2] - 2026-04-16

### Fixed
- **Ctrl+C still forwarded to PTY after copy (leaking ^C to Claude CLI exit prep)** — The v2.6.1 document-level Ctrl+C handler correctly did the clipboard copy, but it also naively skipped all `<textarea>` targets to preserve native input copy. xterm.js uses a hidden `xterm-helper-textarea` to capture keyboard input, so focus inside the terminal classified as TEXTAREA → the handler skipped → xterm's internal processing forwarded ^C to the PTY. Claude CLI then started its "Press Ctrl+C again to exit" countdown even though the copy had succeeded. Now we detect xterm's internal textarea by checking `#terminal.contains(e.target)` and always proceed with copy in that case, only bailing for real user-facing inputs. Added `stopImmediatePropagation()` and restored a selection-guard inside `attachCustomKeyEventHandler` (returns `false` when selection exists) as belt-and-suspenders protection.
- **Open Folder failed for partial/nested paths** — `handleOpenFile` had a basename-search fallback that walked the cwd tree up to depth 6 to locate files like `slack-manifests/01-demand-forecast.yaml`, but `handleOpenFolder` skipped this branch and just errored out when the first resolve attempt failed. Mirrored the same fallback so selecting a relative file path and choosing "Open Folder" now finds the file anywhere in the workspace tree and opens its containing directory in the OS file explorer.

## [2.6.1] - 2026-04-16

### Changed
- **Context indicator click → `/compact`** — Clicking the toolbar context-usage bar used to re-query usage via `/context`. But usage already updates automatically from output, so the click was most often used when the bar entered the danger zone and the user wanted to compact anyway. One less command to type.

### Fixed
- **Ctrl+C copy unreliable after drag-select** — `attachCustomKeyEventHandler` only fires when xterm's internal textarea has focus, but drag-to-select in fullscreen/alternate-screen mode can leave focus on the viewport div instead. Moved the Ctrl+C copy logic to a document-level capture-phase listener so it runs regardless of which element inside the webview holds focus. Real `<input>`/`<textarea>` targets are skipped so native input-field copy still works, and the "send ^C to PTY when no selection" path is preserved (non-handled events fall through to xterm's default).

## [2.6.0] - 2026-04-16

### Added
- **Custom session sorting** — Sessions within a group (or at top level in Recent Sessions) can now be reordered manually. Two methods: (1) right-click → "Move Up" / "Move Down" for precise adjustments, (2) drag-and-drop for direct positioning. Sort order is persisted in `claudeSessionSortOrder` and takes precedence over the default mtime-based order.
- **2-level session nesting** — Sessions can now contain sub-sessions for hierarchical organization. Right-click a top-level session → "Nest Under Session..." → pick a parent from the QuickPick. Maximum depth is 2 (Group → Session → Sub-session). Sub-sessions appear indented under their parent regardless of their own group membership. Use "Unnest (Move to Top Level)" on a sub-session to flatten it back.
- **Drag & drop session management** — Drag a session onto a custom group → moves it there. Drag onto another session → inserts it right before the target, inheriting the target's group and parent (so dropping on a sub-session places the dragged item as a sibling under the same parent). Multi-select is supported (`canSelectMany: true`). 2-level safety guard prevents drops that would exceed the depth limit.
- **Custom group ordering** — Groups can now be reordered the same two ways as sessions: (1) right-click a group header → "Move Group Up" / "Move Group Down", (2) drag a group header onto another group to insert it right before. Group order is persisted by rewriting the `claudeSessionGroups` object with the new key order (modern JS engines preserve non-integer-string key insertion order).

### Changed
- **Session icons — titled vs untitled** — Titled sessions (with a user-assigned name) use `comment-discussion` (two overlapping speech bubbles). Untitled sessions use `comment-draft` (dashed-border bubble) so the two kinds are visually distinguishable at a glance. Removed the earlier `folder` override that rendered every grouped session identical to its group header.
- **Context value assignments** — Tree items now carry explicit `contextValue` strings (`session`, `subSession`, `customGroup`, `recentGroup`, `resumeLaterGroup`, `trashGroup`, `trashed`). Existing `moveToGroup` / `trashSession` menu conditions switched from negative matching to positive matching so they no longer leak onto group headers.

### Internal
- `SessionTreeDataProvider` gains `handleDrag` / `handleDrop` (for `TreeDragAndDropController`) and helpers `_getScope` / `_getSiblings` / `_writeSortOrder` / `moveSessionUp` / `moveSessionDown` / `setSessionParent` / `removeSessionParent` / `moveGroupUp` / `moveGroupDown` / `_reorderGroupsBefore` / `_writeGroupOrder`.
- D&D uses two MIME types — `application/vnd.code.tree.claudecodelauncher.sessions` (session items) and `...groups` (custom group headers) — so group drags can't accidentally act like session moves.
- New storage keys: `claudeSessionSortOrder` (integer map, sparse 10/20/30...) and `claudeSessionParent` (session→parent sessionId map). No migration needed; group order continues to live in `claudeSessionGroups` key order.

## [2.5.7] - 2026-04-16

### Added
- **Fullscreen mode detection & indicator** — Claude CLI's new fullscreen mode uses alternate screen buffer + mouse reporting, which breaks text selection and other launcher features. The launcher now detects both `\e[?1049h` (alternate screen) and `\e[?100Xh` (mouse tracking) escape sequences in real-time and shows an amber "FS" badge in the toolbar. A one-time toast hint reminds the user that Shift+drag bypasses mouse capture for text selection.
- **Context menu works in fullscreen** — Right-click context menu listener switched from bubble to capture phase, so it fires even when xterm.js mouse reporting intercepts and stops propagation of the event.
- **Export warns in alternate screen** — When exporting from fullscreen mode, a toast warns that only the current viewport is captured (the normal buffer with full scroll history is not accessible from the alternate screen).
- **Scroll FAB auto-hidden in fullscreen** — The scroll-to-bottom button is suppressed in alternate screen mode since the TUI application manages its own scrolling.

## [2.5.6] - 2026-04-15

### Added
- **Toast "열기" link after paste-to-file** — When a large paste is saved to a temp file, the notification toast shows a clickable `[열기]` link that opens the saved text file in the editor. Lets you verify exactly what Claude will see via the `@path` reference.
- **Toast "취소" link on attachments** — Both the text paste-to-file toast and the image paste toast now carry a red `[취소]` link. Clicking it sends N DELs (0x7f) into the PTY to wipe the just-injected `@path`/image-path from the prompt and deletes the backing temp file, so the attachment never existed as far as Claude is concerned. Saves you hitting backspace N-hundred times. Caveat: if you've already typed prompt text after the paste, those trailing chars get erased first — cancel promptly.
- **Image paste thumbnail preview** — When a screenshot is pasted, the toast now renders a small thumbnail (max 96×64) of the exact bitmap that was captured, so a wrong clipboard (pasted the previous screenshot by mistake) is obvious before Claude sees it. Thumbnail is reused on the success toast, which additionally gets the `[열기]` + `[취소]` links.
- **TSV → Markdown preview in toast** — Conversion toast previously said only "TSV → Markdown 표 변환". It now reports dimensions, e.g. "📊 TSV → Markdown: 6행 × 4열", so a wrong clipboard is obvious at a glance.

### Fixed
- **Toast action links weren't clickable** — `#paste-toast` had `pointer-events:none` in CSS (so the toast wouldn't block terminal clicks under it). That also blocked the new `[열기]` link. Root fix: keep the toast non-interactive by default, but set `pointer-events:auto` on action links individually.
- **Idle 1s scroll polling removed (B4)** — `scroll-fab` visibility was driven by a 1-second `setInterval(checkScroll, 1000)` on every open panel, doing a DOM query even when the terminal was idle. Replaced with a direct `scroll` listener on xterm's `.xterm-viewport` element (attached once it materializes). Zero work while idle; identical behavior when scrolling.

### Internal
- `tryConvertTsvToMarkdown` now returns `{ markdown, rows, cols } | null` instead of `text`. Callers switched to explicit null check.
- `showToast(message, opts)` now accepts `opts.actions = [{ label, onClick, color? }, ...]` for multi-link rows; legacy `opts.action` still supported. New `opts.image` renders a prepended thumbnail. Toast auto-dismiss bumped 2.5s → 4s to give time to click.
- `paste-file-ready` / `image-paste-result` messages carry `fullPath` (native separators) alongside `cliPath`. New router cases: `open-paste-file` (routes to `vscode.open`), `cancel-paste-file` (unlinks the temp file).

## [2.5.5] - 2026-04-15

### Fixed
- **Excel cell selection pasted as PNG instead of text** — Excel puts both tab-separated text AND a rendered PNG on the clipboard for any cell range. The v2.5.4 paste handler iterated `clipboardData.items` and caught the image entry first, which meant tabular data was silently uploaded as an image instead of kept as text. Paste now **prioritizes text**: if `clipboardData.getData('text')` returns anything, the text path runs (with optional TSV→Markdown conversion and the existing size-based paste-to-file threshold). Image handling only fires when there is no text on the clipboard (pure screenshots).

### Added
- **TSV → Markdown table auto-conversion** — When a paste is detected as a tab-separated table (≥2 rows with the same ≥2 column count), it is converted to a Markdown table before injection so Claude can parse it directly. Enabled by default; disable with `claudeCodeLauncher.pasteTableAsMarkdown = false` to keep the raw TSV. `|` characters inside cells are escaped as `\\|` to keep the table valid. Converted pastes are injected via `term.paste()` so xterm's bracketed-paste wrapping still applies.

## [2.5.4] - 2026-04-15

### Fixed
- **Paste truncation — root workaround via `@path`** — v2.4.3's 256B/20ms chunked writes still lost bytes in prolonged large pastes because Ink (Claude CLI's TUI layer) runs its own line editor on top of ConPTY, and that editor drops bytes when reads can't keep up with writes over ~1–2KB. Chunking only lowered the rate, didn't remove the drop. Now when clipboard text exceeds `claudeCodeLauncher.pasteToFileThreshold` characters (default **2000**, set `0` to disable), the webview intercepts the paste, saves the text to `<os.tmpdir()>/claude-launcher-paste/paste-<timestamp>-<rand>.txt`, and injects `@<absolute-path> ` into the PTY instead. The CLI's `@file` reference reads the file directly, sidestepping PTY bulk-write entirely. No truncation possible because the PTY only sees a short path. Temp files older than 7 days are swept on each paste.
- **Export Conversation — transcript corrupted by terminal reflow (redone correctly)** — v2.5.2 tried to fix this by capturing raw `pty.onData` bytes and stripping ANSI, but Claude CLI is an Ink (TUI) app that expresses layout via cursor-move + partial writes, so blind ANSI stripping discards layout meaning and produces mangled text. Export now uses `term.selectAll() + term.getSelection()`, which runs through xterm.js's virtual-terminal state machine (already handles cursor moves, `isWrapped` line merges, and render state) and then trims trailing whitespace per line. Render output is now export output.

### Added
- **`claudeCodeLauncher.pasteToFileThreshold`** setting (default 2000, min 0) — 0 disables the paste-to-file behavior and restores direct PTY paste for all sizes.

### Removed
- `src/pty/rawBuffer.js` and related `appendRaw`/`resetRaw` hooks added in v2.5.2 (unused after switching Export to `getSelection`).

## [2.5.2] - 2026-04-15

### Fixed
- **Export Conversation — transcript corrupted by terminal reflow** — Previously the transcript was reconstructed by iterating xterm's render buffer (`term.buffer.active.getLine(i).translateToString(true)`). Two failure modes stacked: (1) soft-wrapped long lines (e.g. a long URL warning exceeding `cols`) were split across physical rows and `\n`-joined, chopping one sentence into two; (2) Windows ConPTY live-reflows already-emitted lines when the terminal resizes, which could then collapse many logical lines into one very wide row padded with hundreds of trailing spaces — producing the wall-of-spaces blob users reported. Export now reads from a new **per-entry raw PTY capture** (`pty.onData` → `entry.rawOutput`, ring-trimmed at 10MB by whole lines) and runs it through a dedicated `sanitizeForExport()` that strips CSI/OSC/DCS escape sequences, collapses `\r\n` → `\n`, and resolves lone `\r` progress-bar overwrites by keeping only the text after the last `\r` on each line. Render state of the terminal no longer affects export fidelity.

### Internal
- New module `src/pty/rawBuffer.js` (`appendRaw` / `resetRaw` / `sanitizeForExport` / `MAX_RAW_BUFFER = 10MB`).
- `pty.onData` handlers in `createPanel.js` + `restartPty.js` call `appendRaw(entry, data)`; `restartPty` calls `resetRaw(entry)` when spawning the new process so a restart starts the raw transcript fresh.
- `handleExportConversation` signature changed from `(text, entry, panel)` to `(entry, panel)`. Webview no longer scrapes its render buffer; it just sends `{ type: 'export-conversation' }`.
- `entry.rawOutput` is in-memory only (not persisted to `sessions.json`).

## [2.5.1] - 2026-04-15

### Fixed
- **`sessions.json` partial-write / cross-window race** — `sessionStoreUpdate` previously did `readFileSync` → mutate → `writeFileSync`, so two windows (or two flushes inside one window) flushing back-to-back could clobber each other's keys, and a crash mid-write left a truncated/corrupt JSON file the next launch couldn't parse. Writes now go through a `.tmp.<pid>.<ts>` file with `fsync` + atomic `rename`, and tmp files are cleaned up on failure.
- **Particle effect RAF kept burning CPU when disabled** — `animateParticles` re-scheduled itself via `requestAnimationFrame` every frame even when `particlesEnabled` was off, leaving an idle ~60 fps no-op loop running. Now the loop exits on disable, and both toggle paths (right-click "Particles" + slash command `toggle-particles`) restart it on re-enable.

### Removed
- **Dead `set-memo` message handler** — Router accepted a `set-memo` webview message that no client code ever sent (real memo flow is `request-edit-memo` → `showInputBox` → `memo-updated`). Removed handler + protocol comment.

## [2.5.0] - 2026-04-15

### Changed
- **Internal refactor — module split** — `extension.js` (4,386 lines) split into a thin 3-line entry + 23 modules under `src/`. No user-visible behavior changes. Structure only. Module layout:
  - `src/activation.js` — activate/deactivate lifecycle, command registration (10 commands under `claudeCodeLauncher.*`)
  - `src/state.js` — runtime state singleton (panels Map, tabCounter, statusBar, sessionTreeProvider, context)
  - `src/i18n/` — locale strings (en/ko) and runtime resolution
  - `src/store/` — session JSON persistence (`sessions.json`) + save/restore
  - `src/tree/` — `SessionTreeDataProvider` for the sidebar
  - `src/pty/` — `writePtyChunked`/`killPtyProcess`/`resolveClaudeCli` + `createContextParser()` factory (dedupes what was previously duplicated between createPanel and restartPty)
  - `src/panel/` — `createPanel`, `restartPty`, `messageRouter` (19 webview→ext types dispatched from one table), `statusIndicator`, `webviewContent`/`webviewStyles`/`webviewClient` (HTML/CSS/JS separated as JS modules; true static split scheduled for v2.6)
  - `src/handlers/` — toolbar, openFile (with partial-path recovery), openFolder, pasteImage, dropFiles, exportConversation, desktopNotification

### Fixed
- **XSS via innerHTML (pre-existing, hardened during refactor)** — Settings list renders for custom buttons / custom slash commands / file associations / slash menu concatenated user input directly into `innerHTML`. Added `escapeHtml()` helper and applied it at 5 injection points. DOM structure unchanged, string sanitization only.

### Internal
- Session schema (`sessions.json` keys and 6-field session object) unchanged — existing user sessions load transparently.
- Command IDs under `claudeCodeLauncher.*` preserved (legacy naming kept to protect existing `keybindings.json` bindings).
- `WebviewPanelSerializer` still not used — retained self-managed restore via `sessions.json` and activate-time `restoreSessions`.

## [2.4.3] - 2026-04-14

### Fixed
- **Long paste truncation (recurrence)** — v2.4.0's `writePtyChunked` (1024B/10ms) still dropped bytes on Windows ConPTY under sustained writes, and concurrent `writePtyChunked` calls (paste + typing) could interleave chunks because each call started its own setTimeout chain. Now a per-entry write queue serializes all writes, chunk size dropped to 256B and delay bumped to 20ms for ConPTY buffer headroom, and chunk boundaries skip UTF-16 surrogate pair splits so emoji/astral chars don't corrupt.

## [2.4.2] - 2026-04-13

### Fixed
- **Open File — Windows default app not launched** — Two issues combined silently: (1) `vscode.env.openExternal(Uri.file(...))` on Windows/Antigravity didn't hand off to the OS default app, and (2) when users had explicit `fileAssociations` like `.xlsx→excel`, the code invoked `spawn('excel', [...])` which fails with ENOENT since `excel` isn't in PATH. Both paths now route through `cmd.exe /c start "" "<path>"` (with `windowsVerbatimArguments` so `cmd` sees the quoted path intact), deferring to Windows file association to resolve the default app. Added a spawn error listener so future failures surface as a warning toast instead of silent.
- **Open File — partial/mid-drag selection** — "Open File" now uses the same `resolvePathFragment` recovery as Open Folder (cwd → ancestors → home dir → platform roots), so mid-drag fragments like `Downloads\foo.xlsx` resolve correctly. Previously only the basename-search fallback ran, which couldn't reach files outside `entry.cwd` (e.g. `~/Downloads`) and silently failed with "File not found".
- **`~` expansion for Open File** — `~`, `~/foo` now expand to the home directory.
- **Directory-as-file rejection** — If the resolved path points to a directory, Open File now warns instead of attempting to open it as a file.

## [2.4.1] - 2026-04-12

### Fixed
- **Open Folder — partial/mid-drag selection** — Context menu "Open Folder" now correctly resolves partial paths (e.g., mid-drag of an absolute path selecting `rockuen/obsidian/...`). Introduced `resolvePathFragment` which tries cwd → ancestors (walk-up) → home dir → platform roots (`/Users` on Mac, `/home` on Linux), accepting only paths that actually exist. Previously walked up to any existing parent and silently opened the wrong folder (often cwd).
- **Open Folder — lost selection on right-click** — Some environments (notably Mac Electron + xterm canvas) cleared the selection during `mousedown`/`contextmenu`, causing "Select text first" toasts even with visible selection. Now caches the selection at `contextmenu` time and falls back to it when live selection is empty.
- **`~` expansion** — `~`, `~/foo` now expand to home directory on Mac/Linux.

### Added
- **Open Folder — success toast** — Shows "Open folder: <path>" on success (parity with Open File).
- **Invalid path warning** — Shows "Cannot open folder (invalid or partial path)" instead of silently opening an unrelated ancestor directory.

## [2.4.0] - 2026-04-08

### Security
- **Command injection hardening** — Replaced all `exec()` with `execFile`/`spawn` + argument arrays (`killPtyProcess`, `showDesktopNotification`, `handleOpenFile`, `handleOpenFolder`, `readClipboardImageFromSystem`)
- **URL scheme validation** — `open-link` handler now rejects non-http(s) URLs (prevents `javascript:`, `vscode:` execution)
- **Windows path injection fix** — `openNative` uses `vscode.env.openExternal` instead of `cmd /c start` for untrusted paths

### Fixed
- **Long text paste truncation** — `writePtyChunked()` splits large inputs into 1024-byte chunks with 10ms intervals (ConPTY buffer overflow fix)
- **Stale PTY handler race** — Added `entry.pty !== thisPty` guard on all `onData`/`onExit` handlers to prevent old PTY exit events from corrupting new PTY state
- **Restart PTY robustness** — Kill old PTY before spawn, reset `_disposed` flag, debounce with `_restarting` guard, use stored `cols/rows` instead of hardcoded 120x30
- **Deactivate saves dead sessions** — Filter `!entry.pty` entries to prevent restoring finished conversations on reload
- **Null PTY guards** — `handlePasteImage`, `handleDropFiles` now check `entry.pty` before write
- **File descriptor leak** — `_extractFirstUserMessage` uses `try/finally` for `fs.closeSync`
- **Particle animation** — Skip render loop when particles are disabled (CPU savings)
- **CLI resolve timeout** — `execFileSync` with 1.5s timeout (was `execSync` 3s blocking)

## [2.3.7] - 2026-04-07

### Fixed
- **"Webview is disposed" errors** — Added `_disposed` guard flag and `try/catch` protection to all async `postMessage` calls (PTY `onExit`, `setTimeout` callbacks, clipboard `exec`). Cleared `runningDelayTimer` in `onDidDispose` to prevent stale timer firing.

## [2.3.6] - 2026-04-03

### Fixed
- **Clean copy (trim trailing whitespace)** — `getCleanSelection()` trims trailing spaces from each line when copying terminal text. Applied to Ctrl+C, context menu Copy, Open File, and Open Folder.

## [2.3.1] - 2026-03-26

### Fixed
- **Context usage parsing overhaul** — Comprehensive ANSI strip (CSI, OSC, 2-byte ESC, all control chars including CR/DEL), rolling 300-char buffer for cross-chunk pattern capture, optional colon in keyword regex (`컨텍스트:` format), broad fallback regex for resilient % detection

### Added
- **Inline group management icons** — Rename/Delete icons on custom group headers, Empty Trash icon on trash group header
- **Session group context values** — `customGroup` and `trashGroup` context values for precise menu targeting
- **Group rename command** — Rename groups with expanded state preservation
- **Debug logging** — One-time context buffer sample log for parsing diagnostics

## [2.3.0] - 2026-03-26

### Added
- **Custom session groups** — Unlimited user-defined groups, QuickPick session move, "Remove from Group" to ungroup
- **Trash / Restore** — Delete moves sessions to trash folder, Restore brings them back, Empty Trash with confirmation dialog
- **Group collapse state persistence** — `onDidExpandElement`/`onDidCollapseElement` tracking, restored on refresh
- **i18n nls files** — `package.nls.json` (English) + `package.nls.ko.json` (Korean) for sidebar labels

### Fixed
- **`const projDir` duplicate declaration** — Reused variable in `_buildGroups()` for Trash group

## [2.1.6] - 2026-03-24

### Fixed
- **CLI resolution for npm installs** — Fixed "Cannot create process, error code 2" on Windows when Claude CLI is installed via `npm install -g`. node-pty cannot execute `.cmd` shim files directly; now wraps with `cmd.exe /c` automatically.
- Unified CLI path resolution into `resolveClaudeCli()` function (3-step: `~/.local/bin` → npm global → PATH fallback)

## [2.1.0] - 2026-03-24

### Added
- **i18n support** — English and Korean, auto-detected from IDE language setting
- **Settings modal** — In-extension settings UI (gear icon / right-click menu)
  - Theme, font size, font family, sound, particles toggle
  - Custom buttons and slash commands management
  - Export/Import settings as JSON for sharing
- **Context usage indicator** — Toolbar progress bar showing token usage (click to refresh)
- **Custom slash commands** — User-defined commands in autocomplete dropdown via settings
- **Custom buttons** — Configurable input panel buttons via settings
- **Ctrl+C copy** — Copy selected text with Ctrl+C, send interrupt when no selection
- **CLI not found detection** — Shows install guide when Claude Code CLI is missing

### Changed
- Toolbar simplified — removed zoom, paste image, sound buttons (accessible via settings/shortcuts)
- Queue button unified — single button for add + run
- Slash commands genericized — standard CLI commands only, personal skills via custom settings

## [2.0.0] - 2026-03-22

### Added
- Webview + xterm.js + node-pty based terminal
- Tab icon status display (idle/running/done/error)
- Session save/restore with split view support
- Slash command autocomplete (/ input dropdown)
- Task queue with sequential execution
- Input history (Ctrl+Up/Down)
- Image paste (PowerShell/osascript fallback)
- Windows desktop toast notifications
- 7 background themes with ambient glow effects
- Background particle effects
- Tab color tags, tab memo
- File path click to open (Obsidian/browser/editor)
- Keyboard shortcut overlay (Ctrl+?)
- Search bar (Ctrl+F) with xterm-addon-search
- Conversation export to markdown
- Response timer
- "Close (Resume Later)" with sidebar session grouping
- Cross-platform support (Windows/Mac)
- Install script (install.sh)
