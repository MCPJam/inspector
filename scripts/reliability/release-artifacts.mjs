import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const integrity = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export function verifyManifest(directory, expectedSha) {
  const manifest = JSON.parse(
    readFileSync(path.join(directory, "manifest.json"), "utf8")
  );
  if (
    manifest.schemaVersion !== 1 ||
    !expectedSha ||
    manifest.sha !== expectedSha ||
    !manifest.packages?.length
  )
    throw new Error("Release artifact identity does not match candidate");
  const names = new Set();
  for (const pkg of manifest.packages) {
    if (
      typeof pkg.publish !== "boolean" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version) ||
      !/^mcpjam-[a-z0-9.-]+\.tgz$/.test(pkg.filename) ||
      !["@mcpjam/sdk", "@mcpjam/cli", "@mcpjam/inspector"].includes(pkg.name) ||
      names.has(pkg.name)
    )
      throw new Error("Invalid release package manifest");
    names.add(pkg.name);
    if (
      integrity(readFileSync(path.join(directory, pkg.filename))) !==
      pkg.integrity
    )
      throw new Error(`Artifact integrity mismatch: ${pkg.name}`);
  }
  return manifest;
}

export function recordManifest(directory, sha, packages) {
  const manifest = {
    schemaVersion: 1,
    sha,
    packages: packages.map((pkg) => ({
      ...pkg,
      integrity: integrity(readFileSync(path.join(directory, pkg.filename))),
    })),
  };
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  return verifyManifest(directory, sha);
}

function npm(args, allowMissing = false) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  });
  if (result.status !== 0) {
    let error;
    try {
      error = JSON.parse(result.stdout).error;
    } catch {
      /* malformed registry response */
    }
    if (allowMissing && error?.code === "E404") return null;
    throw new Error(
      `npm ${args[0]} failed (command output suppressed to protect credentials)`
    );
  }
  return result.stdout;
}

export async function publishManifest(
  manifest,
  directory,
  {
    publish = (pkg) =>
      npm([
        "publish",
        path.resolve(directory, pkg.filename),
        "--ignore-scripts",
        "--access",
        "public",
      ]),
    readDist = (pkg) => {
      const value = npm(
        ["view", `${pkg.name}@${pkg.version}`, "dist", "--json"],
        true
      );
      return value === null ? null : JSON.parse(value);
    },
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    verifyOnly = false,
  } = {}
) {
  for (const pkg of manifest.packages.filter((p) => p.publish)) {
    let dist = await readDist(pkg);
    if (!dist && !verifyOnly) {
      // Never rebuild between verification and publishing. On a partial
      // release retry, an already-published IDENTICAL archive is a no-op.
      await publish(pkg);
    }
    for (let attempt = 0; !dist && attempt < 6; attempt++) {
      if (attempt) await sleep(2000);
      dist = await readDist(pkg);
    }
    if (dist?.integrity !== pkg.integrity)
      throw new Error(
        `Published bytes differ from verified candidate: ${pkg.name}`
      );
    process.stdout.write(`Verified published ${pkg.name}@${pkg.version}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, directory] = process.argv.slice(2);
  if (!["publish", "verify-published"].includes(command))
    throw new Error("Expected publish or verify-published");
  const manifest = verifyManifest(directory, process.env.GITHUB_SHA);
  await publishManifest(manifest, directory, {
    verifyOnly: command === "verify-published",
  });
}
