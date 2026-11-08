const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const load = () => import("../scripts/create-release.mjs");

test("release arguments reject missing option values", async () => {
  const { parseArgs } = await load();
  for (const option of ["--version", "--notes-file", "--repo"]) {
    assert.throws(() => parseArgs([option]), /missing value/);
    assert.throws(() => parseArgs([option, "--dry-run"]), /missing value/);
  }
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "0.1.14";
  const name = `TermBeacon-${version}-setup.exe`;
  const body = Buffer.from("installer");
  const sha512 = crypto.createHash("sha512").update(body).digest("base64");
  const manifest = `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${body.length}\npath: ${name}\nsha512: ${sha512}\n`;
  fs.writeFileSync(path.join(root, name), body);
  fs.writeFileSync(path.join(root, name + ".blockmap"), "blockmap");
  fs.writeFileSync(path.join(root, "latest.yml"), manifest);
  return { root, version, name, manifest };
}

test("release validation accepts CRLF and requires the exact version, hashes, size and blockmap", async (t) => {
  const { validateReleaseArtifacts, parseLatestYml } = await load();
  const { root, version, name, manifest } = fixture(t);
  assert.equal(validateReleaseArtifacts(root, version).assets.length, 3);
  assert.equal(parseLatestYml(manifest.replaceAll("\n", "\r\n")).files[0].url, name);
  assert.throws(() => validateReleaseArtifacts(root, "0.1.15"), /requested Windows release/);
  fs.writeFileSync(path.join(root, name), "different");
  assert.throws(() => validateReleaseArtifacts(root, version), /sha512/);
  fs.writeFileSync(path.join(root, name), "installer");
  fs.unlinkSync(path.join(root, name + ".blockmap"));
  assert.throws(() => validateReleaseArtifacts(root, version), /ENOENT|blockmap/);
});

test("published assets are compared by content and cannot be replaced by same-sized different bytes", async (t) => {
  const { uploadAsset } = await load();
  const { root, name } = fixture(t);
  const existing = { id: 1, name, size: 9, state: "uploaded", digest: "sha256:" + "0".repeat(64) };
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not mutate a published release"); });
  await assert.rejects(uploadAsset({}, "owner/repo", 1, path.join(root, name), [existing], false), /Published asset .* differs/);
});

test("a new release stays draft until every asset and the remote updater manifest are verified", async (t) => {
  const { main } = await load();
  const { root, version } = fixture(t);
  const work = path.join(root, "workspace");
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(work, "release"));
  for (const name of fs.readdirSync(root).filter((entry) => entry !== "workspace")) fs.copyFileSync(path.join(root, name), path.join(work, "release", name));
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ version }));
  const token = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "test-token";
  t.after(() => { if (token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = token; });
  let release;
  let verified = false;
  const bytes = new Map();
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const uri = new URL(url), method = options.method || "GET";
    if (uri.pathname.endsWith(`/git/ref/tags/v${version}`)) return Response.json({ ref: `refs/tags/v${version}` });
    if (uri.pathname.endsWith(`/releases/tags/v${version}`)) return release && !release.draft ? Response.json(release) : Response.json({}, { status: 404 });
    if (uri.pathname.endsWith('/releases') && method === "GET") return Response.json(release ? [release] : []);
    if (uri.pathname.endsWith("/releases") && method === "POST") { const body = JSON.parse(options.body); assert.equal(body.draft, true); release = { ...body, id: 7, assets: [], html_url: "https://github.com/owner/repo/releases/tag/v" + version }; return Response.json(release); }
    if (uri.hostname === "uploads.github.com") {
      assert.equal(release.draft, true); assert.ok(Buffer.isBuffer(options.body));
      const name = uri.searchParams.get("name"), id = release.assets.length + 1;
      const asset = { id, name, size: options.body.length, state: "uploaded", url: `https://api.github.com/assets/${id}`, digest: "sha256:" + crypto.createHash("sha256").update(options.body).digest("hex") };
      bytes.set(id, options.body); release.assets.push(asset); return Response.json(asset);
    }
    if (uri.pathname.startsWith("/assets/")) { assert.equal(release.draft, true); verified = true; return new Response(bytes.get(Number(uri.pathname.split("/").pop()))); }
    if (method === "PATCH") { assert.equal(release.assets.length, 3); assert.equal(verified, true); release = { ...release, ...JSON.parse(options.body) }; return Response.json(release); }
    if (uri.pathname.endsWith("/releases/latest")) return Response.json(release);
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  await main(["--repo", "owner/repo"], work);
  assert.equal(release.draft, false);
});
