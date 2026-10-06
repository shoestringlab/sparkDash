import test from "node:test";
import assert from "node:assert/strict";
import { LlmHostProbe } from "../LlmHostProbe.js";

const STATUS_JSON = JSON.stringify({
  host: "spark2",
  profile: "glm53-flash-exl3-tensorfold-cluster-1m",
  unit_state: "active",
  uptime: "2h 26m",
  engine: "cluster",
  port: 8890,
  ready: true,
  served_ids: ["GLM-5.3-Flash-EXL3"],
  crosscheck: "ok",
  cluster: [
    { node: "spark2.lan", container: "glm53-flash-tf", state: "running", head: true },
    { node: "spark1.lan", container: "glm53-flash-tf", state: "running", head: false },
  ],
  cluster_vram: [],
  descriptor: { loaded: true, served_model_name: "GLM-5.3-Flash-EXL3" },
});

const CRASH_LIST_JSON = JSON.stringify([
  {
    file: "20261006-052403-rank0.log.gz",
    path: "/home/rmunn/.cache/tensorfold-glm53/logs/20261006-052403-rank0.log.gz",
    mtime: 1791289443,
    bytes: 3724,
  },
]);

/** A probe whose _run returns a canned CLI output. */
function probeReturning(out) {
  const probe = new LlmHostProbe({
    isLocal: false,
    lanIp: "192.168.1.7",
    ssh: { host: "192.168.1.7", user: "rmunn", auth: "key" },
  });
  probe._run = async () => out;
  return probe;
}

function probeThrowing(err) {
  const probe = new LlmHostProbe({
    isLocal: false,
    lanIp: "192.168.1.7",
    ssh: { host: "192.168.1.7", user: "rmunn", auth: "key" },
  });
  probe._run = async () => {
    throw err;
  };
  return probe;
}

test("status parses llm-model's machine-readable output", async () => {
  const res = await probeReturning(STATUS_JSON).status();
  assert.equal(res.ok, true);
  assert.equal(res.present, true);
  assert.equal(res.status.profile, "glm53-flash-exl3-tensorfold-cluster-1m");
  assert.equal(res.status.ready, true);
  assert.equal(res.status.cluster.length, 2);
});

test("status: CLI not installed is present:false, not an error", async () => {
  const res = await probeReturning("__LLMHOST_MISSING__").status();
  assert.equal(res.ok, true);
  assert.equal(res.present, false);
});

test("status: unreachable spark surfaces the ssh error", async () => {
  const res = await probeThrowing(new Error("SSH to 192.168.1.7 failed: timeout")).status();
  assert.equal(res.ok, false);
  assert.match(res.error, /SSH to/);
});

test("status: garbage output is an error, never a fake state", async () => {
  const res = await probeReturning("<html>login</html>").status();
  assert.equal(res.ok, false);
  assert.match(res.error, /unparseable/);
});

test("journal passes the profile and returns text", async () => {
  const probe = probeReturning("Oct 06 09:41:59 serve.sh: serving GLM");
  const res = await probe.journal({ profile: "glm53-flash-exl3-tensorfold-cluster-1m" });
  assert.equal(res.ok, true);
  assert.match(res.text, /serving GLM/);
});

test("crash-log list parses the index and filters junk entries", async () => {
  const res = await probeReturning(CRASH_LIST_JSON).crashLogList({
    profile: "glm53-flash-exl3-tensorfold-cluster-1m",
  });
  assert.equal(res.ok, true);
  assert.equal(res.files.length, 1);
  assert.equal(res.files[0].file, "20261006-052403-rank0.log.gz");
});

test("crash-log list: an old llm-model is flagged cliTooOld, not silently empty", async () => {
  const res = await probeReturning(
    "usage: llm-model [-h] ... error: unrecognized arguments: --json"
  ).crashLogList({ profile: "p" });
  assert.equal(res.ok, false);
  assert.equal(res.cliTooOld, true);
});

test("crash-log tail returns the gz-decoded lines", async () => {
  const res = await probeReturning(
    JSON.stringify({ file: "20261006-052404-rank1.log.gz", lines: ["a", "b"] })
  ).crashLogTail({
    profile: "glm53-flash-exl3-tensorfold-cluster-1m",
    file: "20261006-052404-rank1.log.gz",
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.lines, ["a", "b"]);
});

test("tokens with shell metacharacters are refused before any exec", async () => {
  const probe = new LlmHostProbe({
    isLocal: false,
    lanIp: "192.168.1.7",
    ssh: { host: "192.168.1.7", user: "rmunn", auth: "key" },
  });
  await assert.rejects(
    () =>
      probe.crashLogTail({
        profile: "p",
        file: "x; rm -rf /",
      }),
    /Invalid llm-host file/
  );
  await assert.rejects(
    () => probe.crashLogList({ profile: "p; reboot" }),
    /Invalid llm-host profile/
  );
});
