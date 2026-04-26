import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractArtifactPath } from '../../src/orchestration/core/artifactPath';

test('extractArtifactPath: returns the path when present in a typical directive', () => {
  assert.equal(
    extractArtifactPath('parseCSV 부탁 — see .omc/team/artifacts/task-parsecsv.md.'),
    '.omc/team/artifacts/task-parsecsv.md',
  );
});

test('extractArtifactPath: tolerates Windows backslashes', () => {
  assert.equal(
    extractArtifactPath('see .omc\\team\\artifacts\\task.md'),
    '.omc/team/artifacts/task.md',
  );
});

test('extractArtifactPath: returns null when no artifact path is present', () => {
  assert.equal(extractArtifactPath('@worker-1: 1+1은 2야'), null);
});

test('extractArtifactPath: ignores non-artifact .omc paths', () => {
  assert.equal(
    extractArtifactPath('see .omc/team/drops/to-worker-1.md'),
    null,
  );
});

test('extractArtifactPath: finds path inside multi-line bodies', () => {
  const body = '여러 줄 본문\n참조: .omc/team/artifacts/foo-bar.md\n끝.';
  assert.equal(extractArtifactPath(body), '.omc/team/artifacts/foo-bar.md');
});

test('extractArtifactPath: returns the first match when multiple are present', () => {
  const body = 'see .omc/team/artifacts/a.md and .omc/team/artifacts/b.md';
  assert.equal(extractArtifactPath(body), '.omc/team/artifacts/a.md');
});

test('extractArtifactPath: handles empty / null input safely', () => {
  assert.equal(extractArtifactPath(''), null);
});

test('extractArtifactPath: matches when path is the only token', () => {
  assert.equal(
    extractArtifactPath('.omc/team/artifacts/task.md'),
    '.omc/team/artifacts/task.md',
  );
});
