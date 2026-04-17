/**
 * Thin wrapper around the GitHub REST API for the reads Soundcheck
 * needs: environment deployments, commit comparisons, workflow runs,
 * repo contents, and release dispatch.
 *
 * Auth: `GITHUB_PAT` must be a fine-grained token with read-only access to
 * `contents`, `deployments`, `metadata`, and `actions` on the inspector and
 * backend repos. The separate `GITHUB_DISPATCH_PAT` (only read by
 * `dispatchWorkflow`) holds the `actions:write` scope used to trigger the
 * Release workflow; keeping the two split limits the blast radius of a leak.
 */

const GITHUB_API = "https://api.github.com";

function authHeaders(token?: string): Record<string, string> {
  const t = token ?? process.env.GITHUB_PAT;
  if (!t) {
    throw new Error("GITHUB_PAT is not set");
  }
  return {
    Authorization: `Bearer ${t}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

export interface FetchOptions {
  /** Seconds for Next's ISR revalidation. Default 30. Set 0 to disable. */
  revalidate?: number;
  /** Custom token override (used by `dispatchWorkflow` for the write PAT). */
  token?: string;
}

async function githubFetch(
  path: string,
  opts: FetchOptions = {}
): Promise<unknown> {
  const revalidate = opts.revalidate ?? 30;
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: authHeaders(opts.token),
    // Short revalidation: dashboard data is live-ish, GitHub rate limits are
    // generous enough that this is fine. Callers that need faster updates
    // (e.g. the active-release progress stepper) pass a smaller number.
    next: { revalidate }
  });
  if (!res.ok) {
    // Log the full body server-side for debugging, but surface only a
    // parsed `message` field (if present) in the user-facing error — avoids
    // dumping unfiltered upstream JSON into the rendered DOM.
    const rawBody = await res.text();
    console.error(`GitHub API ${res.status} for ${path}:`, rawBody);
    let upstreamMessage: string | null = null;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(rawBody) as { message?: unknown };
        if (typeof parsed.message === "string") {
          upstreamMessage = parsed.message;
        }
      } catch {
        // malformed JSON; fall through to generic message
      }
    }
    throw new Error(
      upstreamMessage
        ? `GitHub API ${res.status}: ${upstreamMessage}`
        : `GitHub API ${res.status} for ${path}`
    );
  }
  return res.json();
}

export interface DeploymentInfo {
  sha: string;
  createdAt: string;
  creator: string | null;
  environment: string;
  url: string;
}

async function getLatestDeploymentStatus(
  owner: string,
  repo: string,
  deploymentId: number
): Promise<string | null> {
  const path = `/repos/${owner}/${repo}/deployments/${deploymentId}/statuses?per_page=1`;
  const data = (await githubFetch(path)) as Array<{ state: string }>;
  return data[0]?.state ?? null;
}

/**
 * Latest successful deployment for a GitHub Environment.
 *
 * The list-deployments endpoint returns every deployment regardless of
 * status — including `pending`, `in_progress`, and `failure`. For the
 * dashboard we want the SHA that is actually running, so we walk back
 * through the most recent deployments and return the first whose latest
 * status is `success` (deployed cleanly) or `inactive` (deployed cleanly
 * but has since been superseded — still what was last live if no newer
 * deployment has reached `success` yet).
 */
export async function getLatestEnvironmentDeployment(
  owner: string,
  repo: string,
  environment: string
): Promise<DeploymentInfo | null> {
  const path = `/repos/${owner}/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=10`;
  const data = (await githubFetch(path)) as Array<{
    id: number;
    sha: string;
    created_at: string;
    creator: { login: string } | null;
    environment: string;
    url: string;
  }>;

  for (const d of data) {
    const state = await getLatestDeploymentStatus(owner, repo, d.id);
    if (state === "success" || state === "inactive") {
      return {
        sha: d.sha,
        createdAt: d.created_at,
        creator: d.creator?.login ?? null,
        environment: d.environment,
        url: d.url
      };
    }
  }
  return null;
}

export interface CompareCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export interface CompareResult {
  aheadBy: number;
  behindBy: number;
  commits: CompareCommit[];
}

/**
 * Commits reachable from `head` but not `base`. `aheadBy` is the true count.
 *
 * The compare endpoint caps `commits` at 250 items, so for very wide diffs
 * `commits.length` can be less than `aheadBy`. Always use `aheadBy` when
 * reporting counts to the user; the `commits` array is only for preview.
 */
export async function compareCommits(
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<CompareResult> {
  const path = `/repos/${owner}/${repo}/compare/${base}...${head}`;
  const data = (await githubFetch(path)) as {
    ahead_by: number;
    behind_by: number;
    commits: Array<{
      sha: string;
      commit: { message: string; author: { name: string; date: string } };
      html_url: string;
    }>;
  };
  return {
    aheadBy: data.ahead_by,
    behindBy: data.behind_by,
    commits: data.commits.map((c) => ({
      sha: c.sha,
      message: c.commit.message.split("\n")[0],
      author: c.commit.author.name,
      date: c.commit.author.date,
      url: c.html_url
    }))
  };
}

/* ──────────────────────────────────────────────────────────────────────────
   Branch heads + repo contents (for the readiness + dry-run tiles)
   ────────────────────────────────────────────────────────────────────────── */

export interface BranchHead {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export async function getBranchHead(
  owner: string,
  repo: string,
  branch: string
): Promise<BranchHead> {
  const data = (await githubFetch(
    `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`
  )) as {
    commit: {
      sha: string;
      html_url: string;
      commit: {
        message: string;
        author: { name: string; date: string };
      };
    };
  };
  return {
    sha: data.commit.sha,
    message: data.commit.commit.message.split("\n")[0],
    author: data.commit.commit.author.name,
    date: data.commit.commit.author.date,
    url: data.commit.html_url
  };
}

/**
 * Fetches a text file from a repo at `ref`. Returns the decoded contents.
 * Uses the contents API (not raw.githubusercontent.com) so it works with the
 * fine-grained PAT we already have.
 */
export async function getRepoFile(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string> {
  const data = (await githubFetch(
    `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`
  )) as { content: string; encoding: string };
  if (data.encoding !== "base64") {
    throw new Error(`Unexpected encoding for ${path}: ${data.encoding}`);
  }
  return Buffer.from(data.content, "base64").toString("utf8");
}

export interface RepoDirEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

export async function listRepoDir(
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<RepoDirEntry[]> {
  const data = (await githubFetch(
    `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`
  )) as Array<{ name: string; path: string; type: RepoDirEntry["type"] }>;
  return data.map((e) => ({ name: e.name, path: e.path, type: e.type }));
}

/* ──────────────────────────────────────────────────────────────────────────
   Workflow runs + jobs (progress stepper, failure diagnostics, release gate)
   ────────────────────────────────────────────────────────────────────────── */

export interface WorkflowRun {
  id: number;
  name: string | null;
  headSha: string;
  headBranch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
  htmlUrl: string;
  actor: string | null;
  displayTitle: string;
}

function mapRun(raw: {
  id: number;
  name?: string | null;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  run_started_at?: string | null;
  html_url: string;
  actor?: { login: string } | null;
  display_title?: string;
}): WorkflowRun {
  return {
    id: raw.id,
    name: raw.name ?? null,
    headSha: raw.head_sha,
    headBranch: raw.head_branch,
    event: raw.event,
    status: raw.status,
    conclusion: raw.conclusion,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    runStartedAt: raw.run_started_at ?? null,
    htmlUrl: raw.html_url,
    actor: raw.actor?.login ?? null,
    displayTitle: raw.display_title ?? raw.name ?? ""
  };
}

export interface ListRunsOptions {
  branch?: string;
  status?: string;
  event?: string;
  headSha?: string;
  perPage?: number;
  revalidate?: number;
}

export async function listWorkflowRuns(
  owner: string,
  repo: string,
  workflowFile: string,
  opts: ListRunsOptions = {}
): Promise<WorkflowRun[]> {
  const qs = new URLSearchParams();
  if (opts.branch) qs.set("branch", opts.branch);
  if (opts.status) qs.set("status", opts.status);
  if (opts.event) qs.set("event", opts.event);
  if (opts.headSha) qs.set("head_sha", opts.headSha);
  qs.set("per_page", String(opts.perPage ?? 20));
  const path = `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(
    workflowFile
  )}/runs?${qs.toString()}`;
  const data = (await githubFetch(path, { revalidate: opts.revalidate })) as {
    workflow_runs: Parameters<typeof mapRun>[0][];
  };
  return data.workflow_runs.map(mapRun);
}

export async function getLatestWorkflowRun(
  owner: string,
  repo: string,
  workflowFile: string,
  opts: ListRunsOptions = {}
): Promise<WorkflowRun | null> {
  const runs = await listWorkflowRuns(owner, repo, workflowFile, {
    ...opts,
    perPage: opts.perPage ?? 1
  });
  return runs[0] ?? null;
}

/**
 * Look for a completed, successful run of `workflowFile` on `branch` that
 * matches `headSha`. Mirrors the query in release.yml's staging-gate step so
 * the readiness tile and the release workflow agree on what "green staging
 * for this SHA" means.
 */
export async function findSuccessfulRunForSha(
  owner: string,
  repo: string,
  workflowFile: string,
  branch: string,
  headSha: string
): Promise<WorkflowRun | null> {
  const runs = await listWorkflowRuns(owner, repo, workflowFile, {
    branch,
    status: "completed",
    perPage: 50
  });
  return (
    runs.find(
      (r) => r.headSha === headSha && r.conclusion === "success"
    ) ?? null
  );
}

/**
 * Latest successful run of `workflowFile` on `branch`. Walks back through
 * the most recent completed runs and returns the first `success`.
 *
 * Used by the MCP staging-drift tile: "what SHA was last successfully
 * deployed?" For services without a production environment (like
 * mcpjam-mcp-staging today), the SHA of the last green deploy workflow is
 * the best proxy for "what's live right now".
 */
export async function findLatestSuccessfulRun(
  owner: string,
  repo: string,
  workflowFile: string,
  branch: string
): Promise<WorkflowRun | null> {
  const runs = await listWorkflowRuns(owner, repo, workflowFile, {
    branch,
    status: "completed",
    perPage: 30
  });
  return runs.find((r) => r.conclusion === "success") ?? null;
}

export async function getMostRecentFailedRun(
  owner: string,
  repo: string,
  workflowFile: string,
  sinceIso: string
): Promise<WorkflowRun | null> {
  const runs = await listWorkflowRuns(owner, repo, workflowFile, {
    status: "completed",
    perPage: 30
  });
  const cutoff = new Date(sinceIso).getTime();
  for (const r of runs) {
    if (new Date(r.updatedAt).getTime() < cutoff) break;
    if (r.conclusion && r.conclusion !== "success" && r.conclusion !== "skipped" && r.conclusion !== "cancelled") {
      return r;
    }
  }
  return null;
}

export interface WorkflowJobStep {
  name: string;
  status: string;
  conclusion: string | null;
  number: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string;
  steps: WorkflowJobStep[];
  checkRunUrl: string | null;
}

export async function getWorkflowRunJobs(
  owner: string,
  repo: string,
  runId: number,
  opts: { revalidate?: number } = {}
): Promise<WorkflowJob[]> {
  const data = (await githubFetch(
    `/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=30`,
    { revalidate: opts.revalidate }
  )) as {
    jobs: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      started_at: string | null;
      completed_at: string | null;
      html_url: string;
      check_run_url?: string | null;
      steps?: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        number: number;
        started_at: string | null;
        completed_at: string | null;
      }>;
    }>;
  };
  return data.jobs.map((j) => ({
    id: j.id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    htmlUrl: j.html_url,
    checkRunUrl: j.check_run_url ?? null,
    steps: (j.steps ?? []).map((s) => ({
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
      number: s.number,
      startedAt: s.started_at,
      completedAt: s.completed_at
    }))
  }));
}

export interface CheckRunAnnotation {
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  annotationLevel: string | null;
  title: string | null;
  message: string | null;
  rawDetails: string | null;
}

/**
 * Fetches annotations from the check-run attached to a workflow job. Returns
 * structured error lines (path, line, message) — much lighter than parsing
 * the log zip.
 *
 * `checkRunUrl` is the full API URL the jobs endpoint returns for each job
 * (e.g. `https://api.github.com/repos/.../check-runs/12345`). We derive the
 * check-run ID from its tail to avoid hardcoding the base.
 */
export async function getJobAnnotations(
  owner: string,
  repo: string,
  checkRunUrl: string
): Promise<CheckRunAnnotation[]> {
  const match = checkRunUrl.match(/\/check-runs\/(\d+)/);
  if (!match) return [];
  const checkRunId = match[1];
  const data = (await githubFetch(
    `/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations?per_page=50`
  )) as Array<{
    path: string | null;
    start_line: number | null;
    end_line: number | null;
    annotation_level: string | null;
    title: string | null;
    message: string | null;
    raw_details: string | null;
  }>;
  return data.map((a) => ({
    path: a.path,
    startLine: a.start_line,
    endLine: a.end_line,
    annotationLevel: a.annotation_level,
    title: a.title,
    message: a.message,
    rawDetails: a.raw_details
  }));
}

/* ──────────────────────────────────────────────────────────────────────────
   Workflow dispatch (Run Release button — write scope)
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Dispatches a workflow via `POST /actions/workflows/{file}/dispatches`.
 *
 * Takes an explicit `token` instead of falling back to `GITHUB_PAT`. The
 * write PAT is read from `GITHUB_DISPATCH_PAT` by the caller (the
 * `/api/release/dispatch` route) and passed through here. Keeping the write
 * token out of the module-level env read means no accidental use of a
 * write-scoped token by one of the read helpers above.
 */
export async function dispatchWorkflow(
  owner: string,
  repo: string,
  workflowFile: string,
  ref: string,
  inputs: Record<string, string>,
  token: string
): Promise<void> {
  if (!token) {
    throw new Error("dispatchWorkflow requires an explicit write token");
  }
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(
      workflowFile
    )}/dispatches`,
    {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ ref, inputs }),
      cache: "no-store"
    }
  );
  if (!res.ok) {
    const rawBody = await res.text();
    console.error(
      `GitHub dispatch ${res.status} for ${workflowFile}:`,
      rawBody
    );
    let upstreamMessage: string | null = null;
    try {
      const parsed = JSON.parse(rawBody) as { message?: unknown };
      if (typeof parsed.message === "string") upstreamMessage = parsed.message;
    } catch {
      // ignore
    }
    throw new Error(
      upstreamMessage
        ? `GitHub dispatch ${res.status}: ${upstreamMessage}`
        : `GitHub dispatch ${res.status} for ${workflowFile}`
    );
  }
}
