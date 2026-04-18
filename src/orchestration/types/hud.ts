/**
 * OMC HUD state types.
 * Mirrors the shape of `.omc/state/hud-stdin-cache.json` written by OMC.
 * Discovered via live dump during P0.1 (research/hud-stdin-cache-sample.json).
 */

export interface HUDModel {
  id?: string;
  display_name?: string;
}

export interface HUDCostSnapshot {
  total_cost_usd?: number;
  total_duration_ms?: number;
  total_api_duration_ms?: number;
  total_lines_added?: number;
  total_lines_removed?: number;
}

export interface HUDContextUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface HUDContextWindow {
  total_input_tokens?: number;
  total_output_tokens?: number;
  context_window_size?: number;
  current_usage?: HUDContextUsage;
  used_percentage?: number;
  remaining_percentage?: number;
}

export interface HUDRateLimit {
  used_percentage?: number;
  resets_at?: number;
}

export interface HUDRateLimits {
  five_hour?: HUDRateLimit;
  seven_day?: HUDRateLimit;
}

export interface HUDWorkspace {
  current_dir?: string;
  project_dir?: string;
  added_dirs?: string[];
}

export interface HUDStdinCache {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: HUDModel;
  workspace?: HUDWorkspace;
  version?: string;
  output_style?: { name?: string };
  cost?: HUDCostSnapshot;
  context_window?: HUDContextWindow;
  exceeds_200k_tokens?: boolean;
  rate_limits?: HUDRateLimits;
}
