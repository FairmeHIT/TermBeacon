#!/usr/bin/env node
/**
 * Convert an already reviewed cli-record capture into a detector fixture.
 * The input must be explicitly marked as sanitized. Environment metadata is
 * discarded and user input is redacted by default before writing the fixture.
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseCapture } = require("./cli-capture-audit.cjs");

const AGENTS = new Set(["generic", "opencode", "codex", "claude"]);
const STATES = new Set(["working", "completed-unseen", "ready", "awaiting-input", "error", "stopped"]);

function parseArgs(argv) {
  const args = { sanitized: false, keepInput: false, input: undefined, output: undefined, agent: undefined, name: undefined, description: undefined, version: undefined, expected: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--sanitized") args.sanitized = true;
    else if (token === "--keep-input") args.keepInput = true;
    else if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
      if (key === "input") args.input = value;
      else if (key === "output") args.output = value;
      else if (key === "agent") args.agent = value;
      else if (key === "name") args.name = value;
      else if (key === "description") args.description = value;
      else if (key === "version") args.version = value;
      else if (key === "expected") args.expected = value;
      else throw new Error(`unknown option: --${key}`);
    }
  }
  return args;
}

function sanitizeMeta(meta, args) {
  return {
    kind: "meta",
    agent: args.agent || meta.agent,
    ...(args.version || meta.version ? { version: args.version || meta.version } : {}),
    name: args.name || meta.name || "sanitized-capture",
    description: args.description || meta.description || "Sanitized real CLI capture",
  };
}

function toFixture(records, options) {
  if (!options.sanitized) throw new Error("refusing to convert an unreviewed capture; pass --sanitized after manual review");
  const meta = records.find((record) => record.kind === "meta");
  if (!meta || typeof meta.agent !== "string") throw new Error("capture is missing meta.agent");
  const agent = options.agent || meta.agent;
  if (!AGENTS.has(agent)) throw new Error(`unsupported agent: ${agent}`);
  if (!STATES.has(options.expected)) throw new Error(`expected state must be one of: ${[...STATES].join(", ")}`);

  const redactedInput = "[task]\r";
  const fixture = [sanitizeMeta(meta, { ...options, agent })];
  for (const record of records) {
    if (record.kind === "output" || record.kind === "tick" || record.kind === "hook") {
      fixture.push(record);
    } else if (record.kind === "input") {
      fixture.push({
        kind: "input",
        data: options.keepInput ? String(record.data || "") : redactedInput,
        ...(Number.isFinite(record.at) ? { at: record.at } : {}),
      });
    }
  }
  fixture.push({ kind: "assert", state: options.expected });
  return fixture;
}

function writeFixture(input, output, options) {
  if (path.resolve(input) === path.resolve(output)) throw new Error("input and output must be different files");
  const records = parseCapture(fs.readFileSync(input, "utf8"));
  const fixture = toFixture(records, options);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, `${fixture.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return { input: path.resolve(input), output: path.resolve(output), records: fixture.length, agent: fixture[0].agent, expected: options.expected };
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (!args.input || !args.output || !args.expected) throw new Error("usage: --sanitized --input <capture.jsonl> --output <fixture.jsonl> --expected <state>");
    const result = writeFixture(args.input, args.output, args);
    console.log(`[fixture] wrote ${result.output} (${result.records} records; ${result.agent} -> ${result.expected})`);
  } catch (error) {
    console.error(`[fixture] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, sanitizeMeta, toFixture, writeFixture };
