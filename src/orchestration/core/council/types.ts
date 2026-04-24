// v0.9.6 — Council product skeleton: core types.
//
// These types model the Temporary Council workflow described in
// `260424 Podium 통합 플랜 v6 - Temporary Council 중심 제품 계획.md`. They are
// intentionally provider-neutral: `provider` is a free-form string so a
// council participant could be Claude, Codex, Gemini, or any future runtime
// without a schema bump. `Podium` is not "Claude calling other models"; it is
// "the current primary model — whoever it is — calling a temporary council".

export type ProviderId = string;

export type CouncilParticipantRole =
  | 'critic'
  | 'implementer'
  | 'reviewer'
  | 'researcher'
  | 'judge'
  | 'synthesizer';

export type CouncilParticipantTransport = 'headless' | 'pty' | 'fake';

export interface CouncilParticipant {
  id: string;
  provider: ProviderId;
  role: CouncilParticipantRole;
  transport: CouncilParticipantTransport;
  permissionProfile?: string;
}

export interface ContextFileRef {
  /** Workspace-relative path (POSIX separators). */
  path: string;
  bytes?: number;
  reason?: string;
}

export interface ContextPack {
  id: string;
  primarySessionId: string;
  userQuestion: string;
  currentGoal: string;
  recentConversationSummary: string;
  relevantFiles: ContextFileRef[];
  gitDiff?: string;
  testOutput?: string;
  constraints: string[];
  createdAt: string;
}

export type CouncilRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface CouncilParticipantOutput {
  participantId: string;
  status: 'completed' | 'failed' | 'skipped';
  /** Workspace-relative artifact path. */
  artifactPath: string;
  summary: string;
  startedAt: string;
  completedAt: string;
}

export interface CostBudget {
  maxUsd?: number;
  maxDurationMs?: number;
  maxTokens?: number;
}

export interface CouncilRun {
  id: string;
  primarySessionId: string;
  contextPackId: string;
  participants: CouncilParticipant[];
  status: CouncilRunStatus;
  budget?: CostBudget;
  outputs: CouncilParticipantOutput[];
  preset?: string;
  createdAt: string;
  completedAt?: string;
}

export interface ReturnBrief {
  id: string;
  councilRunId: string;
  /** Short text suited to inject into the primary LLM session. */
  injectText: string;
  /** Workspace-relative path to the human-readable brief markdown. */
  detailArtifactPath: string;
  recommendedAction: string;
  disagreements: string[];
  risks: string[];
  createdAt: string;
}
