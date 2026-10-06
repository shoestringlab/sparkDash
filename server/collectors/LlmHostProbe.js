/**
 * LlmHostProbe — reads the llm-host subsystem (/opt/llm-host) on a Spark:
 * what llm-model@ instance is loaded, is the engine ready, is the cluster
 * whole, and the per-rank crash logs a cluster launcher leaves behind.
 *
 * Works for local hosts and remote hosts (SSH via sshExec) — the same split
 * HermesProbe uses, minus the setpriv dance: llm-host only ever READS here
 * (descriptor, journal, crash-log gz files are all world- or user-readable
 * and nothing is written), so the container's root is not an identity
 * problem. Mutations (switch/start/stop) deliberately have no path here yet.
 *
 * Everything runs through the `llm-model` CLI rather than poking files
 * directly: the CLI already resolves the running instance, the profile's
 * port, cross-checks descriptor vs engine, and — for `crash-logs --node` —
 * reaches the worker over the cluster's own SSH config, which the dashboard
 * cannot replicate for a spark1 blackholed from everywhere but the head.
 * `llm-model status --json` is a documented machine-readable surface; the
 * parsers below only re-shape its output.
 *
 * `crash-logs` needs llm-host >= the CRASH_LOG_GLOB addition (2026-10-06).
 * An older CLI answers `unrecognized arguments` → surfaced as
 * { ok: false, cliTooOld: true } so the UI can say "upgrade llm-host"
 * instead of "no crash logs".
 */

import { execFile } from "child_process";
import { sshExec } from "./ssh.js";

export const LLMHOST_MISSING = "__LLMHOST_MISSING__";
const CLI_PATH = process.env.LLM_HOST_CLI || "/opt/llm-host/llm-model";
const STATUS_TIMEOUT_MS = 25000; // status --json probes the engine + both nodes' VRAM
const LOG_TIMEOUT_MS = 30000; // journalctl + a remote zcat round-trip

/** Characters allowed in profile / node / file tokens passed to the remote
 * shell. Everything the CLI would take positionally is whitelisted rather
 * than quoted: a token that needs anything else is not a token llm-host
 * minted (its own names are [a-z0-9._-] and launcher timestamps). */
function safeToken(value, what) {
  const v = String(value ?? "").trim();
  if (!v || !/^[A-Za-z0-9._-]+$/.test(v)) {
    throw new Error(`Invalid llm-host ${what}: ${JSON.stringify(String(value))}`);
  }
  return v;
}

function clampLines(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * One class per Spark so tests can stub `_run` with canned CLI output.
 * `_run` receives the CLI argv (WITHOUT the program path) and resolves it
 * locally (execFile) or remotely (sshExec through a guarded one-liner that
 * reports a missing install as LLMHOST_MISSING instead of a shell error).
 */
export class LlmHostProbe {
  constructor(spark) {
    this.spark = spark;
  }

  async _run(cliArgs, timeoutMs) {
    if (this.spark?.isLocal) {
      return await this._runLocal(cliArgs, timeoutMs);
    }
    const quoted = cliArgs.map((a) => `'${String(a).replaceAll("'", "")}'`).join(" ");
    const cmd =
      `if [ -x ${CLI_PATH} ]; then ${CLI_PATH} ${quoted}; ` +
      `else echo ${LLMHOST_MISSING}; fi`;
    return await sshExec(this.spark, cmd, { timeoutMs });
  }

  _runLocal(cliArgs, timeoutMs) {
    return new Promise((resolve, reject) => {
      execFile(
        CLI_PATH,
        cliArgs,
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => {
          if (err && err.code === "ENOENT") {
            resolve(LLMHOST_MISSING);
          } else if (err) {
            reject(new Error(`llm-model failed: ${err.message}`));
          } else {
            resolve(String(stdout));
          }
        }
      );
    });
  }

  /** What is loaded, is it ready, is the cluster whole. */
  async status() {
    let out;
    try {
      out = await this._run(["status", "--json"], STATUS_TIMEOUT_MS);
    } catch (err) {
      return { ok: false, present: true, error: String(err.message || err) };
    }
    const trimmed = String(out).trim();
    if (trimmed === LLMHOST_MISSING || trimmed === "") {
      return { ok: true, present: false };
    }
    try {
      return { ok: true, present: true, status: JSON.parse(trimmed) };
    } catch {
      return { ok: false, present: true, error: "unparseable llm-model status output" };
    }
  }

  /** journalctl tail for the running (or named) instance. */
  async journal({ profile, lines = 200 } = {}) {
    const argv = ["logs"];
    if (profile) argv.push(safeToken(profile, "profile"));
    argv.push("-n", String(clampLines(lines, 200, 2000)));
    try {
      const out = await this._run(argv, LOG_TIMEOUT_MS);
      if (String(out).trim() === LLMHOST_MISSING) {
        return { ok: true, present: false };
      }
      return { ok: true, present: true, text: String(out) };
    } catch (err) {
      return { ok: false, present: true, error: String(err.message || err) };
    }
  }

  /**
   * Crash-log index for ONE node of the cluster (the head lists its own
   * files; a worker's rank logs live on the worker and `crash-logs --node`
   * forwards there). Callers iterate descriptor.nodes.
   */
  async crashLogList({ profile, node, lines = 50 } = {}) {
    if (!profile) {
      return { ok: false, error: "profile required for crash-logs" };
    }
    const argv = ["crash-logs", "list", "--profile", safeToken(profile, "profile")];
    if (node) argv.push("--node", safeToken(node, "node"));
    argv.push("-n", String(clampLines(lines, 50, 500)), "--json");
    let out;
    try {
      out = await this._run(argv, LOG_TIMEOUT_MS);
    } catch (err) {
      const msg = String(err.message || err);
      return {
        ok: false,
        cliTooOld: /unrecognized arguments/.test(msg) && /crash-logs/.test(msg),
        error: msg,
      };
    }
    const trimmed = String(out).trim();
    if (trimmed === LLMHOST_MISSING) return { ok: true, present: false };
    if (/unrecognized arguments/.test(trimmed) || /invalid choice/.test(trimmed)) {
      return { ok: false, cliTooOld: true, error: "llm-model has no crash-logs" };
    }
    try {
      const files = JSON.parse(trimmed);
      return {
        ok: true,
        files: Array.isArray(files)
          ? files.filter((f) => f && typeof f.file === "string")
          : [],
      };
    } catch {
      return { ok: false, error: "unparseable crash-logs output" };
    }
  }

  /** Tail one crash-log by its basename (resolved per node by the CLI). */
  async crashLogTail({ profile, node, file, lines = 200 } = {}) {
    const safeFile = safeToken(file, "file");
    const argv = [
      "crash-logs",
      "tail",
      safeFile,
      "--profile",
      safeToken(profile, "profile"),
    ];
    if (node) argv.push("--node", safeToken(node, "node"));
    argv.push("-n", String(clampLines(lines, 200, 5000)), "--json");
    let out;
    try {
      out = await this._run(argv, LOG_TIMEOUT_MS);
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    const trimmed = String(out).trim();
    if (trimmed === LLMHOST_MISSING) return { ok: true, present: false };
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || !Array.isArray(parsed.lines)) {
        return { ok: false, error: "unexpected crash-logs tail shape" };
      }
      return { ok: true, file: parsed.file, lines: parsed.lines };
    } catch {
      return { ok: false, error: "unparseable crash-logs tail output" };
    }
  }
}

/** Convenience wrapper: one-shot probe for route handlers. */
export function llmHostProbeFor(spark) {
  return new LlmHostProbe(spark);
}
