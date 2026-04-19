/**
 * Release Dry-Run Preview tile.
 *
 * Shows exactly what `changeset version` would produce against `main`:
 * per-package current → new version, bump type, contributing changesets
 * (with their descriptions = release-note bodies), the projected
 * release_tag, which scopes are valid, and whether desktop artifacts will
 * build.
 */

import { getBranchHead } from "@/lib/github";
import {
  buildReleasePlan,
  fetchCurrentVersions,
  fetchPendingChangesets,
  type PackageBumpPlan
} from "@/lib/changesets";
import { Badge, Tile, TileAction } from "@/components/ui";
import { shortSha } from "@/lib/format";

const INSPECTOR = { owner: "MCPJam", repo: "inspector" };

export function ReleaseDryRunSkeleton() {
  return (
    <Tile title="Release dry-run" eyebrow="Computing plan">
      <p className="text-sm text-muted-foreground">
        Computing projected versions…
      </p>
    </Tile>
  );
}

export async function ReleaseDryRun() {
  let head;
  try {
    head = await getBranchHead(INSPECTOR.owner, INSPECTOR.repo, "main");
  } catch (err) {
    return (
      <Tile title="Release dry-run" accent="failure">
        <p className="text-sm text-destructive">
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
      <Tile title="Release dry-run" accent="failure">
        <p className="text-sm text-destructive">
          Failed to read release inputs: {(err as Error).message}
        </p>
      </Tile>
    );
  }

  const plan = buildReleasePlan({ changesets, currentVersions });
  const commitUrl = `https://github.com/${INSPECTOR.owner}/${INSPECTOR.repo}/commit/${head.sha}`;
  const titleAction = (
    <TileAction href={commitUrl}>main @ {shortSha(head.sha)}</TileAction>
  );

  if (plan.packages.length === 0) {
    return (
      <Tile
        title="Release dry-run"
        eyebrow="Nothing to publish"
        accent="warning"
        action={titleAction}
      >
        <p className="text-sm leading-relaxed text-muted-foreground">
          No pending changesets.{" "}
          <code className="font-mono text-foreground">npx changeset status</code>{" "}
          would report zero releases, and the Release workflow would fail
          preflight.
        </p>
      </Tile>
    );
  }

  return (
    <Tile
      title="Release dry-run"
      eyebrow={`${plan.packages.length} package${plan.packages.length === 1 ? "" : "s"} would bump`}
      accent="info"
      action={titleAction}
    >
      <div className="space-y-5">
        <ul className="space-y-4">
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

        <div className="border-t border-border" />

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          <span>
            <span className="text-muted-foreground">Tag</span>:{" "}
            {plan.releaseTag ? (
              <span className="font-mono text-foreground">{plan.releaseTag}</span>
            ) : (
              <span className="text-muted-foreground">none (no inspector bump)</span>
            )}
          </span>
          <span>
            <span className="text-muted-foreground">Desktop artifacts</span>:{" "}
            <span className="text-foreground">
              {plan.buildDesktopArtifacts ? "mac + windows" : "no"}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Valid scopes</span>:
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
  const bumpTone =
    pkg.bumpType === "major"
      ? "warning"
      : pkg.bumpType === "minor"
        ? "info"
        : "neutral";
  return (
    <li className="space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="font-mono text-sm text-foreground">{pkg.name}</span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {pkg.currentVersion}
        </span>
        <span className="text-xs text-muted-foreground">→</span>
        <span className="font-mono text-xs font-semibold text-success tabular-nums">
          {pkg.newVersion}
        </span>
        <Badge tone={bumpTone}>{pkg.bumpType}</Badge>
      </div>
      <ul className="space-y-1 border-l border-border pl-3">
        {pkg.changesets.map((csName) => {
          const note = notesByChangeset[csName]?.trim() ?? "";
          const firstLine = note.split(/\r?\n/)[0] || "(no description)";
          return (
            <li
              key={csName}
              className="flex gap-2 text-xs leading-relaxed text-muted-foreground"
            >
              <span className="font-mono text-muted-foreground">{csName}</span>
              <span className="text-muted-foreground">— {firstLine}</span>
            </li>
          );
        })}
      </ul>
    </li>
  );
}
