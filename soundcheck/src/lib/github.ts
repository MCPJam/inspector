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
    const body = await res.text();
    throw new Error(
      `GitHub API ${res.status} for ${path}: ${body.slice(0, 200)}`
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

/**
 * Latest deployment for a GitHub Environment (the records every job with an
 * `environment:` clause creates). Returns null if the environment has no
 * deployment history.
 */
export async function getLatestEnvironmentDeployment(
  owner: string,
  repo: string,
  environment: string
): Promise<DeploymentInfo | null> {
  const path = `/repos/${owner}/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=1`;
  const data = (await githubFetch(path)) as Array<{
    sha: string;
    created_at: string;
    creator: { login: string } | null;
    environment: string;
    url: string;
  }>;
  if (data.length === 0) return null;
  const d = data[0];
  return {
    sha: d.sha,
    createdAt: d.created_at,
    creator: d.creator?.login ?? null,
    environment: d.environment,
    url: d.url
  };
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
 * Commits reachable from `head` but not `base`. `aheadBy` is the count.
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
