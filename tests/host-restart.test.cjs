const test = require("node:test");
const assert = require("node:assert/strict");
const { restartDelay, planRestart, DEFAULT_POLICY } = require("../src/main/host-restart.cjs");

test("restart delay doubles and caps", () => {
  assert.equal(restartDelay(0), 250);
  assert.equal(restartDelay(1), 500);
  assert.equal(restartDelay(3), 2000);
  assert.equal(restartDelay(10), DEFAULT_POLICY.maxMs);
});

test("a stable host gets a fresh retry budget", () => {
  const plan = planRestart({ attempts: 4, uptimeMs: DEFAULT_POLICY.stableMs });
  assert.deepEqual(plan, { attempts: 1, delayMs: 250, giveUp: false });
});

test("rapid crashes back off and eventually give up", () => {
  let attempts = 0;
  const delays = [];
  for (let index = 0; index < DEFAULT_POLICY.maxAttempts; index += 1) {
    const plan = planRestart({ attempts, uptimeMs: 500 });
    assert.equal(plan.giveUp, false);
    attempts = plan.attempts;
    delays.push(plan.delayMs);
  }
  assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 8000]);
  const final = planRestart({ attempts, uptimeMs: 500 });
  assert.equal(final.giveUp, true);
  assert.equal(final.delayMs, 0);
});

test("malformed attempts are treated as zero", () => {
  assert.deepEqual(planRestart({ attempts: Number.NaN, uptimeMs: Number.NaN }), {
    attempts: 1,
    delayMs: 250,
    giveUp: false,
  });
});
