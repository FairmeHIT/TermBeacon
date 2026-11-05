const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createDetector } = require("../src/main/detection-engine.cjs");

const fixtureDir = path.join(__dirname, "fixtures", "agents");
const fixtureFiles = fs.readdirSync(fixtureDir).filter((file) => file.endsWith(".jsonl")).sort();

for (const file of fixtureFiles) {
  test(`fixture: ${file}`, () => {
    const records = fs.readFileSync(path.join(fixtureDir, file), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const meta = records.find((record) => record.kind === "meta");
    const expected = records.find((record) => record.kind === "assert");
    const updates = [];
    const detector = createDetector(meta.agent, (update) => updates.push(update));

    for (const record of records) {
      if (record.kind === "input") detector.input(record.data);
      if (record.kind === "output") detector.output(record.data, record.at);
      if (record.kind === "tick") detector.tick(record.at);
      if (record.kind === "hook") detector.hook(record.event, record.status);
    }

    assert.equal(updates.at(-1)?.current, expected.state);
  });
}

