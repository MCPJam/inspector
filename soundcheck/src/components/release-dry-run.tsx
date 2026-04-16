/**
 * Release Dry-Run Preview tile.
 *
 * Shows exactly what `changeset version` would produce against `main`:
 * per-package current → new version, bump type, contributing changesets
 * (with their descriptions = release-note bodies), the projected
 * release_tag, which scopes are valid, and whether desktop artifacts will
 * build.
 *
 * Uses the GitHub contents API to read `.changeset/*.md` + the three
 * package.json files on `main`, so no monorepo checkout is needed.
 */

import { getBranchHead } from "@/lib/github";
import {
  buildReleasePlan,
  fetchCurrentVersions,
  fetchPendingChangesets,
  type PackageBumpPlan
} from "@/lib/changesets";
import { Badge, Tile } from "@/components/ui";
import { shortSha } from "@/lib/format";

const INSPECTOR = { owner: "MCPJam", repo: "inspector" };

export function ReleaseDryRunSkeleton() {
  return (
    <Tile title="Release dry-run">
      <p className="text-sm text-neutral-400">Computing projected versions…</p>
    </Tile>
  );
}

export async function ReleaseDryRun() {
  let head;
  try {
    head = await getBranchHead(INSPECTOR.owner, INSPECTOR.repo, "main");
  } catch (err) {
    return (
      <Tile title="Release dry-run">
        <p className="text-sm text-red-500">
          Failed to read main: {(err as Error).message}
        </p>
      </Tile>
    );
  }

  let changesets, currentVersions;
  try {
    [changesets, currentVersions] = await Promise.all([
      fetchPendingChangesets(INSPECTOR.owner, INSPECTOR.repo, head.sha),
      fetchCurrentVersions(INSPECTOR.owner, INSPECTOR.repo, head.sha)
    ]);
  } catch (err) {
    return (
      <Tile title="Release dry-run">
        <p className="text-sm text-red-500">
          Failed to read release inputs: {(err as Error).message}
        </p>
      </Tile>
    );
  }

  const plan = buildReleasePlan({ changesets, currentVersions });
  const titleAction = (
    <a
      href={`https://github.com/${INSPECTOR.owner}/${INSPECTOR.repo}/commit/${head.sha}`}
      target="_blank"
      rel="noreferrer"
      className="font-mono hover:underline"
    >
      main @ {shortSha(head.sha)}
    </a>
  );

  if (plan.packages.length === 0) {
    return (
      <Tile title="Release dry-run" action={titleAction}>
        <p className="text-sm text-neutral-500">
          No pending changesets. `npx changeset status` would report zero
          releases, and the Release workflow would fail preflight.
        </p>
      </Tile>
    );
  }

  return (
    <Tile title="Release dry-run" action={titleAction}>
      <div className="space-y-4">
        <ul className="space-y-3">
          {plan.packages.map((pkg) => (
            <PackageRow
              key={pkg.name}
              pkg={pkg}
              notesByChangeset={Object.fromEntries(
                plan.changesets.map((c) => [c.name, c.description])
              )}
            />
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-neutral-100 pt-3 text-xs text-neutral-500 dark:border-neutral-900">
          {plan.releaseTag ? (
            <span>
              Tag: <span className="font-mono text-neutral-700 dark:text-neutral-200">{plan.releaseTag}</span>
            </span>
          ) : (
            <span>Tag: none (no inspector bump)</span>
          )}
          <span>
            Desktop artifacts:{" "}
            <span className="font-medium text-neutral-700 dark:text-neutral-200">
              {plan.buildDesktopArtifacts ? "yes (mac + windows)" : "no"}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            Valid scopes:
            {plan.validScopes.length === 0 ? (
              <Badge tone="failure">none</Badge>
            ) : (
              plan.validScopes.map((s) => (
                <Badge key={s} tone="info">
                  {s}
                </Badge>
              ))
            )}
          </span>
        </div>
      </div>
    </Tile>
  );
}

function PackageRow({
  pkg,
  notesByChangeset
}: {
  pkg: PackageBumpPlan;
  notesByChangeset: Record<string, string>;
}) {
  return (
    <li className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-mono text-neutral-700 dark:text-neutral-200">
          {pkg.name}
        </span>
        <span className="font-mono text-xs text-neutral-400">
          {pkg.currentVersion}
        </span>
        <span className="text-xs text-neutral-400">→</span>
        <span className="font-mono text-xs font-semibold text-neutral-700 dark:text-neutral-200">
          {pkg.newVersion}
        </span>
        <Badge tone={pkg.bumpType === "major" ? "warning" : pkg.bumpType === "minor" ? "info" : "neutral"}>
          {pkg.bumpType}
        </Badge>
      </div>
      <ul className="ml-0 space-y-1 pl-0">
        {pkg.changesets.map((csName) => {
          const note = notesByChangeset[csName]?.trim() ?? "";
          const firstLine = note.split(/\r?\n/)[0] || "(no description)";
          return (
            <li key={csName} className="flex gap-2 text-xs text-neutral-500">
              <span className="font-mono text-neutral-400">{csName}</span>
              <span className="text-neutral-500">— {firstLine}</span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
