/**
 * LlmHostActions — model process management for the llm-host subsystem:
 * switch / start / stop, run as a ONE-AT-A-TIME background job per Spark
 * and polled (the Hermes update pattern). A `switch` is a full model
 * replacement — stop the running instance, wait for VRAM to actually drain,
 * load, wait for the engine to answer — and takes minutes at minimum
 * (READY_TIMEOUT_SEC up to 7200 for first starts), so it can never be an
 * HTTP request/response.
 *
 * Deliberately thin over the `llm-model` CLI: guard.sh (VRAM fit), the
 * mutual-exclusion checks and the descriptor bookkeeping all live there, and
 * every safety rule this module would have to re-implement is already a
 * failure mode the CLI fails cleanly on. The dashboard adds: job state, an
 * output tail, and the UI confirmations.
 *
 * Concurrency: one action per Spark, enforced by a simple in-memory map —
 * llm-host itself is one-model-at-a-time per box, so queueing here would
 * only hide a race between two operators. A second action 409s instead.
 * Jobs live in memory: a dashboard restart loses the tail (the journal and
 * `llm-model status` still tell the truth).
 */

import { LlmHostProbe } from "./LlmHostProbe.js";

/** How long a model action may run: the instance drop-in's
 * TimeoutStartSec=7200 is the ceiling systemd itself enforces, so matching
 * it means this never gives up before systemd does. */
const ACTION_TIMEOUT_MS = Number(process.env.LLM_HOST_ACTION_TIMEOUT_MS) || 7_200_000;
/** How much CLI output to keep for the poll endpoint. */
const OUTPUT_TAIL_LINES = 200;

const RUNNING = new Map(); // sparkId -> job

const VALID_ACTIONS = new Set(["switch", "start", "stop"]);

function safeToken(value, what) {
  const v = String(value ?? "").trim();
  if (!v || !/^[A-Za-z0-9._-]+$/.test(v)) {
    throw new Error(`Invalid llm-host ${what}: ${JSON.stringify(String(value))}`);
  }
  return v;
}

function publicJob(job) {
  return {
    id: job.id,
    sparkId: job.sparkId,
    action: job.action,
    profile: job.profile,
    startedAt: job.startedAt,
    state: job.state,
    exitCode: job.exitCode,
    error: job.error,
    output: job.output,
  };
}

/**
 * Kick off a model action. Throws (caller maps to 4xx) when the spark
 * already has one running or the request is malformed.
 */
export function startLlmHostAction(spark, { action, profile }) {
  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`Unknown action '${action}' — switch | start | stop`);
  }
  if (action !== "stop") {
    profile = safeToken(profile, "profile");
  } else {
    profile = null; // stop targets whatever is running; llm-model resolves it
  }
  const existing = RUNNING.get(spark.id);
  if (existing && existing.state === "running") {
    const err = new Error(
      `An llm-host action is already running on this Spark ` +
      `(${existing.action}${existing.profile ? ` ${existing.profile}` : ""}) — ` +
      `wait for it or check GET /llmhost/action`
    );
    err.statusCode = 409;
    throw err;
  }

  const job = {
    id: `${Date.now()}-${action}`,
    sparkId: spark.id,
    action,
    profile,
    startedAt: new Date().toISOString(),
    state: "running",
    exitCode: null,
    error: null,
    output: [],
  };
  RUNNING.set(spark.id, job);

  const argv =
    action === "stop" ? ["stop"] : [action, profile];

  // The probe's transport (local execFile / guarded sshExec) with an action-
  // sized timeout; a missing CLI is a clean failure, not a crash.
  const probe = new LlmHostProbe(spark);
  const run = async () => {
    let out;
    try {
      out = await probe._run(argv, ACTION_TIMEOUT_MS);
    } catch (err) {
      job.state = "failed";
      job.error = String(err.message || err);
      return;
    }
    const text = String(out).trim();
    if (text === "__LLMHOST_MISSING__") {
      job.state = "failed";
      job.error = "llm-host is not installed on this Spark (/opt/llm-host/llm-model missing)";
      return;
    }
    job.output = text.splitlines ? text.splitlines() : text.split("\n");
    job.output = job.output.slice(-OUTPUT_TAIL_LINES);
    // The CLI exits non-zero on a refused/failed action; sshExec already
    // rejected those above, so reaching here with output means success.
    job.state = "done";
    job.exitCode = 0;
  };
  void run();
  return { job: publicJob(job) };
}

/** Current/last action for a Spark, or null. */
export function getLlmHostAction(sparkId) {
  const job = RUNNING.get(sparkId);
  return job ? publicJob(job) : null;
}

/** Test seam: forget all jobs. */
export function resetLlmHostActions() {
  RUNNING.clear();
}
