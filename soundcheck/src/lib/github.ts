/**
 * Thin wrapper around the GitHub REST API for the reads Soundcheck
 * needs: latest environment deployments and commit comparisons.
 *
 * Auth: `GITHUB_PAT` must be a fine-grained token with read-only access to
 * `contents`, `deployments`, `metadata`, and `actions` on the inspector and
 * backend repos.
 */

const GITHUB_API = "https://api.github.com";

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_PAT;
  if (!token) {
    throw new Error("GITHUB_PAT is not set");
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function githubFetch(path: string): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: authHeaders(),
    // Short revalidation: dashboard data is live-ish, GitHub rate limits are
    // generous enough that this is fine.
    next: { revalidate: 30 }
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
