// A security concern raised in PR review has to reach someone who owns it,
// not sit in a thread nobody reads. A comment or review that names a security
// problem, or the `security` label on a PR, opens one `security-triage` issue
// per PR, assigned to the triage owner with the remediation SLA, and replies
// on the PR so whoever raised it knows it was logged. Later flags on the same
// PR are added to that issue. Bot reviewers are skipped by the workflow.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const TRIAGE_LABEL = "security-triage";
const FLAG_LABEL = "security";
const FLAG =
  /(^|\s)\/security\b|\b(vulnerab\w*|exploit\w*|CVE-\d{4}-\d{4,}|RCE|remote code execution|arbitrary code|XSS|SSRF|CSRF|(sql|command|prompt|code) injection|path traversal|prototype pollution|auth\w* bypass|privilege escalation|security (issue|concern|risk|hole|bug|flaw|problem))\b/i;

/** Whether review text raises a security concern. Quoted lines are someone else's words. */
export function isSecurityFlag(text) {
  return FLAG.test((text ?? "").replace(/^\s*>.*$/gm, ""));
}

/** The PR, where the flag was raised and by whom, or null when the event is no flag. */
export function flagFromEvent(name, event) {
  if (name === "pull_request_target") {
    if (event.label?.name !== FLAG_LABEL) return null;
    return { pr: event.pull_request, url: event.pull_request.html_url, by: event.sender.login };
  }
  const note = name === "pull_request_review" ? event.review : event.comment;
  const pr = event.pull_request ?? (event.issue?.pull_request ? event.issue : null);
  if (!pr || !note || note.user.type === "Bot" || !isSecurityFlag(note.body)) return null;
  return { pr, url: note.html_url, by: note.user.login };
}

export function issueBody({ pr, url, by }, owner) {
  return [
    `@${by} raised a possible security problem on #${pr.number}: ${url}`,
    "",
    `**Owner:** ${owner ? `@${owner}` : "unassigned. Set the SECURITY_TRIAGE_OWNER repository variable."}`,
    "",
    "1. Confirm whether it is a real issue, and reply on the PR either way.",
    "2. If it is, set the severity here. Remediation SLA from that point: Critical 7 days, High 30 days.",
    "3. Close this issue with a one-line reason when it is fixed or ruled out.",
  ].join("\n");
}

const ackPrefix = (issue) => `Logged for security triage in #${issue}`;

/**
 * Open the PR's triage issue or add the flag to it, then make sure the PR links to it.
 * `gh.list` returns every page of a GitHub list endpoint.
 */
export async function recordFlag(flag, gh, owner) {
  const title = `Security flag on PR #${flag.pr.number}`;
  const triageIssues = async () =>
    (await gh.list(`/issues?labels=${TRIAGE_LABEL}&state=open`))
      .filter((issue) => issue.title === title)
      .sort((a, b) => a.number - b.number);
  let [issue] = await triageIssues();
  let created = false;
  if (!issue) {
    const mine = await gh.post("/issues", {
      title,
      body: issueBody(flag, owner),
      labels: [TRIAGE_LABEL],
      assignees: owner ? [owner] : [],
    });
    // Two flags at the same moment can both find no issue and both create one.
    // The later issue closes itself and its flag moves to the earlier one.
    const [first] = await triageIssues();
    issue = first && first.number < mine.number ? first : mine;
    created = issue === mine;
    if (!created) {
      await gh.post(`/issues/${mine.number}/comments`, { body: `Duplicate of #${issue.number}.` });
      await gh.patch(`/issues/${mine.number}`, { state: "closed", state_reason: "not_planned" });
    }
  }
  if (!created) await gh.post(`/issues/${issue.number}/comments`, { body: `Another flag from @${flag.by}: ${flag.url}` });
  // A rerun after a failed PR reply finds the issue already open, so check for the reply instead of assuming it.
  const prComments = await gh.list(`/issues/${flag.pr.number}/comments`);
  if (prComments.some((c) => c.body?.startsWith(ackPrefix(issue.number)))) return;
  await gh.post(`/issues/${flag.pr.number}/comments`, {
    body: `${ackPrefix(issue.number)}${owner ? `, owned by ${owner}` : ""}.`,
  });
}

async function main(env = process.env) {
  const flag = flagFromEvent(env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")));
  if (!flag) return;
  const api = async (path, init = {}) => {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  };
  const send = (method) => (path, body) => api(path, { method, body: JSON.stringify(body) });
  const list = async (path) => {
    const items = [];
    for (let page = 1; ; page++) {
      const batch = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  };
  const owner = env.SECURITY_TRIAGE_OWNER;
  if (!owner) console.error("::warning::SECURITY_TRIAGE_OWNER is not set; the triage issue has no assignee.");
  await recordFlag(flag, { list, post: send("POST"), patch: send("PATCH") }, owner);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
