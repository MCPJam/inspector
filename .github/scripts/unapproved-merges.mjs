// Lists pull requests merged into the default branch without an approving
// review from a person other than the author. The org ruleset requires one
// approval, but admins on a bypass list can merge without it, and the merge
// API records no flag saying a bypass happened — so this reconstructs it from
// the reviews. Report only: it never fails the run on what it finds.
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Whether `pr` merged with an approval that counts: state APPROVED, from a
 * human account (bot approvals such as review assistants do not satisfy the
 * control), not the author, and submitted before the merge.
 */
export function hasQualifyingApproval(pr, reviews) {
  const mergedAt = Date.parse(pr.merged_at);
  return reviews.some(
    (review) =>
      review.state === "APPROVED" &&
      review.user?.type === "User" &&
      review.user.login !== pr.user.login &&
      Date.parse(review.submitted_at) <= mergedAt,
  );
}

export function summarize(merges) {
  const unapproved = merges.filter((m) => !m.approved);
  const selfMerged = unapproved.filter((m) => m.mergedBy === m.author);
  return {
    total: merges.length,
    unapproved: unapproved.length,
    selfMerged: selfMerged.length,
    byMerger: Object.entries(
      unapproved.reduce((acc, m) => {
        acc[m.mergedBy] = (acc[m.mergedBy] ?? 0) + 1;
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
          `| [#${m.number}](${m.url}) ${m.title.replaceAll("|", "\\|")} | ${m.author} | ${m.mergedBy} | ${m.mergedAt} |`,
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

async function mergedSince(repo, base, since, token) {
  const merged = [];
  for (let page = 1; ; page++) {
    const prs = await github(
      `/repos/${repo}/pulls?state=closed&base=${base}&sort=updated&direction=desc&per_page=100&page=${page}`,
      token,
    );
    for (const pr of prs) {
      if (pr.merged_at && Date.parse(pr.merged_at) >= since.getTime()) {
        merged.push(pr);
      }
    }
    // Sorted by last update, and a merge is an update, so once a page ends
    // before the window no later page can hold a merge inside it.
    const last = prs.at(-1);
    if (prs.length < 100 || Date.parse(last.updated_at) < since.getTime()) {
      return merged;
    }
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
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);
  const { default_branch: base } = await github(`/repos/${repo}`, token);

  const merges = [];
  for (const listed of await mergedSince(repo, base, since, token)) {
    // The list endpoint omits `merged_by`; only the single-PR read has it.
    const pr = await github(`/repos/${repo}/pulls/${listed.number}`, token);
    const reviews = await github(
      `/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`,
      token,
    );
    merges.push({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user.login,
      mergedBy: pr.merged_by?.login ?? "unknown",
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
