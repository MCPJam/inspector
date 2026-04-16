/**
 * Release Progress Stepper tile.
 *
 * While a `release.yml` run is in-flight, renders each job as a row with
 * status + elapsed time. When nothing is running, shows the most recent
 * completed run's outcome so engineers can still see "did last night's
 * release finish, and how did it go?" without clicking into GH Actions.
 *
 * Server component does the fetch; a tiny client child refreshes the page
 * every 10s while a run is live. Not SWR / not an API route — the server
 * component already has `revalidate: 10` on its calls while active, so
 * `router.refresh()` is enough to re-render with fresh data.
 */

import {
  getLatestWorkflowRun,
  getWorkflowRunJobs,
  listWorkflowRuns,
  type WorkflowJob,
  type WorkflowRun
} from "@/lib/github";
import { Badge, StatusDot, Tile, type StatusTone } from "@/components/ui";
import { formatElapsed, formatRelativeTime, shortSha } from "@/lib/format";
import { ReleaseProgressRefresher } from "@/components/release-progress-refresher";

const INSPECTOR = { owner: "MCPJam", repo: "inspector" };
const RELEASE_WORKFLOW = "release.yml";

/** release.yml's job order. Kept in sync manually with the workflow file. */
const JOB_ORDER = [
  "preflight",
  "build-mac",
  "build-windows",
  "artifact-gate",
  "publish-packages",
  "deploy-backend-prod",
  "promote-production",
  "finalize"
];

export function ReleaseProgressSkeleton() {
  return (
    <Tile title="Release progress">
      <p className="text-sm text-neutral-400">Checking for an active run…</p>
    </Tile>
  );
}

export async function ReleaseProgress() {
  // 1. Look for an in-flight run first (queued OR in_progress).
  //    GitHub accepts one status at a time, so we do two small calls.
  let activeRun: WorkflowRun | null = null;
  try {
    const [inProgress, queued] = await Promise.all([
      listWorkflowRuns(INSPECTOR.owner, INSPECTOR.repo, RELEASE_WORKFLOW, {
        status: "in_progress",
        perPage: 5,
        revalidate: 10
      }),
      listWorkflowRuns(INSPECTOR.owner, INSPECTOR.repo, RELEASE_WORKFLOW, {
        status: "queued",
        perPage: 5,
        revalidate: 10
      })
    ]);
    // Prefer an actively executing run over a queued one — a queued run has
    // no job data yet, so the stepper would collapse to "pending" and hide
    // the real progress of whatever is currently running. Fall back to
    // queued only if nothing is actively running.
    activeRun = inProgress[0] ?? queued[0] ?? null;
  } catch (err) {
    return (
      <Tile title="Release progress">
        <p className="text-sm text-red-500">
          Failed to read workflow runs: {(err as Error).message}
        </p>
      </Tile>
    );
  }

  // 2. If none, fall back to the most recent completed run.
  if (!activeRun) {
    let last: WorkflowRun | null = null;
    try {
      last = await getLatestWorkflowRun(
        INSPECTOR.owner,
        INSPECTOR.repo,
        RELEASE_WORKFLOW,
        { status: "completed", perPage: 1 }
      );
    } catch (err) {
      return (
        <Tile title="Release progress">
          <p className="text-sm text-red-500">
            Failed to read workflow runs: {(err as Error).message}
          </p>
        </Tile>
      );
    }
    if (!last) {
      return (
        <Tile title="Release progress">
          <p className="text-sm text-neutral-500">
            No release.yml runs on record yet.
          </p>
        </Tile>
      );
    }
    return <CompletedRunTile run={last} />;
  }

  // 3. Active run — fetch jobs, render stepper, poll.
  let jobs: WorkflowJob[];
  try {
    jobs = await getWorkflowRunJobs(
      INSPECTOR.owner,
      INSPECTOR.repo,
      activeRun.id,
      { revalidate: 10 }
    );
  } catch (err) {
    return (
      <Tile title="Release progress">
        <p className="text-sm text-red-500">
          Active run {activeRun.id}, but failed to read jobs: {(err as Error).message}
        </p>
      </Tile>
    );
  }

  return (
    <Tile
      title="Release progress"
      action={
        <a
          href={activeRun.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
        >
          Run #{activeRun.id} ↗
        </a>
      }
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 text-xs text-neutral-500">
        <Badge tone="running">running</Badge>
        <span>
          on{" "}
          <span className="font-mono text-neutral-700 dark:text-neutral-200">
            {activeRun.headBranch ?? "main"}
          </span>{" "}
          @{" "}
          <span className="font-mono">{shortSha(activeRun.headSha)}</span>
        </span>
        {activeRun.actor ? <span>triggered by {activeRun.actor}</span> : null}
        {activeRun.runStartedAt ? (
          <span>started {formatRelativeTime(activeRun.runStartedAt)}</span>
        ) : null}
      </div>

      <JobStepper jobs={jobs} />
      <ReleaseProgressRefresher intervalMs={10_000} />
    </Tile>
  );
}

function CompletedRunTile({ run }: { run: WorkflowRun }) {
  const tone: StatusTone =
    run.conclusion === "success"
      ? "success"
      : run.conclusion === "failure"
        ? "failure"
        : run.conclusion === "cancelled"
          ? "neutral"
          : "warning";
  return (
    <Tile
      title="Release progress"
      action={
        <a
          href={run.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
        >
          Run #{run.id} ↗
        </a>
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-3 text-sm text-neutral-500">
        <Badge tone={tone}>{run.conclusion ?? "unknown"}</Badge>
        <span className="text-neutral-700 dark:text-neutral-200">
          {run.displayTitle || "release.yml"}
        </span>
        <span>
          on <span className="font-mono">{shortSha(run.headSha)}</span>
        </span>
        <span>finished {formatRelativeTime(run.updatedAt)}</span>
        {run.actor ? <span>by {run.actor}</span> : null}
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        No release.yml run currently in-flight. Trigger one from the panel
        below or{" "}
        <a
          href={`https://github.com/${INSPECTOR.owner}/${INSPECTOR.repo}/actions/workflows/${RELEASE_WORKFLOW}`}
          target="_blank"
          rel="noreferrer"
          className="hover:underline"
        >
          from GitHub
        </a>
        .
      </p>
    </Tile>
  );
}

function JobStepper({ jobs }: { jobs: WorkflowJob[] }) {
  // Order jobs by release.yml's declared order. Jobs we don't recognize (new
  // reusable workflows added later) are appended after the known ones rather
  // than dropped — so a stale JOB_ORDER never hides progress.
  const byName = new Map(jobs.map((j) => [j.name, j]));
  const known = JOB_ORDER.map((n) => ({ name: n, job: byName.get(n) ?? null }));
  const unknown = jobs.filter((j) => !JOB_ORDER.includes(j.name));

  return (
    <ol className="space-y-1.5">
      {known.map(({ name, job }) => (
        <JobRow key={name} name={name} job={job} />
      ))}
      {unknown.map((job) => (
        <JobRow key={job.name} name={job.name} job={job} />
      ))}
    </ol>
  );
}

function JobRow({ name, job }: { name: string; job: WorkflowJob | null }) {
  if (!job) {
    return (
      <li className="flex items-center gap-3 text-sm text-neutral-500">
        <StatusDot tone="neutral" />
        <span className="font-mono text-xs">{name}</span>
        <span className="text-xs text-neutral-400">pending / not scheduled</span>
      </li>
    );
  }
  const tone = jobTone(job);
  const elapsed = formatElapsed(job.startedAt, job.completedAt);
  return (
    <li className="flex items-center gap-3 text-sm">
      <StatusDot tone={tone} />
      <a
        href={job.htmlUrl}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-xs text-neutral-700 hover:underline dark:text-neutral-200"
      >
        {job.name}
      </a>
      <Badge tone={tone}>
        {job.status === "completed" ? job.conclusion ?? "done" : job.status}
      </Badge>
      {elapsed ? (
        <span className="text-xs text-neutral-500">{elapsed}</span>
      ) : null}
      {tone === "failure" ? <FailingStep job={job} /> : null}
    </li>
  );
}

function FailingStep({ job }: { job: WorkflowJob }) {
  // `jobTone` above treats `failure` and `timed_out` identically; match that
  // here so a timed-out job surfaces its culprit step instead of rendering
  // just the tone badge with no detail.
  const failing = job.steps.find(
    (s) => s.conclusion === "failure" || s.conclusion === "timed_out"
  );
  if (!failing) return null;
  return (
    <span className="text-xs text-red-500">
      failed at step {failing.number}: {failing.name}
    </span>
  );
}

function jobTone(job: WorkflowJob): StatusTone {
  if (job.status !== "completed") {
    if (job.status === "queued" || job.status === "waiting") return "neutral";
    return "running";
  }
  switch (job.conclusion) {
    case "success":
      return "success";
    case "failure":
    case "timed_out":
      return "failure";
    case "cancelled":
    case "skipped":
      return "neutral";
    default:
      return "warning";
  }
}
