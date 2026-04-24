// v0.9.5 — EventLogger unit tests.
//
// Verify the ledger writes NDJSON, fills provider-neutral envelope fields,
// appends across multiple calls, never throws into the caller on I/O error,
// and emits exactly one warning line when writes start failing.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  EventLogger,
  EVENT_SCHEMA_VERSION,
  type EventEnvelope,
} from '../../src/orchestration/core/EventLogger';

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readNdjson(file: string): EventEnvelope[] {
  const raw = fs.readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as EventEnvelope);
}

test('EventLogger: writes one NDJSON line per log() call', () => {
  const cwd = mkTmp('podium-eventlogger-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'sess-0001' });
  logger.log({ type: 'session.started', source: { kind: 'orchestrator' } });
  logger.log({
    type: 'route.committed',
    turnId: 3,
    source: { kind: 'leader', id: 'L', provider: 'claude' },
    target: { kind: 'worker', id: 'worker-1', provider: 'claude' },
    payload: { direction: 'leader-to-worker' },
  });

  const file = path.join(cwd, '.omc', 'team', 'logs', 'orchestrator.ndjson');
  const events = readNdjson(file);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'session.started');
  assert.equal(events[1].type, 'route.committed');
  assert.equal(events[1].turnId, 3);
  assert.equal(events[1].source?.id, 'L');
  assert.equal(events[1].target?.id, 'worker-1');

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('EventLogger: envelope carries schemaVersion, eventId, ts, level, podiumSessionId', () => {
  const cwd = mkTmp('podium-eventlogger-');
  const fixedIds = ['id-001', 'id-002'];
  let i = 0;
  const logger = new EventLogger({
    cwd,
    podiumSessionId: 'podium-session-xyz',
    nowIso: () => '2026-04-24T00:00:00.000Z',
    newEventId: () => fixedIds[i++],
  });
  logger.log({ type: 'session.started' });
  logger.log({ type: 'ack.mismatch', level: 'warn' });

  const events = readNdjson(logger.path);
  assert.equal(events[0].schemaVersion, EVENT_SCHEMA_VERSION);
  assert.equal(events[0].eventId, 'id-001');
  assert.equal(events[0].ts, '2026-04-24T00:00:00.000Z');
  assert.equal(events[0].level, 'info');
  assert.equal(events[0].podiumSessionId, 'podium-session-xyz');

  assert.equal(events[1].eventId, 'id-002');
  assert.equal(events[1].level, 'warn');

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('EventLogger: optional fields are omitted when unset (no stray undefined)', () => {
  const cwd = mkTmp('podium-eventlogger-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'sess' });
  logger.log({ type: 'session.started' });

  const events = readNdjson(logger.path);
  const e = events[0];
  assert.ok(!('turnId' in e), 'turnId must not appear when unset');
  assert.ok(!('messageId' in e), 'messageId must not appear when unset');
  assert.ok(!('correlationId' in e), 'correlationId must not appear when unset');
  assert.ok(!('source' in e), 'source must not appear when unset');
  assert.ok(!('target' in e), 'target must not appear when unset');
  assert.ok(!('payload' in e), 'payload must not appear when unset');

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('EventLogger: endpoint shape is provider-neutral (provider optional)', () => {
  const cwd = mkTmp('podium-eventlogger-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'sess' });
  logger.log({
    type: 'route.committed',
    source: { kind: 'leader', id: 'L' },
    target: { kind: 'worker', id: 'worker-1' },
  });
  logger.log({
    type: 'route.committed',
    source: { kind: 'leader', id: 'L', provider: 'codex' },
    target: { kind: 'worker', id: 'worker-1', provider: 'gemini' },
  });

  const events = readNdjson(logger.path);
  assert.equal(events[0].source?.provider, undefined);
  assert.equal(events[0].target?.provider, undefined);
  assert.equal(events[1].source?.provider, 'codex');
  assert.equal(events[1].target?.provider, 'gemini');

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('EventLogger: write failure never throws; emits exactly one warning line', () => {
  const warnLog: string[] = [];
  // Point at a filesystem path that cannot be created: embed a null byte so
  // mkdirSync / writeFileSync reject with an OS error (EINVAL/ERR_INVALID_ARG).
  const badPath = path.join(os.tmpdir(), 'podium-bad-\0-ledger.ndjson');
  const logger = new EventLogger({
    cwd: os.tmpdir(),
    filePath: badPath,
    podiumSessionId: 'sess',
    warn: {
      appendLine(s: string) {
        warnLog.push(s);
      },
    },
  });

  // Caller must never see an exception.
  for (let i = 0; i < 5; i++) {
    const result = logger.log({ type: 'session.started' });
    assert.equal(result, null, 'failed writes return null');
  }

  // Exactly one warning, regardless of how many attempts failed.
  assert.equal(warnLog.length, 1, `expected 1 warning, got ${warnLog.length}: ${warnLog.join(' | ')}`);
  assert.ok(
    warnLog[0].includes('[eventLogger] warning'),
    `warning line format: ${warnLog[0]}`,
  );
});

test('EventLogger: appends across multiple sessions (same file)', () => {
  const cwd = mkTmp('podium-eventlogger-');
  const logger1 = new EventLogger({ cwd, podiumSessionId: 'sess-a' });
  logger1.log({ type: 'session.started' });
  logger1.log({ type: 'route.committed' });
  const logger2 = new EventLogger({ cwd, podiumSessionId: 'sess-b' });
  logger2.log({ type: 'session.started' });

  const events = readNdjson(logger1.path);
  assert.equal(events.length, 3);
  assert.equal(events[0].podiumSessionId, 'sess-a');
  assert.equal(events[1].podiumSessionId, 'sess-a');
  assert.equal(events[2].podiumSessionId, 'sess-b');

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('EventLogger: default level is "info" when not specified', () => {
  const cwd = mkTmp('podium-eventlogger-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'sess' });
  logger.log({ type: 'drop.written' });
  const events = readNdjson(logger.path);
  assert.equal(events[0].level, 'info');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('EventLogger: payload round-trips arbitrary JSON-safe values', () => {
  const cwd = mkTmp('podium-eventlogger-');
  const logger = new EventLogger({ cwd, podiumSessionId: 'sess' });
  logger.log({
    type: 'redelivery.tagged',
    payload: {
      dropPath: '.omc/team/drops/to-worker-1-turn1-seq2.md',
      priorDropPath: '.omc/team/drops/to-worker-1-turn1-seq1.md',
      chainLength: 2,
      nested: { a: 1, b: ['x', 'y'] },
    },
  });
  const events = readNdjson(logger.path);
  assert.equal(events[0].payload?.chainLength, 2);
  assert.deepEqual(events[0].payload?.nested, { a: 1, b: ['x', 'y'] });
  fs.rmSync(cwd, { recursive: true, force: true });
});
