import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * The public workspace packages whose `package.json` version npm does not have
 * yet — which is what a release ships, and exactly what `changeset publish`
 * will publish.
 *
 * A release no longer versions anything itself. `changeset version` runs in
 * the PR prepare-release.yml opens, and that PR merges into `main` like any
 * other change, so by the time release.yml runs the versions are already
 * committed. Pending changesets say nothing about the release in flight; the
 * registry does.
 */
export function unpublishedVersions(
  readJson,
  run = (args) => spawnSync("npm", args, { encoding: "utf8" })
) {
  const releases = [];
  for (const dir of readJson("package.json").workspaces) {
    // Globs would need expanding, and silently skipping one would drop every
    // package under it from the release.
    if (/[*?[{]/.test(dir))
      throw new Error(`Workspace "${dir}" is a glob; list it explicitly`);
    const { name, version, private: isPrivate } = readJson(
      `${dir}/package.json`
    );
    if (isPrivate) continue;
    if (!registryHas(name, version, run))
      releases.push({ name, newVersion: version });
  }
  return releases;
}

/** Fails closed: only an explicit E404 means "not published". */
function registryHas(name, version, run) {
  const result = run(["view", `${name}@${version}`, "version", "--json"]);
  if (result.status === 0) {
    if (JSON.parse(result.stdout) !== version)
      throw new Error(`Unexpected registry version for ${name}@${version}`);
    return true;
  }
  let code;
  try {
    code = JSON.parse(result.stdout).error?.code;
  } catch {
    /* Fail closed below. */
  }
  if (code !== "E404")
    throw new Error(`Could not read registry state for ${name}@${version}`);
  return false;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = new URL("../../", import.meta.url);
  const readJson = (path) =>
    JSON.parse(readFileSync(new URL(path, root), "utf8"));
  console.log(
    JSON.stringify({ releases: unpublishedVersions(readJson) }, null, 2)
  );
}
