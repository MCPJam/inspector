// Lists pull requests merged into the default branch without an approving
// review from a person other than the author. The org ruleset requires one
// approval, but admins on a bypass list can merge without it, and the merge
// API records no flag saying a bypass happened — so this reconstructs it from
// the reviews. Report only: it never fails the run on what it finds.
// Direct pushes to the default branch never go through a PR and are not
// covered by this report.
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 31;
const MERGER_UNKNOWN = "(merger unknown)";

/**
 * Whether `pr` merged with an approval that counts. Like the ruleset, it reads
 * each reviewer's latest non-COMMENTED review submitted by the merge, so a
 * later CHANGES_REQUESTED or a dismissal replaces an earlier approval. One of
 * those stances must be APPROVED, from a human account (bot approvals such as
 * review assistants do not satisfy the control) other than the author. The
 * comparison is inclusive because auto-merge lands the approval and the merge
 * in the same second.
 */
export function hasQualifyingApproval(pr, reviews) {
  const mergedAt = Date.parse(pr.merged_at);
  const stances = new Map();
  for (const review of reviews) {
    // `!(<=)` also drops a review with no submitted_at (PENDING).
    if (
      !review.user ||
      review.state === "COMMENTED" ||
      !(Date.parse(review.submitted_at) <= mergedAt)
    ) {
      continue;
    }
    const prior = stances.get(review.user.login);
    // The API lists reviews oldest first, so on a tie the later entry wins.
    if (
      !prior ||
      Date.parse(review.submitted_at) >= Date.parse(prior.submitted_at)
    ) {
      stances.set(review.user.login, review);
    }
  }
  return [...stances.values()].some(
    (review) =>
      review.state === "APPROVED" &&
      review.user.type === "User" &&
      review.user.login !== pr.user.login,
  );
}

/**
 * The window a run reports on. Scheduled runs start minutes after the cron
 * time, so they anchor `until` to the most recent Monday 13:30 UTC (the cron
 * in unapproved-merge-report.yml) and cover the seven days before it, which
 * makes consecutive weekly windows tile with no gap or overlap. A manual run
 * reports the last `days` up to now.
 */
export function reportWindow({ now, days, scheduled }) {
  if (!scheduled) {
    return { since: new Date(now.getTime() - days * DAY_MS), until: now };
  }
  const until = new Date(now);
  until.setUTCHours(13, 30, 0, 0);
  // getUTCDay() is 0 on Sunday and 1 on Monday.
  until.setUTCDate(until.getUTCDate() - ((until.getUTCDay() + 6) % 7));
  if (until > now) {
    until.setUTCDate(until.getUTCDate() - 7);
  }
  return { since: new Date(until.getTime() - 7 * DAY_MS), until };
}

export function summarize(merges) {
  const unapproved = merges.filter((m) => !m.approved);
  const selfMerged = unapproved.filter((m) => m.mergedBy === m.author);
  const mergerUnknown = unapproved.filter((m) => m.mergedBy === null);
  return {
    total: merges.length,
    unapproved: unapproved.length,
    selfMerged: selfMerged.length,
    mergerUnknown: mergerUnknown.length,
    byMerger: Object.entries(
      unapproved.reduce((acc, m) => {
        const merger = m.mergedBy ?? MERGER_UNKNOWN;
        acc[merger] = (acc[merger] ?? 0) + 1;
        return acc;
      }, {}),
    ).sort((a, b) => b[1] - a[1]),
  };
}

export function renderMarkdown({ repo, since, until, merges }) {
  const s = summarize(merges);
  const lines = [
    `## Merges without an independent approval: ${repo}`,
    "",
    `Window: ${since.toISOString()} to ${until.toISOString()}`,
    "",
    `- Merged into the default branch: **${s.total}**`,
    `- Without an approving review from someone other than the author: **${s.unapproved}**`,
    `- Of those, merged by their own author: **${s.selfMerged}**`,
  ];
  if (s.mergerUnknown) {
    lines.push(
      `- Of those, merged with no merger recorded by GitHub, so a self-merge cannot be ruled out: **${s.mergerUnknown}**`,
    );
  }
  if (s.byMerger.length) {
    lines.push(
      "",
      "| Merged by | Unapproved merges |",
      "|---|---|",
      ...s.byMerger.map(([login, n]) => `| ${login} | ${n} |`),
    );
  }
  const unapproved = merges.filter((m) => !m.approved);
  if (unapproved.length) {
    lines.push(
      "",
      "| PR | Author | Merged by | Merged at |",
      "|---|---|---|---|",
      ...unapproved.map(
        (m) =>
          `| [#${m.number}](${m.url}) ${m.title.replaceAll("|", "\\|")} | ${m.author} | ${m.mergedBy ?? MERGER_UNKNOWN} | ${m.mergedAt} |`,
      ),
    );
  }
  return lines.join("\n") + "\n";
}

async function github(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Every item of a paginated list endpoint. `get` fetches one page; a page
 * shorter than the page size is the last one.
 */
export async function allPages(path, get) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await get(`${path}?per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) {
      return items;
    }
  }
}

/**
 * PRs merged in [since, until), read from a list of closed PRs sorted by last
 * update, newest first. `get` fetches one page.
 */
export async function mergedBetween(path, since, until, get) {
  const merged = new Map();
  let pastWindow = false;
  for (let page = 1; ; page++) {
    const prs = await get(`${path}&per_page=100&page=${page}`);
    for (const pr of prs) {
      const mergedAt = Date.parse(pr.merged_at);
      if (mergedAt >= since.getTime() && mergedAt < until.getTime()) {
        // An update between two page fetches moves a PR to page 1 and shifts
        // the rest down one, so the same PR can be listed on two pages.
        merged.set(pr.number, pr);
      }
    }
    // A merge is an update, so once a page ends before the window no later
    // page can hold a merge inside it. The same shift can push a PR from
    // this page onto the next, so read one more page before stopping.
    if (prs.length < 100 || pastWindow) {
      return [...merged.values()];
    }
    pastWindow = Date.parse(prs.at(-1).updated_at) < since.getTime();
  }
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const days = Number(process.env.REPORT_DAYS ?? "7");
  if (!token || !repo || !Number.isFinite(days) || days <= 0) {
    throw new Error(
      "GITHUB_TOKEN, GITHUB_REPOSITORY and a positive REPORT_DAYS are required",
    );
  }
  if (days > MAX_DAYS) {
    // Each merged PR costs at least two sequential calls, and the 1,000
    // requests an hour GITHUB_TOKEN gets are shared with every other workflow.
    throw new Error(
      `REPORT_DAYS is ${days}; the maximum is ${MAX_DAYS}. A longer window can exhaust the GITHUB_TOKEN rate limit, which fails as a 403. Report a longer period as several runs.`,
    );
  }
  const { since, until } = reportWindow({
    now: new Date(),
    days,
    scheduled: process.env.GITHUB_EVENT_NAME === "schedule",
  });
  const { default_branch: base } = await github(`/repos/${repo}`, token);

  const listed = await mergedBetween(
    `/repos/${repo}/pulls?state=closed&base=${base}&sort=updated&direction=desc`,
    since,
    until,
    (path) => github(path, token),
  );
  const merges = [];
  for (const { number } of listed) {
    // The list endpoint omits `merged_by`; only the single-PR read has it.
    const pr = await github(`/repos/${repo}/pulls/${number}`, token);
    // An approval past the first page still counts.
    const reviews = await allPages(
      `/repos/${repo}/pulls/${pr.number}/reviews`,
      (path) => github(path, token),
    );
    merges.push({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user.login,
      // Nullable on this endpoint. Kept as null so the report shows it as an
      // anomaly instead of a login that never matches the author.
      mergedBy: pr.merged_by?.login ?? null,
      mergedAt: pr.merged_at,
      approved: hasQualifyingApproval(pr, reviews),
    });
  }
  merges.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));

  const markdown = renderMarkdown({ repo, since, until, merges });
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  writeFileSync(
    "unapproved-merges.json",
    JSON.stringify(
      { repo, since, until, summary: summarize(merges), merges },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
