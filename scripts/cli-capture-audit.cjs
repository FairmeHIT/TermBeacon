#!/usr/bin/env node
/**
 * Summarize a cli-record JSONL capture without printing terminal text.
 * This is intentionally metadata-only so raw captures can be inspected
 * before deciding whether a sanitized fixture is safe to commit.
 */
const fs = require("node:fs");
const path = require("node:path");

function parseCapture(source) {
  const records = [];
  for (const [index, line] of String(source).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid JSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.kind !== "string") {
      throw new Error(`invalid capture record at line ${index + 1}`);
    }
    records.push(record);
  }
  return records;
}

function summarizeCapture(records, file = undefined) {
  const meta = records.find((record) => record.kind === "meta");
  const outputs = records.filter((record) => record.kind === "output");
  const inputs = records.filter((record) => record.kind === "input");
  const exits = records.filter((record) => record.kind === "exit");
  const errors = records.filter((record) => record.kind === "error");
  const timestamps = records.map((record) => record.at).filter((value) => Number.isFinite(value));
  const outputBytes = outputs.reduce((sum, record) => sum + Buffer.byteLength(String(record.data || ""), "utf8"), 0);
  const inputBytes = inputs.reduce((sum, record) => sum + Buffer.byteLength(String(record.data || ""), "utf8"), 0);
  const titleSignals = outputs.reduce((count, record) => {
    const data = String(record.data || "");
    return count + (data.match(/\u001b\][02];/g) || []).length;
  }, 0);
  const naturalExit = exits.some((record) => record.exitCode === 0 && !record.signal);
  const taskEvidence = inputs.some((record) => record.source === "task") || inputs.length > 0;
  const reviewReasons = [];
  if (!meta) reviewReasons.push("missing-meta");
  if (!taskEvidence) reviewReasons.push("no-input");
  if (!exits.length) reviewReasons.push("missing-exit");
  if (errors.length) reviewReasons.push("capture-error");
  if (exits.length && !naturalExit) reviewReasons.push("nonzero-exit");
  return {
    file: file ? path.resolve(file) : undefined,
    agent: typeof meta?.agent === "string" ? meta.agent : undefined,
    version: typeof meta?.version === "string" ? meta.version : undefined,
    commandPresent: typeof meta?.command === "string" && meta.command.length > 0,
    schemaVersion: Number.isInteger(meta?.schemaVersion) ? meta.schemaVersion : undefined,
    durationMs: timestamps.length ? Math.max(...timestamps) : 0,
    records: records.length,
    outputChunks: outputs.length,
    outputBytes,
    inputRecords: inputs.length,
    inputBytes,
    taskInputs: inputs.filter((record) => record.source === "task").length,
    titleSignals,
    exits: exits.map((record) => ({ exitCode: record.exitCode, signal: record.signal })),
    errors: errors.length,
    naturalExit,
    taskEvidence,
    fixtureEligible: Boolean(meta && taskEvidence && naturalExit && errors.length === 0),
    reviewReasons,
  };
}

function parseArgs(argv) {
  const args = { json: false, files: [] };
  for (const token of argv) {
    if (token === "--json") args.json = true;
    else if (!token.startsWith("--")) args.files.push(token);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.files.length) {
    console.error("Usage: node scripts/cli-capture-audit.cjs [--json] <capture.jsonl> [...]");
    process.exitCode = 1;
    return;
  }
  const summaries = args.files.map((file) => summarizeCapture(parseCapture(fs.readFileSync(file, "utf8")), file));
  if (args.json) console.log(JSON.stringify(summaries.length === 1 ? summaries[0] : summaries));
  else {
    for (const summary of summaries) {
      console.log(`[capture] ${summary.file}`);
      console.log(`- agent: ${summary.agent || "unknown"}${summary.version ? ` (${summary.version})` : ""}`);
      console.log(`- duration: ${summary.durationMs} ms; records: ${summary.records}`);
      console.log(`- output: ${summary.outputChunks} chunks / ${summary.outputBytes} bytes; OSC title signals: ${summary.titleSignals}`);
      console.log(`- input: ${summary.inputRecords} records / ${summary.inputBytes} bytes; auto tasks: ${summary.taskInputs}`);
      console.log(`- exits: ${summary.exits.length}; errors: ${summary.errors}`);
    }
  }
}

if (require.main === module) main();

module.exports = { parseCapture, summarizeCapture, parseArgs };
