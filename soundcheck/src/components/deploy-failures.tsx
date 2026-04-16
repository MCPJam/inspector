/**
 * Deploy Failure Diagnostics tile.
 *
 * One row per tracked workflow. For each, the most recent failed run within
 * the lookback window (default 7d) — with the failing job, the failing
 * step, and check-run annotations surfaced inline. The annotations API
 * gives us structured error lines (path, line, message) without needing
 * to download and parse the log zip.
 *
 * If a workflow has no failures in the lookback window, its row reads
 * "No failures in the last Nd" — which is itself useful signal.
 */

import {
  getJobAnnotations,
  getMostRecentFailedRun,
  getWorkflowRunJobs,
  type CheckRunAnnotation,
  type WorkflowJob,
  type WorkflowRun
} from "@/lib/github";
import { Badge, Tile } from "@/components/ui";
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
    <Tile title="Recent failures">
      <p className="text-sm text-neutral-400">Scanning workflows…</p>
    </Tile>
  );
}

export async function DeployFailures() {
  const since = new Date(
    Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const rows = await Promise.all(
    TARGETS.map((t) => buildRow(t, since).catch((err) => ({
      target: t,
      state: "error" as const,
      message: (err as Error).message
    })))
  );

  return (
    <Tile title={`Recent failures (last ${LOOKBACK_DAYS}d)`}>
      <ul className="space-y-4">
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

  // Pick the first failing job and pull its annotations. Logs zip is too
  // heavy for a tile; annotations give us the actual error lines.
  let failingJob: WorkflowJob | null = null;
  let annotations: CheckRunAnnotation[] = [];
  try {
    const jobs = await getWorkflowRunJobs(target.owner, target.repo, failed.id);
    failingJob =
      jobs.find(
        (j) =>
          j.conclusion === "failure" ||
          j.conclusion === "timed_out"
      ) ?? null;
    if (failingJob?.checkRunUrl) {
      annotations = await getJobAnnotations(
        target.owner,
        target.repo,
        failingJob.checkRunUrl
      );
    }
  } catch (err) {
    // We still have the run + conclusion — surface the run without inline
    // diagnostics rather than failing the entire row.
    console.error(`Failed to enrich failure for ${target.label}:`, err);
  }
  return { target, state: "failed", run: failed, failingJob, annotations };
}

function FailureRow({ row }: { row: Row }) {
  if (row.state === "healthy") {
    return (
      <li className="flex items-baseline gap-3">
        <Badge tone="success">ok</Badge>
        <div className="text-sm text-neutral-500">
          <span className="text-neutral-700 dark:text-neutral-200">
            {row.target.label}
          </span>{" "}
          — no failures in the last {LOOKBACK_DAYS}d
        </div>
      </li>
    );
  }
  if (row.state === "error") {
    return (
      <li className="flex items-baseline gap-3">
        <Badge tone="warning">error</Badge>
        <div className="text-sm text-neutral-500">
          <span className="text-neutral-700 dark:text-neutral-200">
            {row.target.label}
          </span>{" "}
          — {row.message}
        </div>
      </li>
    );
  }

  const { run, failingJob, annotations } = row;
  const failingStep = failingJob?.steps.find((s) => s.conclusion === "failure");
  return (
    <li className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <Badge tone="failure">{run.conclusion ?? "failed"}</Badge>
        <span className="text-neutral-700 dark:text-neutral-200">
          {row.target.label}
        </span>
        <span className="text-xs text-neutral-500">
          run{" "}
          <a
            href={run.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            #{run.id}
          </a>{" "}
          · {formatRelativeTime(run.updatedAt)} · on{" "}
          <span className="font-mono">{shortSha(run.headSha)}</span>
          {run.actor ? <> · by {run.actor}</> : null}
        </span>
      </div>

      {failingJob ? (
        <div className="ml-0 text-xs text-neutral-500">
          <a
            href={failingJob.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-neutral-700 hover:underline dark:text-neutral-200"
          >
            {failingJob.name}
          </a>
          {failingStep ? (
            <>
              {" "}
              failed at step {failingStep.number}:{" "}
              <span className="text-neutral-700 dark:text-neutral-200">
                {failingStep.name}
              </span>
            </>
          ) : null}
        </div>
      ) : null}

      {annotations.length > 0 ? (
        <ul className="space-y-0.5 rounded border border-red-500/20 bg-red-500/5 p-2">
          {annotations.slice(0, 6).map((a, i) => (
            <li key={i} className="font-mono text-[11px] leading-tight text-red-700 dark:text-red-400">
              {a.path ? (
                <span className="text-red-500/80">
                  {a.path}
                  {a.startLine ? `:${a.startLine}` : ""}:{" "}
                </span>
              ) : null}
              {a.title ? <strong>{a.title}: </strong> : null}
              {a.message ?? a.rawDetails ?? ""}
            </li>
          ))}
          {annotations.length > 6 ? (
            <li className="text-[11px] text-neutral-500">
              + {annotations.length - 6} more — see full logs
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
