// v0.9.6 — Council product skeleton: barrel export.
// v0.9.7 — Adds ContextPackBuilder API (buildContextPack, renderers, helpers).
// v0.10.0 — Adds ParticipantTransport API (Fake / HeadlessProcess) and the
//           canonical `runCouncil` async entry point.
//
// Importers should pull from this module rather than reaching into individual
// files so future restructuring (e.g. when real Codex/Gemini bindings land
// in v0.10.1) does not break call sites.

export type {
  ContextPack,
  ContextFileRef,
  CostBudget,
  CouncilParticipant,
  CouncilParticipantOutput,
  CouncilParticipantRole,
  CouncilParticipantTransport,
  CouncilRun,
  CouncilRunStatus,
  ProviderId,
  ReturnBrief,
} from './types';

export {
  runCouncil,
  runFakeCouncil,
  type CouncilParticipantSpec,
  type CouncilRunnerOptions,
  type CouncilRunResult,
  type ContextPackInput,
  type FakeParticipantSpec,
} from './CouncilRunner';

export {
  buildContextPack,
  buildContextManifest,
  renderContextPackMarkdown,
  redactSecrets,
  truncateBytes,
  type BuildContextPackInput,
  type BuiltContextPack,
  type ContextFileInput,
  type ContextPackCaps,
  type FileInclusionRecord,
  type InclusionRecord,
} from './ContextPackBuilder';

export {
  FakeParticipantTransport,
  HeadlessProcessTransport,
  CodexParticipantTransport,
  GeminiParticipantTransport,
  transportLabelFor,
  type FakeParticipantTransportOptions,
  type HeadlessProcessTransportOptions,
  type CodexParticipantTransportOptions,
  type GeminiParticipantTransportOptions,
  type ParticipantInvocation,
  type ParticipantTransport,
  type ParticipantTransportResult,
  type ParticipantTransportStatus,
} from './ParticipantTransport';

export {
  runConsultOthersFlow,
  type ActiveFileRef,
  type ConsultOthersDeps,
  type ConsultOthersOutcome,
  type RunConsultOthersOptions,
} from './CouncilUI';

export type { CouncilSynthesizerSpec } from './CouncilRunner';
