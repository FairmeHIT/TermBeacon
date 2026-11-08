import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// electron-builder's Windows manifest has a deliberately small, fixed shape.
export function parseLatestYml(input) {
  const text = input.replaceAll("\r\n", "\n");
  const scalar = (value) => value?.trim().replace(/^['"]|['"]$/g, "");
  const files = [];
  let file;
  for (const line of text.split("\n")) {
    const url = /^\s+- url:\s*(.+)$/.exec(line);
    if (url) { file = { url: scalar(url[1]) }; files.push(file); }
    else if (/^\S/.test(line)) file = undefined;
    else if (file) {
      const value = /^\s+(sha512|size):\s*(.+)$/.exec(line);
      if (value) file[value[1]] = value[1] === "size" ? Number(value[2]) : scalar(value[2]);
    }
  }
  return { version: scalar(/^version:\s*(.+)$/m.exec(text)?.[1]), path: scalar(/^path:\s*(.+)$/m.exec(text)?.[1]), sha512: scalar(/^sha512:\s*(.+)$/m.exec(text)?.[1]), files };
}

export function sha512File(file) {
  return createHash("sha512").update(readFileSync(file)).digest("base64");
}

export function validateReleaseArtifacts(directory, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid release version");
  const latestPath = join(directory, "latest.yml");
  const latest = parseLatestYml(readFileSync(latestPath, "utf8"));
  const name = `TermBeacon-${version}-setup.exe`;
  if (latest.version !== version || latest.path !== name || latest.files.length !== 1 || latest.files[0].url !== name) throw new Error("latest.yml does not match the requested Windows release");
  const file = join(directory, name);
  const entry = latest.files[0];
  if (!entry.sha512 || latest.sha512 !== entry.sha512 || sha512File(file) !== entry.sha512) throw new Error("Installer sha512 does not match latest.yml");
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || statSync(file).size !== entry.size) throw new Error("Installer size does not match latest.yml");
  const blockmap = `${file}.blockmap`;
  if (!statSync(blockmap).isFile() || statSync(blockmap).size === 0) throw new Error("Missing or empty installer blockmap");
  return { latest, assets: [file, blockmap, latestPath] };
}
