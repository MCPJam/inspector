#!/usr/bin/env node
/**
 * Hand a PR to a person once the bot is done with it: mark the draft ready,
 * which makes GitHub request the code owners, re-request anyone the draft step
 * took off, and assign one reviewer. The bot is done when its last run pushed
 * nothing, or when the head is its own review fix and the checks on it passed.
 *
 * Only in "on" mode: in suggest mode the bot only comments. A PR labelled
 * HOLD_LABEL is left as a draft; removing the label re-runs the checks, and
 * the next gate hands it over. Running again on a PR already handed over does
 * nothing.
 *
 * Env: GITHUB_TOKEN (the bot's app token), GITHUB_REPOSITORY, APP_SLUG,
 * STATE_DIR, CODEOWNERS_PATH (the default branch's CODEOWNERS). Reads
 * `gate.json`.
 */
import { readFileSync } from "node:fs";
import {
  HOLD_LABEL, githubClient, graphqlClient, isEntrypoint, readState, requireEnv, runEntrypoint,
} from "./review-common.mjs";
import { readSummary, updateSummary } from "./review-summary.mjs";

const REVIEWER_POLLS = 5;
const POLL_MS = 2_000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The owners of CODEOWNERS' catch-all `*` rule, without teams. */
export function defaultOwners(codeowners) {
  const rule = codeowners.split("\n").map((line) => line.replace(/#.*/, "").trim().split(/\s+/))
    .filter(([pattern]) => pattern === "*").at(-1);
  return (rule ?? []).slice(1).filter((owner) => /^@[\w-]+$/.test(owner)).map((owner) => owner.slice(1));
}

/**
 * One reviewer from the candidates, never the author or a bot. The PR number
 * picks among them, so the choice is stable across runs and spreads the load.
 */
export function pickReviewer(candidates, { author, pr }) {
  const people = [...new Set(candidates)].filter((login) => login && login !== author && !login.endsWith("[bot]")).sort();
  return people.length ? people[pr % people.length] : null;
}

async function requestedUsers(request, pr, polls) {
  for (let attempt = 1; attempt <= polls; attempt++) {
    const { users = [] } = await request(`pulls/${pr}/requested_reviewers`);
    if (users.length || attempt === polls) return users.map((user) => user.login);
    // GitHub adds the code owners just after the PR leaves draft.
    await sleep(POLL_MS);
  }
  return [];
}

export async function handoff({ gate, request, graphql, login, codeowners, polls = REVIEWER_POLLS }) {
  if (gate.mode !== "on") return { skipped: "Hand-off only runs when the pipeline is on." };
  const pr = await request(`pulls/${gate.pr}`);
  if (pr.state !== "open" || pr.head.sha !== gate.sha) return { skipped: "The PR moved on; its new head gets its own run." };
  if (pr.draft && (pr.labels ?? []).some((label) => label.name === HOLD_LABEL)) {
    await updateSummary(request, gate.pr, login, (state) => ({ ...state, hold: true }));
    return { skipped: `Held by the ${HOLD_LABEL} label.` };
  }
  if ((pr.assignees ?? []).length && !pr.draft) return { skipped: "The PR is already ready and assigned." };

  if (pr.draft) {
    await graphql("mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }",
      { id: pr.node_id });
  }
  const author = pr.user?.login ?? gate.author;
  const requested = await requestedUsers(request, gate.pr, polls);
  const held = (await readSummary(request, gate.pr, login)).state.heldReviewers;
  const reviewer = pickReviewer(requested.length ? requested : defaultOwners(codeowners), { author, pr: gate.pr });
  const toRequest = [...new Set([...held, ...(reviewer && !requested.includes(reviewer) ? [reviewer] : [])])]
    .filter((user) => user !== author && !requested.includes(user));
  if (toRequest.length) {
    await request(`pulls/${gate.pr}/requested_reviewers`, { method: "POST", body: { reviewers: toRequest } });
  }
  if (reviewer && !(pr.assignees ?? []).length) {
    await request(`issues/${gate.pr}/assignees`, { method: "POST", body: { assignees: [reviewer] } });
  }
  await updateSummary(request, gate.pr, login, (state) => ({
    ...state,
    hold: false,
    heldReviewers: [],
    handoff: { reviewer, sha: gate.sha },
    status: reviewer
      ? `**Ready for review.** The bot is done with \`${gate.sha.slice(0, 7)}\` and assigned @${reviewer}.`
      : `**Ready for review.** The bot is done with \`${gate.sha.slice(0, 7)}\`, but found no code owner to assign.`,
  }));
  return { reviewer, markedReady: Boolean(pr.draft) };
}

export async function main() {
  requireEnv(["GITHUB_TOKEN", "GITHUB_REPOSITORY", "APP_SLUG", "STATE_DIR"]);
  let codeowners = "";
  try {
    codeowners = readFileSync(process.env.CODEOWNERS_PATH ?? ".github/CODEOWNERS", "utf8");
  } catch (error) {
    console.log(`::notice::No CODEOWNERS to fall back on (${error.message}).`);
  }
  const result = await handoff({
    gate: readState("gate"), request: githubClient(), graphql: graphqlClient(),
    login: `${process.env.APP_SLUG}[bot]`, codeowners,
  });
  console.log(result.skipped ? `::notice::${result.skipped}` : `Handed over to ${result.reviewer ?? "nobody"}.`);
}

if (isEntrypoint(import.meta.url)) runEntrypoint(main);
