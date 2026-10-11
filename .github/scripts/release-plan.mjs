import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * What one release.yml run ships — the plan its preflight writes as outputs.
 *
 * Normally that is every public package whose committed version npm does not
 * have yet (`unpublished-versions.mjs`), and, when the Inspector is among them,
 * its desktop builds and GitHub release.
 *
 * npm and the webapp no longer wait for the desktop builds (Apple's notary
 * queue alone took 10–25 minutes in October 2026), while the GitHub release
 * still does: releases are immutable, so it is created once, with every
 * desktop asset already attached. That opens one gap — the Inspector on npm
 * with no GitHub release, when a desktop build failed after publishing. A run
 * then finds nothing unpublished and plans DESKTOP-ONLY: build the desktop apps
 * for the version `main` carries and create its GitHub release, publishing and
 * deploying nothing. That is how such a release is completed.
 *
 * @param {object} input
 * @param {Array<{name: string, newVersion: string}>} input.unpublished
 * @param {string} input.inspectorVersion  the version `main` carries
 * @param {boolean} input.inspectorReleaseExists  GitHub release `v<version>` exists
 * @param {boolean} [input.deployWebapp]
 */
export function planRelease({ unpublished, inspectorVersion, inspectorReleaseExists, deployWebapp = false }) {
  const releases = new Map(unpublished.map((release) => [release.name, release]));
  const selected = {
    evaluators: releases.has("@mcpjam/evaluators"),
    sdk: releases.has("@mcpjam/sdk"),
    cli: releases.has("@mcpjam/cli"),
    inspector: releases.has("@mcpjam/inspector"),
  };
  const publishAny = selected.evaluators || selected.sdk || selected.cli || selected.inspector;
  const desktopOnly = !publishAny && Boolean(inspectorVersion) && !inspectorReleaseExists;

  if (!publishAny && !desktopOnly) {
    throw new Error(
      "Nothing to release: every package version on main is already on npm, and " +
        `v${inspectorVersion} already has its GitHub release. Start a release from ` +
        "Soundcheck, which opens the version PR, and merge it first.",
    );
  }
  if (deployWebapp && !selected.inspector && !desktopOnly) {
    throw new Error(
      "deploy_webapp=true requires an inspector release. To deploy production without cutting a release, dispatch deploy-webapp.yml directly.",
    );
  }

  // Only the backend dispatch payload reads this now; the version PR decides
  // what ships.
  const scope = desktopOnly
    ? "desktop-only"
    : !selected.inspector
      ? "packages-only"
      : selected.evaluators || selected.sdk || selected.cli
        ? "full"
        : "inspector-only";
  const version = selected.inspector ? releases.get("@mcpjam/inspector").newVersion : desktopOnly ? inspectorVersion : "";
  return {
    scope,
    publish_any: String(publishAny),
    publish_evaluators: String(selected.evaluators),
    publish_sdk: String(selected.sdk),
    publish_cli: String(selected.cli),
    publish_inspector: String(selected.inspector),
    // Desktop builds, the local-harness contract and the GitHub release: for
    // an Inspector release, and for completing one (desktop-only).
    build_inspector_artifacts: String(selected.inspector || desktopOnly),
    desktop_only: String(desktopOnly),
    inspector_version: version,
    release_tag: version ? `v${version}` : "",
  };
}

/** Fails closed: only an explicit "release not found" means it does not exist. */
export function githubReleaseExists(tag, run = (args) => spawnSync("gh", args, { encoding: "utf8" })) {
  const result = run(["release", "view", tag, "--json", "tagName", "--jq", ".tagName"]);
  if (result.status === 0) return result.stdout.trim() === tag;
  if (/release not found/i.test(`${result.stderr}${result.stdout}`)) return false;
  throw new Error(`Could not tell whether GitHub release ${tag} exists: ${result.stderr || result.stdout}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [unpublishedPath] = process.argv.slice(2);
  const { releases: unpublished } = JSON.parse(readFileSync(unpublishedPath, "utf8"));
  const inspectorVersion = JSON.parse(readFileSync("mcpjam-inspector/package.json", "utf8")).version;
  const plan = planRelease({
    unpublished,
    inspectorVersion,
    // Asked only when nothing is unpublished — the one case it decides — so a
    // GitHub hiccup can never block an ordinary release.
    inspectorReleaseExists: unpublished.length > 0 ? true : githubReleaseExists(`v${inspectorVersion}`),
    deployWebapp: process.env.DEPLOY_WEBAPP === "true",
  });
  if (plan.desktop_only === "true") {
    console.log(
      `Desktop-only: ${plan.release_tag} is on npm but has no GitHub release; building the desktop apps and creating it.`,
    );
  }
  for (const [key, value] of Object.entries(plan)) {
    console.log(`${key}=${value}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
