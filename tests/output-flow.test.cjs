const test = require("node:test");
const assert = require("node:assert/strict");
const { createOutputFlow } = require("../src/main/output-flow.cjs");

function harness(sendResult = true) {
  const sent = [], pauses = [];
  const flow = createOutputFlow({ high: 16, low: 4, send: (m) => { sent.push(m); return sendResult; }, onPause: (paused) => pauses.push(paused) });
  flow.attach();
  const push = (id, value = "abcdefgh") => flow.output({ type: "pty:output", terminalId: id, data: value });
  return { flow, sent, pauses, push };
}

test("all terminals share a bounded parsing budget and ACKs release data in order", () => {
  const { flow, sent, pauses, push } = harness();
  push("a"); push("b"); push("a"); push("b");
  assert.equal(sent.length, 2);
  assert.deepEqual(pauses, [true]);
  flow.acknowledge(sent[1]);
  assert.equal(sent.length, 3);
  flow.acknowledge(sent[1]); // Duplicate ACK must not grant more credit.
  assert.equal(sent.length, 3);
  flow.acknowledge({ ...sent[0], deliveryId: 999 });
  assert.equal(sent.length, 3);
  flow.acknowledge(sent[0]);
  flow.acknowledge(sent[2]); flow.acknowledge(sent[3]);
  assert.deepEqual(sent.map((m) => m.terminalId), ["a", "b", "a", "b"]);
  assert.deepEqual(pauses, [true, false]);
});

test("socket backpressure waits for drain even after output is acknowledged", () => {
  const { flow, sent, pauses, push } = harness(false);
  push("a"); push("b");
  assert.equal(sent.length, 1);
  flow.acknowledge(sent[0]);
  assert.equal(sent.length, 1);
  flow.drain();
  assert.equal(sent.length, 2);
  assert.equal(pauses[0], true);
});

test("detach releases paused producers and stale connection ACKs cannot grant credit", () => {
  const { flow, sent, pauses, push } = harness();
  push("a"); push("a"); push("a");
  const old = sent[0];
  flow.detach();
  assert.deepEqual(pauses, [true, false]);
  push("a");
  assert.equal(sent.length, 2);
  flow.attach();
  push("a"); push("a"); push("a");
  flow.acknowledge({ ...old, deliveryId: sent[2].deliveryId });
  assert.equal(sent.length, 4);
  flow.acknowledge(sent[2]);
  assert.equal(sent.length, 5);
});

test("forget removes queued and in-flight data without stalling other terminals", () => {
  const { flow, sent, push } = harness();
  push("a"); push("a"); push("a"); push("b");
  flow.forget("a");
  assert.equal(sent.length, 3);
  assert.equal(sent.at(-1).terminalId, "b");
  flow.acknowledge(sent[0]);
  assert.equal(sent.length, 3);
});

test("the shared budget counts UTF-8 bytes and does not overfill a partial window", () => {
  const { flow, sent, pauses, push } = harness();
  push("a", "中中中"); push("b", "中中中");
  assert.equal(sent.length, 1);
  assert.deepEqual(pauses, [true]);
  flow.acknowledge(sent[0]);
  assert.equal(sent.length, 2);
  flow.acknowledge(sent[1]);
  assert.deepEqual(pauses, [true, false]);
});
