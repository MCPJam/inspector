/**
 * Release Readiness Checklist tile.
 *
 * Mirrors the gates `release.yml`'s preflight enforces (release.yml:71-98
 * for the staging-SHA match, and the Changesets plan output at
 * release.yml:100-167). If every blocking check is ✅, running the Release
 * workflow will pass preflight.
 *
 * Nudge rows (prod-behind-staging, Soundcheck's own deploy status) are
 * informational — they don't block the release, but they're part of
 * "should I actually do this today?".
 */

import {
  compareCommits,
  findSuccessfulRunForSha,
  getBranchHead,
  getLatestEnvironmentDeployment,
  getLatestWorkflowRun,
  type BranchHead,
  type DeploymentInfo,
  type WorkflowRun
} from "@/lib/github";
import { fetchPendingChangesets } from "@/lib/changesets";
import { formatRelativeTime, shortSha } from "@/lib/format";
import { StatusDot, Tile, type StatusTone } from "@/components/ui";

const INSPECTOR = { owner: "MCPJam", repo: "inspector" };
const BACKEND = { owner: "MCPJam", repo: "mcpjam-backend" };

interface CheckRow {
  tone: StatusTone;
  /** Short label on the left. */
  label: string;
  /** Supporting detail, rendered muted. */
  detail: string;
  /** Optional link target. */
  href?: string;
}

function Row({ row }: { row: CheckRow }) {
  return (
    <li className="group flex items-start gap-4 py-3">
      <span className="mt-1.5 shrink-0">
        <StatusDot tone={row.tone} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">
          {row.href ? (
            <a
              href={row.href}
              target="_blank"
              rel="noreferrer"
              className="transition-colors group-hover:text-primary hover:underline underline-offset-4 decoration-border"
            >
              {row.label}
            </a>
          ) : (
            row.label
          )}
        </div>
        <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {row.detail}
        </div>
      </div>
    </li>
  );
}

export function ReleaseReadinessSkeleton() {
  return (
    <Tile title="Release readiness" eyebrow="Preflight mirror">
      <p className="text-sm text-muted-foreground">Loading checks…</p>
    </Tile>
  );
}

export async function ReleaseReadiness() {
  const rows: CheckRow[] = [];

  // ── Inspector main HEAD ───────────────────────────────────────────────
  let inspectorHead: BranchHead | null = null;
  try {
    inspectorHead = await getBranchHead(INSPECTOR.owner, INSPECTOR.repo, "main");
    rows.push({
      tone: "success",
      label: `Inspector main is at ${shortSha(inspectorHead.sha)}`,
      detail: `${inspectorHead.message} — ${inspectorHead.author}, ${formatRelativeTime(inspectorHead.date)}`,
      href: inspectorHead.url
    });
  } catch (err) {
    rows.push({
      tone: "failure",
      label: "Inspector main is unreachable",
      detail: (err as Error).message
    });
  }

  // ── Inspector staging-for-SHA (the hard gate) ─────────────────────────
  if (inspectorHead) {
    try {
      const stagingRun = await findSuccessfulRunForSha(
        INSPECTOR.owner,
        INSPECTOR.repo,
        "deploy-staging.yml",
        "main",
        inspectorHead.sha
      );
      if (stagingRun) {
        rows.push({
          tone: "success",
          label: `Staging + smoke green for ${shortSha(inspectorHead.sha)}`,
          detail: `deploy-staging.yml succeeded ${formatRelativeTime(stagingRun.updatedAt)}`,
          href: stagingRun.htmlUrl
        });
      } else {
        rows.push({
          tone: "failure",
          label: `No successful staging deploy for ${shortSha(inspectorHead.sha)}`,
          detail: "Release.yml preflight will fail until deploy-staging.yml runs green for this SHA."
        });
      }
    } catch (err) {
      rows.push({
        tone: "failure",
        label: "Could not check staging for main SHA",
        detail: (err as Error).message
      });
    }
  }

  // ── Pending changesets ────────────────────────────────────────────────
  if (inspectorHead) {
    try {
      const changesets = await fetchPendingChangesets(
        INSPECTOR.owner,
        INSPECTOR.repo,
        inspectorHead.sha
      );
      const count = changesets.length;
      if (count > 0) {
        const packageSet = new Set<string>();
        for (const cs of changesets) {
          for (const pkg of Object.keys(cs.bumps)) packageSet.add(pkg);
        }
        rows.push({
          tone: "success",
          label: `${count} pending changeset${count === 1 ? "" : "s"}`,
          detail: `Will bump: ${Array.from(packageSet).join(", ") || "nothing"}`
        });
      } else {
        rows.push({
          tone: "failure",
          label: "No pending changesets",
          detail: "Release.yml preflight will fail — add a changeset before running."
        });
      }
    } catch (err) {
      rows.push({
        tone: "warning",
        label: "Could not list changesets",
        detail: (err as Error).message
      });
    }
  }

  // ── Backend main HEAD + staging gate ──────────────────────────────────
  let backendHead: BranchHead | null = null;
  try {
    backendHead = await getBranchHead(BACKEND.owner, BACKEND.repo, "main");
    const stagingRun = await findSuccessfulRunForSha(
      BACKEND.owner,
      BACKEND.repo,
      "deploy-staging.yml",
      "main",
      backendHead.sha
    );
    rows.push({
      tone: stagingRun ? "success" : "warning",
      label: `Backend main is at ${shortSha(backendHead.sha)}`,
      detail: stagingRun
        ? `Backend deploy-staging succeeded ${formatRelativeTime(stagingRun.updatedAt)}`
        : "Backend deploy-staging hasn't succeeded for this SHA yet — deploy_backend_prod=true will fail.",
      href: stagingRun?.htmlUrl ?? backendHead.url
    });
  } catch (err) {
    rows.push({
      tone: "warning",
      label: "Could not read backend main",
      detail: (err as Error).message
    });
  }

  // ── Nudge: prod-behind-staging (informational) ────────────────────────
  try {
    const [stagingDep, prodDep] = await Promise.all([
      getLatestEnvironmentDeployment(INSPECTOR.owner, INSPECTOR.repo, "staging"),
      getLatestEnvironmentDeployment(INSPECTOR.owner, INSPECTOR.repo, "production")
    ]);
    rows.push(await buildProdDriftRow(stagingDep, prodDep));
  } catch (err) {
    rows.push({
      tone: "info",
      label: "Inspector prod drift unknown",
      detail: (err as Error).message
    });
  }

  // ── Soundcheck's own deploy status (informational) ────────────────────
  try {
    const latest = await getLatestWorkflowRun(
      INSPECTOR.owner,
      INSPECTOR.repo,
      "deploy-soundcheck.yml",
      { branch: "main" }
    );
    rows.push(buildSoundcheckRow(latest));
  } catch (err) {
    rows.push({
      tone: "info",
      label: "Soundcheck deploy status unknown",
      detail: (err as Error).message
    });
  }

  // Derive a top-line tile accent from the rows: red beats amber beats neutral.
  const hasFailure = rows.some((r) => r.tone === "failure");
  const hasWarning = rows.some((r) => r.tone === "warning");
  const accent = hasFailure ? "failure" : hasWarning ? "warning" : "success";
  const summary = hasFailure
    ? "Preflight will fail — see blockers below."
    : hasWarning
      ? "Preflight will pass, but check the nudges."
      : "All checks green. You can ship.";

  return (
    <Tile
      title="Release readiness"
      eyebrow={summary}
      accent={accent}
    >
      <ul className="-mt-1 divide-y divide-border">
        {rows.map((row, i) => (
          <Row key={i} row={row} />
        ))}
      </ul>
    </Tile>
  );
}

async function buildProdDriftRow(
  stagingDep: DeploymentInfo | null,
  prodDep: DeploymentInfo | null
): Promise<CheckRow> {
  if (!stagingDep || !prodDep) {
    return {
      tone: "info",
      label: "Inspector prod drift unknown",
      detail: "Missing a staging or production deployment record."
    };
  }
  if (stagingDep.sha === prodDep.sha) {
    return {
      tone: "success",
      label: "Inspector prod is in sync with staging",
      detail: `Last promoted ${formatRelativeTime(prodDep.createdAt)}.`
    };
  }
  try {
    const diff = await compareCommits(
      INSPECTOR.owner,
      INSPECTOR.repo,
      prodDep.sha,
      stagingDep.sha
    );
    const age = formatRelativeTime(prodDep.createdAt);
    const driftDays =
      (Date.now() - new Date(prodDep.createdAt).getTime()) /
      (24 * 60 * 60 * 1000);
    const tone: StatusTone = driftDays > 21 ? "warning" : "info";
    return {
      tone,
      label: `Inspector prod is ${diff.aheadBy} commit${diff.aheadBy === 1 ? "" : "s"} behind staging`,
      detail: `Last promoted ${age}. Nudge — not a blocker.`
    };
  } catch (err) {
    return {
      tone: "info",
      label: "Inspector prod drift unknown",
      detail: (err as Error).message
    };
  }
}

function buildSoundcheckRow(latest: WorkflowRun | null): CheckRow {
  if (!latest) {
    return {
      tone: "info",
      label: "Soundcheck has no deploys on record",
      detail: "First-run state; not a blocker."
    };
  }
  const age = formatRelativeTime(latest.updatedAt);
  if (latest.conclusion === "success") {
    return {
      tone: "info",
      label: `Soundcheck last deployed ${age}`,
      detail: latest.displayTitle || "deploy-soundcheck.yml",
      href: latest.htmlUrl
    };
  }
  if (latest.status !== "completed") {
    return {
      tone: "running",
      label: "Soundcheck deploy is in-flight",
      detail: `Started ${age}`,
      href: latest.htmlUrl
    };
  }
  return {
    tone: latest.conclusion === "failure" ? "failure" : "warning",
    label: `Soundcheck deploy ${latest.conclusion ?? "incomplete"}`,
    detail: `Latest run ${age}. Doesn't block the release workflow.`,
    href: latest.htmlUrl
  };
}
