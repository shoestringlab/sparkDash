/**
 * llm-host client — what /opt/llm-host's llm-model@ subsystem is doing on a
 * Spark. Read-only: status, the unit journal, and the per-rank crash logs a
 * cluster launcher leaves behind. Process management (switch/start/stop)
 * deliberately has no path here yet.
 *
 * Sits outside src/api/client.ts with a small local apiFetch copy — same
 * reasoning as llmTokenClient.ts: keep fork-sensitive surfaces out of the
 * shared client so upstream merges stay clean.
 */

import { authHeaders, reportAuthRequired } from "./authToken";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    ...opts,
    headers: { ...headers, ...authHeaders(), ...(opts?.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    if (res.status === 401) reportAuthRequired();
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export interface LlmHostClusterNode {
  node: string;
  container: string;
  state: string;
  head: boolean;
}

export interface LlmHostClusterVram {
  node: string;
  vram: Record<string, unknown> | null;
}

/** The `llm-model status --json` document (fields the UI renders). */
export interface LlmHostStatus {
  host: string;
  profile: string | null;
  unit_state: string | null;
  uptime: string | null;
  engine: string | null;
  port: number;
  ready: boolean;
  served_ids: string[] | null;
  crosscheck: string;
  cluster?: LlmHostClusterNode[] | null;
  cluster_vram?: LlmHostClusterVram[] | null;
  descriptor: Record<string, unknown>;
  [extra: string]: unknown;
}

export interface LlmHostStatusResponse {
  ok: boolean;
  present: boolean;
  status?: LlmHostStatus;
  error?: string;
}

export interface LlmHostLogResponse {
  ok: boolean;
  present?: boolean;
  text?: string;
  error?: string;
}

export interface LlmHostCrashLogFile {
  file: string;
  path?: string;
  mtime?: number;
  bytes?: number;
}

export interface LlmHostCrashLogListResponse {
  ok: boolean;
  files?: LlmHostCrashLogFile[];
  cliTooOld?: boolean;
  error?: string;
}

export interface LlmHostCrashLogsResponse {
  ok: boolean;
  present?: boolean;
  profile?: string;
  cliTooOld?: boolean;
  nodes?: Array<{ node: string | null } & LlmHostCrashLogListResponse>;
  error?: string;
}

export interface LlmHostCrashLogTailResponse {
  ok: boolean;
  present?: boolean;
  file?: string;
  lines?: string[];
  error?: string;
}

function q(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

export function fetchLlmHostStatus(id: string): Promise<LlmHostStatusResponse> {
  return apiFetch(`/api/sparks/${id}/llmhost`);
}

export function fetchLlmHostLogs(
  id: string,
  opts?: { profile?: string; lines?: number }
): Promise<LlmHostLogResponse> {
  return apiFetch(
    `/api/sparks/${id}/llmhost/logs${q({
      profile: opts?.profile,
      lines: opts?.lines,
    })}`
  );
}

export function fetchLlmHostCrashLogs(
  id: string,
  opts: { profile: string; lines?: number }
): Promise<LlmHostCrashLogsResponse> {
  return apiFetch(
    `/api/sparks/${id}/llmhost/crash-logs${q({
      profile: opts.profile,
      lines: opts.lines,
    })}`
  );
}

export function fetchLlmHostCrashLogTail(
  id: string,
  opts: { profile: string; file: string; node?: string; lines?: number }
): Promise<LlmHostCrashLogTailResponse> {
  return apiFetch(
    `/api/sparks/${id}/llmhost/crash-logs/tail${q({
      profile: opts.profile,
      file: opts.file,
      node: opts.node,
      lines: opts.lines,
    })}`
  );
}

// ─── Process management (Tier 2) ──────────────────────────────────────────

export interface LlmHostProfile {
  profile: string;
  live: boolean;
  engine?: string;
  weights?: string;
  approved_for?: string[];
  port?: number;
  [extra: string]: unknown;
}

export interface LlmHostProfilesResponse {
  ok: boolean;
  present?: boolean;
  profiles?: LlmHostProfile[];
  error?: string;
}

export interface LlmHostActionJob {
  id: string;
  sparkId: string;
  action: "switch" | "start" | "stop";
  profile: string | null;
  startedAt: string;
  state: "running" | "done" | "failed";
  exitCode: number | null;
  error?: string | null;
  output?: string[];
}

export interface LlmHostActionResponse {
  ok: boolean;
  job: LlmHostActionJob | null;
  error?: string;
}

export function fetchLlmHostProfiles(id: string): Promise<LlmHostProfilesResponse> {
  return apiFetch(`/api/sparks/${id}/llmhost/profiles`);
}

export function startLlmHostAction(
  id: string,
  body: { action: "switch" | "start" | "stop"; profile?: string }
): Promise<LlmHostActionResponse> {
  return apiFetch(`/api/sparks/${id}/llmhost/action`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchLlmHostAction(id: string): Promise<LlmHostActionResponse> {
  return apiFetch(`/api/sparks/${id}/llmhost/action`);
}
