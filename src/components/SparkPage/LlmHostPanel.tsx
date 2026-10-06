import { useCallback, useEffect, useState } from "react";
import { Panel } from "../ui/Panel";
import {
  fetchLlmHostAction,
  fetchLlmHostCrashLogTail,
  fetchLlmHostCrashLogs,
  fetchLlmHostLogs,
  fetchLlmHostProfiles,
  fetchLlmHostStatus,
  startLlmHostAction,
  type LlmHostActionJob,
  type LlmHostProfile,
  type LlmHostStatus,
} from "../../api/llmHostClient";

interface LlmHostPanelProps {
  sparkId: string;
  className?: string;
}

interface CrashLogEntry {
  node: string | null;
  file: string;
  bytes?: number;
}

type View =
  | { kind: "none" }
  | { kind: "journal"; text: string }
  | { kind: "crashlogs"; entries: CrashLogEntry[] }
  | { kind: "crashtail"; node: string | null; file: string; text: string };

const MONO =
  "font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all";

function fmtBytes(n?: number): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function mtimeLabel(mtime?: number): string {
  if (!mtime) return "";
  return new Date(mtime * 1000).toLocaleString();
}

/**
 * llm-host panel — what the /opt/llm-host subsystem on this Spark is serving
 * (loaded profile, engine readiness, cluster node health) plus the unit
 * journal and the per-rank crash logs a cluster launcher leaves behind.
 * Read-only by design: model switching stays an operator action on the box.
 * Everything loads on demand — nothing here polls.
 */
export function LlmHostPanel({ sparkId, className }: LlmHostPanelProps) {
  const [status, setStatus] = useState<LlmHostStatus | null>(null);
  const [present, setPresent] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>({ kind: "none" });

  const loadStatus = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchLlmHostStatus(sparkId);
      setPresent(res.present ?? false);
      setStatus(res.status ?? null);
      setError(res.ok ? null : res.error || "probe failed");
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  }, [sparkId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const profile = (status?.profile as string | undefined) ?? "";

  const showJournal = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchLlmHostLogs(sparkId, { profile, lines: 300 });
      if (!res.ok) throw new Error(res.error || "log fetch failed");
      setView({ kind: "journal", text: res.text ?? "" });
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  }, [sparkId, profile]);

  const showCrashLogs = useCallback(async () => {
    if (!profile) {
      setError("No profile loaded — crash-logs needs one");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetchLlmHostCrashLogs(sparkId, { profile, lines: 50 });
      if (!res.ok) throw new Error(res.error || "crash-log fetch failed");
      if (res.cliTooOld) {
        throw new Error("llm-host on this Spark has no crash-logs — upgrade llm-host");
      }
      const entries: CrashLogEntry[] = (res.nodes ?? []).flatMap((n) =>
        (n.files ?? []).map((f) => ({ node: n.node, file: f.file, bytes: f.bytes }))
      );
      setView({ kind: "crashlogs", entries });
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      setBusy(false);
    }
  }, [sparkId, profile]);

  const showCrashTail = useCallback(
    async (node: string | null, file: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetchLlmHostCrashLogTail(sparkId, {
          profile,
          node: node ?? undefined,
          file,
          lines: 400,
        });
        if (!res.ok) throw new Error(res.error || "crash-log fetch failed");
        setView({
          kind: "crashtail",
          node,
          file,
          text: (res.lines ?? []).join("\n"),
        });
      } catch (err) {
        setError(String((err as Error).message || err));
      } finally {
        setBusy(false);
      }
    },
    [sparkId, profile]
  );

  // ── Process management (Tier 2): switch/start/stop ──────────────────────
  const [action, setAction] = useState<LlmHostActionJob | null>(null);
  const [manageMode, setManageMode] = useState<"none" | "switch" | "start">("none");
  const [profiles, setProfiles] = useState<LlmHostProfile[] | null>(null);
  const [pickedProfile, setPickedProfile] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const refreshAfterAction = useCallback(() => {
    void loadStatus();
    setView({ kind: "none" });
  }, [loadStatus]);

  const pollAction = useCallback(async () => {
    try {
      const res = await fetchLlmHostAction(sparkId);
      const job = res.job ?? null;
      setAction(job);
      if (job && job.state !== "running") {
        refreshAfterAction();
      }
    } catch {
      // transient — the next poll retries
    }
  }, [sparkId, refreshAfterAction]);

  // Poll only while an action is in flight; one final fetch lands the result.
  useEffect(() => {
    if (!action || action.state !== "running") return;
    const t = setInterval(() => void pollAction(), 5000);
    return () => clearInterval(t);
  }, [action, pollAction]);

  const openManage = useCallback(async (mode: "switch" | "start") => {
    setManageMode(mode);
    setConfirmStop(false);
    setProfiles(null);
    try {
      const res = await fetchLlmHostProfiles(sparkId);
      if (!res.ok) throw new Error(res.error || "profile list failed");
      setProfiles(res.profiles ?? []);
    } catch (err) {
      setError(String((err as Error).message || err));
      setManageMode("none");
    }
  }, [sparkId]);

  const kick = useCallback(
    async (body: { action: "switch" | "start" | "stop"; profile?: string }) => {
      setActionBusy(true);
      setError(null);
      try {
        const res = await startLlmHostAction(sparkId, body);
        setAction(res.job);
        setManageMode("none");
        setConfirmStop(false);
      } catch (err) {
        setError(String((err as Error).message || err));
      } finally {
        setActionBusy(false);
      }
    },
    [sparkId]
  );

  const ready = status?.ready ?? false;
  const cluster = status?.cluster ?? [];
  const vram = status?.cluster_vram ?? [];
  const crosscheck = status?.crosscheck ?? "";
  const approved = Array.isArray(status?.descriptor?.approved_for)
    ? (status!.descriptor.approved_for as string[])
    : [];

  return (
    <Panel
      title="LLM Host"
      accent={!present || (!ready && present === true)}
      className={className}
      actions={
        <button
          type="button"
          onClick={() => void loadStatus()}
          disabled={busy}
          className="rounded border border-border px-2 py-0.5 text-[10px] text-muted hover:bg-surface-hover disabled:opacity-50"
        >
          {busy ? "…" : "Refresh"}
        </button>
      }
    >
      {present === false && (
        <p className="text-xs text-muted">
          No llm-host subsystem on this Spark (/opt/llm-host/llm-model not found).
        </p>
      )}
      {present === null && <p className="text-xs text-muted">Probing…</p>}
      {error && (
        <p className="mb-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-text">
          {error}
        </p>
      )}

      {status && (
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-muted">Profile</span>
            <span className="font-mono truncate" title={status.profile ?? ""}>
              {status.profile || "(none)"}
            </span>
            <span className="ml-auto chip py-0.5">
              {status.uptime ? `up ${status.uptime}` : status.unit_state || "—"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-muted">Engine</span>
            <span className="font-mono">{status.engine || "?"}</span>
            <span className="text-muted">:{status.port}</span>
            <span
              className={`ml-auto font-medium ${ready ? "text-accent" : "text-danger"}`}
            >
              {ready ? "ready" : "NOT ANSWERING"}
            </span>
          </div>
          {cluster.length > 0 && (
            <div className="flex items-start gap-2">
              <span className="w-20 shrink-0 text-muted">Cluster</span>
              <div className="min-w-0 flex-1 space-y-0.5">
                {cluster.map((n) => (
                  <div key={n.node} className="flex items-center gap-2 font-mono text-[11px]">
                    <span>{n.state === "running" ? "ok" : "!!"}</span>
                    <span className="truncate">{n.node}</span>
                    <span className="text-muted">{n.head ? "head" : "worker"}</span>
                    <span className="ml-auto text-muted">{n.state}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {vram
            .filter((v) => v.vram)
            .map((v) => {
              const free = (v.vram as { usable_mib?: number }).usable_mib;
              return (
                <div key={v.node} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-muted">VRAM</span>
                  <span className="font-mono">{v.node}</span>
                  <span className="ml-auto font-tabular">
                    {free != null ? `${(free / 1024).toFixed(1)} GiB usable` : "unknown"}
                  </span>
                </div>
              );
            })}
          {crosscheck === "MISMATCH" && (
            <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px]">
              MISMATCH: the descriptor and the engine disagree — something was
              started out of band (llm-model doctor).
            </p>
          )}
          <div className="flex items-center gap-2">
            <span className="w-20 shrink-0 text-muted">Approved</span>
            <span className="font-mono">{approved.length ? approved.join(", ") : "(none)"}</span>
          </div>
        </div>
      )}

      {status?.profile && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void showJournal()}
            disabled={busy}
            className="rounded border border-border px-2.5 py-1 text-[11px] text-text hover:border-accent disabled:opacity-50"
          >
            Journal
          </button>
          <button
            type="button"
            onClick={() => void showCrashLogs()}
            disabled={busy}
            className="rounded border border-border px-2.5 py-1 text-[11px] text-text hover:border-accent disabled:opacity-50"
          >
            Crash logs
          </button>
          {view.kind !== "none" && (
            <button
              type="button"
              onClick={() => setView({ kind: "none" })}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-muted hover:bg-surface-hover"
            >
              Hide
            </button>
          )}
        </div>
      )}

      {view.kind === "journal" && (
        <pre className={`${MONO} mt-3 max-h-96 overflow-auto rounded-md border border-border bg-surface-elevated p-3`}>
          {view.text}
        </pre>
      )}

      {view.kind === "crashlogs" && (
        <div className="mt-3 space-y-1">
          {view.entries.length === 0 && (
            <p className="text-xs text-muted">No crash logs recorded.</p>
          )}
          {view.entries.map((e) => (
            <button
              key={`${e.node ?? ""}/${e.file}`}
              type="button"
              onClick={() => void showCrashTail(e.node, e.file)}
              className="flex w-full items-center gap-2 rounded border border-border bg-surface-elevated px-3 py-1.5 text-left text-[11px] hover:border-accent"
            >
              <span className="text-muted">{e.node ?? "head"}</span>
              <span className="font-mono truncate">{e.file}</span>
              <span className="ml-auto shrink-0 text-muted">{fmtBytes(e.bytes)}</span>
            </button>
          ))}
        </div>
      )}

      {view.kind === "crashtail" && (
        <div className="mt-3">
          <p className="mb-1 text-[10px] text-muted">
            {view.node ?? "head"} · {view.file}
          </p>
          <pre
            className={`${MONO} max-h-96 overflow-auto rounded-md border border-border bg-surface-elevated p-3`}
          >
            {view.text}
          </pre>
        </div>
      )}

      {action && (
        <div
          className={`mt-3 rounded-md border px-3 py-2 text-[11px] ${
            action.state === "running"
              ? "border-border bg-surface-elevated"
              : action.state === "done"
                ? "border-accent/40 bg-accent/10"
                : "border-danger/40 bg-danger/10"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium">
              {action.action}
              {action.profile ? ` ${action.profile}` : ""}: {action.state}
            </span>
            {action.state === "running" && (
              <span className="text-muted">
                since {new Date(action.startedAt).toLocaleTimeString()} — a switch
                loads for minutes; this banner updates every 5 s
              </span>
            )}
            {action.state !== "running" && (
              <button
                type="button"
                onClick={() => setAction(null)}
                className="ml-auto text-muted hover:text-text"
              >
                dismiss
              </button>
            )}
          </div>
          {action.error && <p className="mt-1 text-danger">{action.error}</p>}
          {action.output && action.output.length > 0 && (
            <pre className={`${MONO} mt-1 max-h-40 overflow-auto`}>
              {action.output.join("\n")}
            </pre>
          )}
        </div>
      )}

      {status?.profile !== undefined && (
        <div className="mt-3 border-t border-border pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted">
              Manage
            </span>
            <button
              type="button"
              onClick={() => void openManage("switch")}
              disabled={busy || actionBusy || Boolean(action?.state === "running")}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-text hover:border-accent disabled:opacity-50"
            >
              Switch profile…
            </button>
            <button
              type="button"
              onClick={() => void openManage("start")}
              disabled={busy || actionBusy || Boolean(action?.state === "running")}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-text hover:border-accent disabled:opacity-50"
            >
              Start…
            </button>
            <button
              type="button"
              onClick={() => setConfirmStop(true)}
              disabled={busy || actionBusy || Boolean(action?.state === "running")}
              className="rounded border border-border px-2.5 py-1 text-[11px] text-text hover:border-danger disabled:opacity-50"
            >
              Stop
            </button>
          </div>

          {(manageMode === "switch" || manageMode === "start") && (
            <div className="mt-2 rounded-md border border-border bg-surface-elevated p-3">
              <p className="mb-2 text-[11px] text-muted">
                {manageMode === "switch"
                  ? "Switch stops the running model first, waits for the GPUs to drain, then loads the picked profile — minutes, not seconds. Anything routing to this box during the switch fails."
                  : "Start without stopping anything — guard.sh refuses if the GPUs are busy."}
              </p>
              {profiles === null ? (
                <p className="text-[11px] text-muted">Loading profiles…</p>
              ) : profiles.length === 0 ? (
                <p className="text-[11px] text-muted">No profiles installed.</p>
              ) : (
                <div className="mb-2 space-y-1">
                  {profiles.map((p) => (
                    <label
                      key={p.profile}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-surface-hover"
                    >
                      <input
                        type="radio"
                        name="llmhost-profile"
                        checked={pickedProfile === p.profile}
                        onChange={() => setPickedProfile(p.profile)}
                      />
                      <span className="font-mono">{p.profile}</span>
                      <span className="text-muted">{p.engine}</span>
                      {p.live && <span className="chip py-0.5">live</span>}
                      {(p.approved_for?.length ?? 0) > 0 && (
                        <span className="ml-auto text-muted">
                          {p.approved_for!.join(", ")}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!pickedProfile || actionBusy}
                  onClick={() =>
                    void kick({
                      action: manageMode,
                      profile: pickedProfile,
                    })
                  }
                  className="rounded bg-accent px-3 py-1 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  {manageMode === "switch" ? "Switch" : "Start"}
                </button>
                <button
                  type="button"
                  onClick={() => setManageMode("none")}
                  className="rounded border border-border px-3 py-1 text-[11px] text-muted hover:bg-surface-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {confirmStop && (
            <div className="mt-2 rounded-md border border-danger/40 bg-danger/10 p-3">
              <p className="mb-2 text-[11px]">
                Stop{" "}
                <span className="font-mono">{status?.profile || "the running model"}</span>
                ? Everything routing to this box fails until something is started again.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={actionBusy}
                  onClick={() => void kick({ action: "stop" })}
                  className="rounded bg-danger px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  Stop model
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmStop(false)}
                  className="rounded border border-border px-3 py-1 text-[11px] text-muted hover:bg-surface-hover"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
