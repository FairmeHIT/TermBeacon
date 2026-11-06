#!/usr/bin/env node
/**
 * Create (or verify) a TermBeacon GitHub Release from a finished `npm run dist`.
 *
 *   node .opencode/skills/release/scripts/create-release.mjs \
 *     --version 0.1.9 --notes-file .release-notes.md --verify-download
 *
 *   --version <x.y.z>   Release version; the tag is v<version> (required)
 *   --notes-file <path> Markdown body for the release
 *   --repo <owner/name> Override repository (default: parsed from origin)
 *   --dry-run           Validate everything locally, change nothing remotely
 *   --verify-only       Only report the state of an existing release
 *   --verify-download   Re-download the uploaded exe and compare sha512
 *   --help              Show usage
 *
 * Requires: `npm run dist` artifacts in release/. Uses GH_TOKEN or
 * GITHUB_TOKEN when present, otherwise falls back to `git credential fill`
 * (GCM) so no `gh` CLI is needed. Idempotent: re-running reuses an existing
 * release and skips assets that are already uploaded with the same size.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

function usage() {
  console.log(`Usage: node create-release.mjs --version <x.y.z> [options]

  --version <x.y.z>    Release version (required); tag becomes v<version>
  --notes-file <path>  Markdown body for the release
  --repo <owner/name>  Repository (default: parsed from git origin)
  --dry-run            Validate locally, do not touch GitHub
  --verify-only        Report the existing release without creating anything
  --verify-download    Re-download the uploaded exe and compare sha512
  --help               Show this message`);
}

function parseArgs(argv) {
  const args = { version: undefined, notesFile: undefined, repo: undefined, dryRun: false, verifyOnly: false, verifyDownload: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--dry-run") args.dryRun = true;
    else if (token === "--verify-only") args.verifyOnly = true;
    else if (token === "--verify-download") args.verifyDownload = true;
    else if (token === "--version") args.version = argv[++index];
    else if (token === "--notes-file") args.notesFile = argv[++index];
    else if (token === "--repo") args.repo = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

/** Minimal parser for electron-builder's latest.yml (flat, stable shape). */
function parseLatestYml(text) {
  const version = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const path = /^path:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const totalSha = /^sha512:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const files = [];
  const block = /files:\n((?:\s+- url:.*\n(?:\s{4}\S+:.*\n?)*)*)/.exec(text)?.[1] ?? "";
  for (const chunk of block.split(/\n\s*- /).filter(Boolean)) {
    const url = /url:\s*(.+)/.exec(chunk)?.[1]?.trim();
    const sha512 = /sha512:\s*(.+)/.exec(chunk)?.[1]?.trim();
    const size = Number(/size:\s*(\d+)/.exec(chunk)?.[1]);
    if (url) files.push({ url: url.replace(/^['"]|['"]$/g, ""), sha512, size });
  }
  return { version, path: path?.replace(/^['"]|['"]$/g, ""), sha512: totalSha, files };
}

function sha512File(filePath) {
  const hash = createHash("sha512");
  const buffer = readFileSync(filePath);
  hash.update(buffer);
  return hash.digest("base64");
}

function detectRepo() {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const match = /github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(remote);
    if (match) return `${match[1]}/${match[2]}`;
  } catch { /* fall through */ }
  return "FairmeHIT/TermBeacon";
}

function tokenFromGitCredential() {
  const out = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const match = /password=(.+)/.exec(out);
  if (!match) throw new Error("git credential did not return a password");
  return match[1].trim();
}

function authToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv.trim();
  return tokenFromGitCredential();
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Retry only connection-level failures; API errors are surfaced immediately. */
async function ghFetch(url, options, { attempts = 4 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status >= 500 && attempt < attempts) {
        lastError = new Error(`server ${response.status}`);
        await sleep(1500 * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1500 * attempt);
    }
  }
  throw new Error(`${url} failed after ${attempts} attempts: ${lastError?.cause?.message || lastError?.message}`);
}

async function getRelease(headers, repo, tag) {
  const response = await ghFetch(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET release ${response.status}: ${await response.text()}`);
  return response.json();
}

async function createRelease(headers, repo, payload) {
  const response = await ghFetch(`${API}/repos/${repo}/releases`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 422) {
      throw new Error(`create release 422: ${JSON.stringify(body)}\nHint: the tag must exist on the remote first — git push origin ${payload.tag_name}`);
    }
    throw new Error(`create release ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function uploadAsset(headers, repo, releaseId, filePath, existing) {
  const name = filePath.split(/[\\/]/).pop();
  const size = statSync(filePath).size;
  const already = existing.find((asset) => asset.name === name);
  if (already && already.size === size) {
    console.log(`  skip   ${name} (already uploaded, ${size} B)`);
    return already;
  }
  if (already) {
    console.log(`  replace ${name} (size differs: ${already.size} -> ${size})`);
    const deleted = await ghFetch(`${API}/repos/${repo}/releases/assets/${already.id}`, { method: "DELETE", headers });
    if (!deleted.ok && deleted.status !== 404 && deleted.status !== 204) {
      throw new Error(`delete stale asset ${name} ${deleted.status}: ${await deleted.text()}`);
    }
  }
  const response = await ghFetch(
    `${UPLOADS}/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(size) },
      body: createReadStream(filePath),
      duplex: "half",
    },
    { attempts: 2 },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(`upload ${name} ${response.status}: ${JSON.stringify(body)}`);
  console.log(`  uploaded ${name} (${body.size} B)`);
  return body;
}

async function downloadAndVerify(headers, repo, asset, expectedSha512) {
  console.log(`  downloading ${asset.name} (${asset.size} B) for verification...`);
  const response = await ghFetch(asset.url, { headers: { ...headers, Accept: "application/octet-stream" } }, { attempts: 3 });
  if (!response.ok) throw new Error(`download ${asset.name} ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha512").update(buffer).digest("base64");
  if (actual !== expectedSha512) throw new Error(`sha512 mismatch for ${asset.name}: ${actual} != ${expectedSha512}`);
  console.log(`  verified ${asset.name}: sha512 matches (${actual.slice(0, 16)}...)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  if (!args.version) { usage(); process.exitCode = 1; return; }

  const version = args.version.replace(/^v/, "");
  const tag = `v${version}`;
  const repo = args.repo || detectRepo();
  const root = process.cwd();
  const releaseDir = resolve(root, "release");

  console.log(`[release] ${repo} ${tag}`);

  // ---- 1. Local artifact validation -------------------------------------
  const latestPath = resolve(releaseDir, "latest.yml");
  if (!existsSync(latestPath)) throw new Error(`missing ${latestPath} — run "npm run dist" first`);
  const latest = parseLatestYml(readFileSync(latestPath, "utf8"));
  if (latest.version !== version) {
    throw new Error(`release/latest.yml says version ${latest.version}, but --version is ${version}. Rebuild with the new package.json version.`);
  }

  const fileNames = latest.files.map((file) => file.url).filter(Boolean);
  if (fileNames.length === 0) throw new Error("latest.yml lists no files");

  const assets = [];
  for (const file of latest.files) {
    const filePath = resolve(releaseDir, file.url);
    if (!existsSync(filePath)) throw new Error(`missing artifact ${filePath}`);
    const actual = sha512File(filePath);
    if (file.sha512 && actual !== file.sha512) throw new Error(`sha512 mismatch for ${file.url}: ${actual} != ${file.sha512}`);
    if (file.size && statSync(filePath).size !== file.size) throw new Error(`size mismatch for ${file.url}`);
    assets.push(filePath);
    console.log(`  ok ${file.url} (${statSync(filePath).size} B, sha512 matches latest.yml)`);
    // electron-builder writes the blockmap next to each installable; the
    // updater uses it for differential downloads, so publish it as well.
    const blockmap = `${filePath}.blockmap`;
    if (existsSync(blockmap)) {
      assets.push(blockmap);
      console.log(`  ok ${file.url}.blockmap`);
    }
  }
  // latest.yml itself is part of the updater contract and must be published.
  assets.push(latestPath);
  console.log("  ok latest.yml");

  if (args.dryRun) {
    console.log("[release] dry run: would upload");
    for (const asset of assets) console.log(`  - ${asset}`);
    return;
  }

  const headers = {
    Authorization: `Bearer ${authToken()}`,
    "User-Agent": "termbeacon-release",
    Accept: "application/vnd.github+json",
  };

  // ---- 2. Existing release ----------------------------------------------
  let release = await getRelease(headers, repo, tag);
  if (args.verifyOnly) {
    if (!release) throw new Error(`release ${tag} does not exist`);
    console.log(`[release] ${release.html_url} (draft=${release.draft}, prerelease=${release.prerelease})`);
    for (const asset of release.assets) console.log(`  - ${asset.name} (${asset.size} B, ${asset.state})`);
    if (args.verifyDownload) {
      const exe = release.assets.find((asset) => latest.files.some((file) => file.url === asset.name));
      if (exe) await downloadAndVerify(headers, repo, exe, latest.files.find((file) => file.url === exe.name).sha512);
    }
    return;
  }

  // ---- 3. Create or reuse ------------------------------------------------
  const notes = args.notesFile && existsSync(args.notesFile) ? readFileSync(args.notesFile, "utf8") : undefined;
  if (!release) {
    release = await createRelease(headers, repo, {
      tag_name: tag,
      name: version,
      ...(notes ? { body: notes } : {}),
      draft: false,
      prerelease: false,
    });
    console.log(`[release] created ${release.html_url}`);
  } else {
    console.log(`[release] reusing ${release.html_url}`);
    if (notes && release.body !== notes) {
      const response = await ghFetch(`${API}/repos/${repo}/releases/${release.id}`, {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body: notes }),
      });
      if (!response.ok) throw new Error(`update release ${response.status}: ${await response.text()}`);
      console.log("[release] release notes updated");
    }
  }

  // ---- 4. Upload ---------------------------------------------------------
  for (const assetPath of assets) {
    await uploadAsset(headers, repo, release.id, assetPath, release.assets);
  }

  // ---- 5. Report ---------------------------------------------------------
  const final = await getRelease(headers, repo, tag);
  console.log(`[release] done: ${final.html_url}`);
  for (const asset of final.assets) console.log(`  - ${asset.name} (${asset.size} B, ${asset.state})`);

  if (args.verifyDownload) {
    const exe = final.assets.find((asset) => latest.files.some((file) => file.url === asset.name));
    if (exe) await downloadAndVerify(headers, repo, exe, latest.files.find((file) => file.url === exe.name).sha512);
  }

  const latestCheck = await ghFetch(`${API}/repos/${repo}/releases/latest`, { headers });
  if (latestCheck.ok) {
    const latestRelease = await latestCheck.json();
    if (latestRelease.tag_name === tag) console.log("[release] this is the repository's latest release (used by electron-updater)");
    else console.warn(`[release] warning: GitHub reports ${latestRelease.tag_name} as latest, not ${tag}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { parseLatestYml, parseArgs, sha512File };