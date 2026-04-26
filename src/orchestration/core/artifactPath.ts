// v0.12.0 — Artifact-only routing (Option C).
//
// Extract a `.omc/team/artifacts/<file>.md` reference from a leader
// directive body. Used by PodiumOrchestrator to bypass the legacy
// `drops/to-*` envelope and inject the artifact path directly to the
// worker, eliminating the chain-follow hop entirely.
//
// Tolerates Windows-style backslashes by normalizing to forward slashes
// before matching, so the same captured form (`.omc/team/artifacts/...`)
// works on every platform.

const ARTIFACT_PATH_RE = /(\.omc\/team\/artifacts\/[A-Za-z0-9._-]+\.md)/;

export function extractArtifactPath(directive: string): string | null {
  if (!directive) return null;
  const normalized = directive.replace(/\\/g, '/');
  const m = normalized.match(ARTIFACT_PATH_RE);
  return m ? m[1] : null;
}
