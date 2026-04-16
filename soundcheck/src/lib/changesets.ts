/**
 * Parse `.changeset/*.md` files and compute the projected package versions
 * that `changeset version` would produce.
 *
 * We deliberately don't shell out to `npx changeset status` here — Soundcheck
 * never has the monorepo checked out at runtime, it only sees the GitHub
 * contents API. That's fine: changeset files have a tiny, well-defined
 * frontmatter grammar and the bump math for plain semver (major/minor/patch)
 * is short enough to inline without pulling in the `semver` npm package.
 *
 * Consumed by both the Readiness tile ("are there pending changesets?") and
 * the Dry-Run tile ("projected versions + release notes").
 */

import {
  getRepoFile,
  listRepoDir,
  type RepoDirEntry
} from "@/lib/github";

export type BumpType = "major" | "minor" | "patch";

export interface ChangesetFile {
  /** Filename without extension, e.g. `lucky-snakes-dance`. */
  name: string;
  /** Map of package name → requested bump. */
  bumps: Record<string, BumpType>;
  /** Body of the file (the release-note text), trimmed. */
  description: string;
}

export interface PackageBumpPlan {
  name: string;
  currentVersion: string;
  bumpType: BumpType;
  newVersion: string;
  /** Changeset filenames that contributed to this bump. */
  changesets: string[];
}

export interface ReleasePlan {
  changesets: ChangesetFile[];
  /** Non-ignored packages with at least one pending bump, post-aggregation. */
  packages: PackageBumpPlan[];
  /** Inspector's new version (for release_tag) if inspector is in `packages`. */
  releaseTag: string | null;
  /** Which scope inputs are valid given the pending changesets. */
  validScopes: Array<"packages-only" | "inspector-only" | "full">;
  /** True iff inspector is in the bump set — release.yml builds artifacts. */
  buildDesktopArtifacts: boolean;
}

const BUMP_PRECEDENCE: Record<BumpType, number> = {
  patch: 1,
  minor: 2,
  major: 3
};

/** Pick the higher-impact bump — the same rule `changeset version` applies. */
function mergeBumps(a: BumpType, b: BumpType): BumpType {
  return BUMP_PRECEDENCE[a] >= BUMP_PRECEDENCE[b] ? a : b;
}

/** Apply a bump to a plain `x.y.z` version. Strips any prerelease/build. */
export function applyBump(version: string, bump: BumpType): string {
  // Drop anything after `-` or `+` (prerelease / build metadata) before math;
  // the MCPJam packages don't use prereleases so this is purely defensive.
  const core = version.split(/[-+]/)[0];
  const parts = core.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`Unparseable version: ${version}`);
  }
  const [major, minor, patch] = parts;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Parse a single `.md` changeset file. The format (per Changesets docs):
 *
 *   ---
 *   "@mcpjam/sdk": minor
 *   "@mcpjam/cli": patch
 *   ---
 *
 *   Body text, which becomes the release note.
 *
 * We accept both quoted and unquoted package names, and tolerate trailing
 * whitespace. Unknown bump types are ignored with a console warning.
 */
export function parseChangeset(
  filename: string,
  contents: string
): ChangesetFile | null {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatter, body] = match;
  const bumps: Record<string, BumpType> = {};
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const kv = line.match(/^(?:"([^"]+)"|([^:\s]+))\s*:\s*(major|minor|patch)\s*$/);
    if (!kv) {
      // Ignore unfamiliar lines rather than throwing — changeset files
      // sometimes include commented-out packages the user opted out of.
      continue;
    }
    const pkg = kv[1] ?? kv[2];
    const bump = kv[3] as BumpType;
    bumps[pkg] = bumps[pkg] ? mergeBumps(bumps[pkg], bump) : bump;
  }
  return {
    name: filename.replace(/\.md$/, ""),
    bumps,
    description: body.trim()
  };
}

/**
 * Pulls `.changeset/*.md` from the repo (excluding `README.md` and
 * `config.json`-adjacent files). Ignores files that fail to parse so a
 * broken changeset doesn't take the whole dashboard down.
 */
export async function fetchPendingChangesets(
  owner: string,
  repo: string,
  ref: string
): Promise<ChangesetFile[]> {
  let entries: RepoDirEntry[];
  try {
    entries = await listRepoDir(owner, repo, ".changeset", ref);
  } catch (err) {
    console.error(`Failed to list .changeset/ for ${owner}/${repo}@${ref}:`, err);
    return [];
  }
  const mdFiles = entries.filter(
    (e) =>
      e.type === "file" &&
      e.name.endsWith(".md") &&
      e.name.toLowerCase() !== "readme.md"
  );
  const results: ChangesetFile[] = [];
  await Promise.all(
    mdFiles.map(async (f) => {
      try {
        const contents = await getRepoFile(owner, repo, f.path, ref);
        const parsed = parseChangeset(f.name, contents);
        if (parsed && Object.keys(parsed.bumps).length > 0) {
          results.push(parsed);
        }
      } catch (err) {
        console.error(`Failed to read changeset ${f.path}:`, err);
      }
    })
  );
  return results;
}

/**
 * Ignored packages (from .changeset/config.json). We hardcode the single
 * ignore rather than reading config.json so there's no second round-trip —
 * CLAUDE.md guarantees `@mcpjam/soundcheck` is the only ignored package.
 * If that contract ever changes, bump this list.
 */
const IGNORED_PACKAGES = new Set<string>(["@mcpjam/soundcheck"]);

export interface BuildPlanInput {
  changesets: ChangesetFile[];
  /** Map of package name → current version from its package.json. */
  currentVersions: Record<string, string>;
}

export function buildReleasePlan(input: BuildPlanInput): ReleasePlan {
  const { changesets, currentVersions } = input;

  // Aggregate bumps across all changesets. Highest-precedence bump wins per
  // package (matches `changeset version`'s behavior).
  const byPackage = new Map<
    string,
    { bumpType: BumpType; changesets: string[] }
  >();

  for (const cs of changesets) {
    for (const [pkg, bump] of Object.entries(cs.bumps)) {
      if (IGNORED_PACKAGES.has(pkg)) continue;
      const existing = byPackage.get(pkg);
      if (existing) {
        existing.bumpType = mergeBumps(existing.bumpType, bump);
        existing.changesets.push(cs.name);
      } else {
        byPackage.set(pkg, { bumpType: bump, changesets: [cs.name] });
      }
    }
  }

  const packages: PackageBumpPlan[] = [];
  for (const [name, entry] of byPackage.entries()) {
    const currentVersion = currentVersions[name];
    if (!currentVersion) {
      // Package listed in a changeset but we couldn't read its package.json.
      // Skip rather than fabricate a version.
      console.warn(`No current version for ${name}, skipping.`);
      continue;
    }
    let newVersion: string;
    try {
      newVersion = applyBump(currentVersion, entry.bumpType);
    } catch (err) {
      console.error(`Bump failed for ${name}:`, err);
      continue;
    }
    packages.push({
      name,
      currentVersion,
      bumpType: entry.bumpType,
      newVersion,
      changesets: entry.changesets
    });
  }

  // Stable order: sdk, cli, inspector, then anything else alphabetically.
  // Matches how release.yml reasons about the set.
  const ORDER = ["@mcpjam/sdk", "@mcpjam/cli", "@mcpjam/inspector"];
  packages.sort((a, b) => {
    const ai = ORDER.indexOf(a.name);
    const bi = ORDER.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  const inspector = packages.find((p) => p.name === "@mcpjam/inspector");
  const buildDesktopArtifacts = Boolean(inspector);
  const releaseTag = inspector ? `v${inspector.newVersion}` : null;

  // Valid scopes mirror release.yml:100-145:
  //   - packages-only: requires inspector NOT to be in the set
  //   - inspector-only: requires sdk + cli NOT to be in the set
  //   - full: always valid as long as there's at least one bump
  const hasInspector = Boolean(inspector);
  const hasSdk = packages.some((p) => p.name === "@mcpjam/sdk");
  const hasCli = packages.some((p) => p.name === "@mcpjam/cli");
  const validScopes: ReleasePlan["validScopes"] = [];
  if (packages.length > 0) validScopes.push("full");
  if (packages.length > 0 && !hasInspector) validScopes.push("packages-only");
  if (hasInspector && !hasSdk && !hasCli) validScopes.push("inspector-only");

  return {
    changesets,
    packages,
    releaseTag,
    validScopes,
    buildDesktopArtifacts
  };
}

/**
 * Fetches current versions of the three publishable packages from `ref`.
 * Packages that fail to resolve are simply absent from the returned map —
 * `buildReleasePlan` will warn and skip them.
 */
export async function fetchCurrentVersions(
  owner: string,
  repo: string,
  ref: string
): Promise<Record<string, string>> {
  const packagePaths: Array<{ name: string; path: string }> = [
    { name: "@mcpjam/sdk", path: "sdk/package.json" },
    { name: "@mcpjam/cli", path: "cli/package.json" },
    { name: "@mcpjam/inspector", path: "mcpjam-inspector/package.json" }
  ];
  const out: Record<string, string> = {};
  await Promise.all(
    packagePaths.map(async (p) => {
      try {
        const contents = await getRepoFile(owner, repo, p.path, ref);
        const parsed = JSON.parse(contents) as { version?: string };
        if (parsed.version) out[p.name] = parsed.version;
      } catch (err) {
        console.error(`Failed to read ${p.path}:`, err);
      }
    })
  );
  return out;
}
