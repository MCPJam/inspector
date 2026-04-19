/**
 * Deploy Failure Diagnostics tile.
 *
 * One row per tracked workflow. For each, the most recent failed run within
 * the lookback window (default 7d) — with the failing job, the failing
 * step, and check-run annotations surfaced inline.
 */

import {
  getJobAnnotations,
  getMostRecentFailedRun,
  getWorkflowRunJobs,
  type CheckRunAnnotation,
  type WorkflowJob,
  type WorkflowRun
} from "@/lib/github";
import { Badge, Sha, Tile } from "@/components/ui";
import { formatRelativeTime, shortSha } from "@/lib/format";

interface Target {
  label: string;
  owner: string;
  repo: string;
  workflowFile: string;
}

const TARGETS: Target[] = [
  {
    label: "Inspector · release.yml",
    owner: "MCPJam",
    repo: "inspector",
    workflowFile: "release.yml"
  },
  {
    label: "Inspector · deploy-staging.yml",
    owner: "MCPJam",
    repo: "inspector",
    workflowFile: "deploy-staging.yml"
  },
  {
    label: "Inspector · deploy-soundcheck.yml",
    owner: "MCPJam",
    repo: "inspector",
    workflowFile: "deploy-soundcheck.yml"
  },
  {
    label: "MCP · deploy-mcp-staging.yml",
    owner: "MCPJam",
    repo: "inspector",
    workflowFile: "deploy-mcp-staging.yml"
  },
  {
    label: "MCP · pr-mcp-preview.yml",
    owner: "MCPJam",
    repo: "inspector",
    workflowFile: "pr-mcp-preview.yml"
  },
  {
    label: "Backend · deploy-staging.yml",
    owner: "MCPJam",
    repo: "mcpjam-backend",
    workflowFile: "deploy-staging.yml"
  },
  {
    label: "Backend · deploy-production.yml",
    owner: "MCPJam",
    repo: "mcpjam-backend",
    workflowFile: "deploy-production.yml"
  }
];

const LOOKBACK_DAYS = 7;

export function DeployFailuresSkeleton() {
  return (
    <Tile title="Recent failures" eyebrow="Scanning workflows">
      <p className="text-sm text-muted-foreground">Scanning workflows…</p>
    </Tile>
  );
}

export async function DeployFailures() {
  const since = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const rows = await Promise.all(
    TARGETS.map((t) =>
      buildRow(t, since).catch(
        (err) =>
          ({
            target: t,
            state: "error" as const,
            message: (err as Error).message
          }) as const
      )
    )
  );

  const failureCount = rows.filter((r) => r.state === "failed").length;
  const accent =
    failureCount > 0 ? "failure" : rows.some((r) => r.state === "error") ? "warning" : "success";

  return (
    <Tile
      title={`Recent failures · last ${LOOKBACK_DAYS} days`}
      eyebrow={
        failureCount === 0
          ? "Nothing failing — clean week"
          : `${failureCount} workflow${failureCount === 1 ? "" : "s"} with recent failures`
      }
      accent={accent}
    >
      <ul className="-mt-2 divide-y divide-border">
        {rows.map((row) => (
          <FailureRow key={row.target.label} row={row} />
        ))}
      </ul>
    </Tile>
  );
}

type Row =
  | { target: Target; state: "healthy" }
  | { target: Target; state: "error"; message: string }
  | {
      target: Target;
      state: "failed";
      run: WorkflowRun;
      failingJob: WorkflowJob | null;
      annotations: CheckRunAnnotation[];
    };

async function buildRow(target: Target, since: string): Promise<Row> {
  const failed = await getMostRecentFailedRun(
    target.owner,
    target.repo,
    target.workflowFile,
    since
  );
  if (!failed) return { target, state: "healthy" };

  let failingJob: WorkflowJob | null = null;
  let annotations: CheckRunAnnotation[] = [];
  try {
    const jobs = await getWorkflowRunJobs(target.owner, target.repo, failed.id);
    failingJob =
      jobs.find(
        (j) => j.conclusion === "failure" || j.conclusion === "timed_out"
      ) ?? null;
    if (failingJob?.checkRunUrl) {
      annotations = await getJobAnnotations(
        target.owner,
        target.repo,
        failingJob.checkRunUrl
      );
    }
  } catch (err) {
    console.error(`Failed to enrich failure for ${target.label}:`, err);
  }
  return { target, state: "failed", run: failed, failingJob, annotations };
}

function FailureRow({ row }: { row: Row }) {
  if (row.state === "healthy") {
    return (
      <li className="flex items-center gap-3 py-3">
        <Badge tone="success">ok</Badge>
        <div className="text-sm text-muted-foreground">
          <span className="text-foreground">{row.target.label}</span>
          <span className="ml-2 text-muted-foreground">
            — no failures in the last {LOOKBACK_DAYS}d
          </span>
        </div>
      </li>
    );
  }
  if (row.state === "error") {
    return (
      <li className="flex items-center gap-3 py-3">
        <Badge tone="warning">error</Badge>
        <div className="text-sm text-muted-foreground">
          <span className="text-foreground">{row.target.label}</span>
          <span className="ml-2 text-muted-foreground">— {row.message}</span>
        </div>
      </li>
    );
  }

  const { run, failingJob, annotations } = row;
  const failingStep = failingJob?.steps.find(
    (s) => s.conclusion === "failure" || s.conclusion === "timed_out"
  );
  return (
    <li className="space-y-2 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        <Badge tone="failure">{run.conclusion ?? "failed"}</Badge>
        <span className="font-medium text-foreground">{row.target.label}</span>
        <span className="text-xs text-muted-foreground">
          run{" "}
          <a
            href={run.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="text-foreground hover:text-primary hover:underline underline-offset-4 decoration-border"
          >
            #{run.id}
          </a>{" "}
          · {formatRelativeTime(run.updatedAt)} · on{" "}
          <Sha sha={shortSha(run.headSha)} />
          {run.actor ? (
            <>
              {" "}· by <span className="text-foreground">{run.actor}</span>
            </>
          ) : null}
        </span>
      </div>

      {failingJob ? (
        <div className="text-xs text-muted-foreground">
          <a
            href={failingJob.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-foreground hover:text-primary hover:underline underline-offset-4 decoration-border"
          >
            {failingJob.name}
          </a>
          {failingStep ? (
            <>
              {" "}failed at step {failingStep.number}:{" "}
              <span className="text-foreground">{failingStep.name}</span>
            </>
          ) : null}
        </div>
      ) : null}

      {annotations.length > 0 ? (
        <ul className="space-y-0.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
          {annotations.slice(0, 6).map((a, i) => (
            <li
              key={i}
              className="font-mono text-[11px] leading-tight text-destructive"
            >
              {a.path ? (
                <span className="text-destructive/70">
                  {a.path}
                  {a.startLine ? `:${a.startLine}` : ""}:{" "}
                </span>
              ) : null}
              {a.title ? <strong>{a.title}: </strong> : null}
              {a.message ?? a.rawDetails ?? ""}
            </li>
          ))}
          {annotations.length > 6 ? (
            <li className="text-[11px] italic text-muted-foreground">
              + {annotations.length - 6} more — see full logs
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
