/**
 * OMC mission-state.json / subagent-tracking.json schemas.
 * Observed live on 2026-04-17 from `.omc/state/` in this repo.
 */

export type MissionStatus = 'pending' | 'in-progress' | 'done' | 'failed' | string;

export interface MissionTaskCounts {
  total?: number;
  pending?: number;
  blocked?: number;
  inProgress?: number;
  completed?: number;
  failed?: number;
}

export interface MissionAgent {
  name: string;
  role?: string;
  ownership?: string;
  status?: MissionStatus;
  currentStep?: string | null;
  latestUpdate?: string | null;
  completedSummary?: string | null;
  updatedAt?: string;
}

export interface MissionTimelineEntry {
  id: string;
  at: string;
  kind?: string;
  agent?: string;
  detail?: string;
  sourceKey?: string;
}

export interface Mission {
  id: string;
  source?: string;
  name?: string;
  objective?: string;
  createdAt?: string;
  updatedAt?: string;
  status?: MissionStatus;
  workerCount?: number;
  taskCounts?: MissionTaskCounts;
  agents?: MissionAgent[];
  timeline?: MissionTimelineEntry[];
}

export interface MissionStateFile {
  updatedAt?: string;
  missions?: Mission[];
}

export interface SubagentTrackingAgent {
  agent_id: string;
  agent_type?: string;
  started_at?: string;
  parent_mode?: string;
  status?: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface SubagentTrackingFile {
  agents?: SubagentTrackingAgent[];
  total_spawned?: number;
  total_completed?: number;
  total_failed?: number;
  last_updated?: string;
}
