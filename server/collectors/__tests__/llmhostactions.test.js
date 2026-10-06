import test from "node:test";
import assert from "node:assert/strict";
import {
  startLlmHostAction,
  getLlmHostAction,
  resetLlmHostActions,
} from "../LlmHostActions.js";
import { LlmHostProbe } from "../LlmHostProbe.js";

const SPARK = {
  id: "spark2",
  isLocal: false,
  lanIp: "192.168.1.7",
  ssh: { host: "192.168.1.7", user: "rmunn", auth: "key" },
};

/** Stub the probe's transport for every LlmHostProbe this test creates. */
function stubRun(handler) {
  const orig = LlmHostProbe.prototype._run;
  LlmHostProbe.prototype._run = handler;
  return () => {
    LlmHostProbe.prototype._run = orig;
  };
}

test("a switch runs to done and the job is pollable", async () => {
  resetLlmHostActions();
  const restore = stubRun(async (argv) => {
    assert.deepEqual(argv, ["switch", "qwen38-flash-next-tp1-262k"]);
    return "stopping… waiting for memory… ready";
  });
  try {
    const { job } = startLlmHostAction(SPARK, {
      action: "switch",
      profile: "qwen38-flash-next-tp1-262k",
    });
    assert.equal(job.state, "running");
    // let the runner settle
    await new Promise((r) => setTimeout(r, 20));
    const now = getLlmHostAction("spark2");
    assert.equal(now.state, "done");
    assert.match(now.output.join("\n"), /ready/);
  } finally {
    restore();
  }
});

test("a second action while one runs is rejected", async () => {
  resetLlmHostActions();
  const restore = stubRun(async () => {
    await new Promise((r) => setTimeout(r, 500));
    return "ok";
  });
  try {
    startLlmHostAction(SPARK, { action: "stop" });
    assert.throws(
      () => startLlmHostAction(SPARK, { action: "switch", profile: "p" }),
      /already running/
    );
  } finally {
    restore();
    resetLlmHostActions();
  }
});

test("unknown action and bad profile tokens are refused before any exec", () => {
  resetLlmHostActions();
  assert.throws(
    () => startLlmHostAction(SPARK, { action: "reboot" }),
    /Unknown action/
  );
  assert.throws(
    () => startLlmHostAction(SPARK, { action: "switch", profile: "p; rm -rf /" }),
    /Invalid llm-host profile/
  );
  assert.equal(getLlmHostAction("spark2"), null);
});

test("a missing llm-host install is a clean failure, not a crash", async () => {
  resetLlmHostActions();
  const restore = stubRun(async () => "__LLMHOST_MISSING__");
  try {
    startLlmHostAction(SPARK, { action: "stop" });
    await new Promise((r) => setTimeout(r, 20));
    const now = getLlmHostAction("spark2");
    assert.equal(now.state, "failed");
    assert.match(now.error, /not installed/);
  } finally {
    restore();
    resetLlmHostActions();
  }
});

test("an ssh failure marks the job failed with the reason", async () => {
  resetLlmHostActions();
  const restore = stubRun(async () => {
    throw new Error("SSH to 192.168.1.7 failed: connection refused");
  });
  try {
    startLlmHostAction(SPARK, { action: "switch", profile: "p" });
    await new Promise((r) => setTimeout(r, 20));
    const now = getLlmHostAction("spark2");
    assert.equal(now.state, "failed");
    assert.match(now.error, /connection refused/);
  } finally {
    restore();
    resetLlmHostActions();
  }
});
