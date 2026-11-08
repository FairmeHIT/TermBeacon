#!/usr/bin/env node
/**
 * Create (or verify) a TermBeacon GitHub Release from a finished `npm run dist`.
 *
 *   node scripts/create-release.mjs \
 *     --version 0.1.9 --notes-file .release-notes.md --verify-download
 *
 *   --version <x.y.z>   Release version; defaults to package.json; tag is v<version>
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
 * release and skips only assets whose content hash matches. New releases stay
 * draft until all assets and the updater manifest have been verified.
 */
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseLatestYml, sha512File, validateReleaseArtifacts } from "./release-artifacts.mjs";

const API = "https://api.github.com";
const UPLOADS = "https://uploads.github.com";

function usage() {
  console.log(`Usage: node scripts/create-release.mjs [--version <x.y.z>] [options]

  --version <x.y.z>    Release version (default: package.json); tag becomes v<version>
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
    else if (["--version", "--notes-file", "--repo"].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
      args[{ "--version": "version", "--notes-file": "notesFile", "--repo": "repo" }[token]] = value;
    }
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
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
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(300000) });
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

async function uploadAsset(headers, repo, releaseId, filePath, existing, allowReplace) {
  const name = filePath.split(/[\\/]/).pop();
  const size = statSync(filePath).size;
  const already = existing.find((asset) => asset.name === name);
  const localDigest = `sha256:${createHash("sha256").update(readFileSync(filePath)).digest("hex")}`;
  let same = already?.state === "uploaded" && already.size === size && already.digest === localDigest;
  if (already?.state === "uploaded" && already.size === size && !already.digest) {
    const response = await ghFetch(`${already.url}?verify=${Date.now()}`, { headers: { ...headers, Accept: "application/octet-stream" } });
    if (!response.ok) throw new Error(`read existing asset ${name}: ${response.status}`);
    same = createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex") === localDigest.slice(7);
  }
  if (same) {
    console.log(`  skip   ${name} (already uploaded, ${size} B)`);
    return already;
  }
  if (already) {
    if (!allowReplace) throw new Error(`Published asset ${name} differs. Publish a new version instead of replacing it.`);
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
      body: readFileSync(filePath),
    },
    { attempts: 2 },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(`upload ${name} ${response.status}: ${JSON.stringify(body)}`);
  console.log(`  uploaded ${name} (${body.size} B)`);
  return body;
}

async function downloadAndVerify(headers, asset, expectedSha512) {
  console.log(`  downloading ${asset.name} (${asset.size} B) for verification...`);
  const response = await ghFetch(`${asset.url}?verify=${Date.now()}`, { headers: { ...headers, Accept: "application/octet-stream" } }, { attempts: 3 });
  if (!response.ok) throw new Error(`download ${asset.name} ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha512").update(buffer).digest("base64");
  if (actual !== expectedSha512) throw new Error(`sha512 mismatch for ${asset.name}: ${actual} != ${expectedSha512}`);
  console.log(`  verified ${asset.name}: sha512 matches (${actual.slice(0, 16)}...)`);
}

async function verifyRemoteAssets(headers, release, localFiles, verifyDownload) {
  if (!release) throw new Error("Release disappeared during verification");
  for (const file of localFiles) {
    const name = file.split(/[\\/]/).pop();
    const asset = release.assets.find((entry) => entry.name === name);
    if (!asset || asset.state !== "uploaded" || asset.size !== statSync(file).size) throw new Error(`Missing or incomplete remote asset: ${name}`);
    const digest = `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
    if (asset.digest && asset.digest !== digest) throw new Error(`Remote digest mismatch: ${name}`);
    if (name === "latest.yml" || verifyDownload || !asset.digest) await downloadAndVerify(headers, asset, sha512File(file));
  }
}

async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return; }
  const version = (args.version || JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version).replace(/^v/, "");
  const tag = `v${version}`;
  const repo = args.repo || detectRepo();
  const releaseDir = resolve(root, "release");

  console.log(`[release] ${repo} ${tag}`);

  const { assets } = validateReleaseArtifacts(releaseDir, version);
  for (const asset of assets) console.log(`  ok ${asset.split(/[\\/]/).pop()} (${statSync(asset).size} B)`);

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
    await verifyRemoteAssets(headers, release, assets, args.verifyDownload);
    return;
  }

  // ---- 3. Create or reuse ------------------------------------------------
  const notes = args.notesFile ? readFileSync(resolve(root, args.notesFile), "utf8") : undefined;
  if (!release) {
    const tagCheck = await ghFetch(`${API}/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, { headers });
    if (!tagCheck.ok) throw new Error(`Remote tag ${tag} is unavailable (${tagCheck.status}); push main and the annotated tag before publishing`);
    release = await createRelease(headers, repo, {
      tag_name: tag,
      name: version,
      ...(notes ? { body: notes } : {}),
      draft: true,
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
    await uploadAsset(headers, repo, release.id, assetPath, release.assets, release.draft);
  }

  // Verify all remote assets before making a new release visible to updaters.
  let final = await getRelease(headers, repo, tag);
  await verifyRemoteAssets(headers, final, assets, args.verifyDownload);
  if (final.draft) {
    const response = await ghFetch(`${API}/repos/${repo}/releases/${final.id}`, {
      method: "PATCH", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ draft: false, prerelease: false, make_latest: "true" }),
    });
    if (!response.ok) throw new Error(`publish release ${response.status}: ${await response.text()}`);
    final = await response.json();
  }
  console.log(`[release] done: ${final.html_url}`);
  for (const asset of final.assets) console.log(`  - ${asset.name} (${asset.size} B, ${asset.state})`);

  const latestCheck = await ghFetch(`${API}/repos/${repo}/releases/latest`, { headers });
  if (!latestCheck.ok) throw new Error(`Check latest release ${latestCheck.status}: ${await latestCheck.text()}`);
  if (latestCheck.ok) {
    const latestRelease = await latestCheck.json();
    if (latestRelease.tag_name === tag) console.log("[release] this is the repository's latest release (used by electron-updater)");
    else throw new Error(`GitHub latest is ${latestRelease.tag_name}, expected ${tag}`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[release] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { parseLatestYml, parseArgs, sha512File, validateReleaseArtifacts, uploadAsset, main };
