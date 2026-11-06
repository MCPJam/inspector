#!/usr/bin/env node
/**
 * Backstop for draft-first: a PR opened ready for review while the pipeline
 * is on goes back to draft, and the reviewers GitHub requested on open come
 * off, so nobody is asked to review until the bot hands the PR over. The
 * people taken off are remembered in the summary comment and asked again at
 * hand-off; the code owners come back on their own when the PR leaves draft.
 *
 * Runs only on `opened`: a person who marks a PR ready by hand is not
 * overruled.
 *
 * Env: GITHUB_TOKEN (the bot's app token), GITHUB_REPOSITORY, APP_SLUG,
 * PR_NUMBER, REVIEW_PIPELINE.
 */
import {
  githubClient, graphqlClient, isEntrypoint, requireEnv, runEntrypoint,
} from "./review-common.mjs";
import { pipelineMode } from "./review-gate.mjs";
import { updateSummary } from "./review-summary.mjs";

export const DRAFT_STATUS = "**Working.** This PR went back to draft so nobody is asked to review it yet. " +
  "The bot runs the checks, fixes what it safely can, and marks it ready and assigns a reviewer when it is done.";

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function toDraft({ number, request, graphql, login, repo, setting, settleMs = 3_000 }) {
  const pr = await request(`pulls/${number}`);
  if (pr.state !== "open" || pr.draft) return { skipped: "The PR is closed or already a draft." };
  if (pr.head.repo?.full_name !== repo) return { skipped: "Fork PRs are not run through the pipeline." };
  if (pipelineMode(setting, pr.labels ?? []) !== "on") return { skipped: "The pipeline is not on for this PR." };

  await graphql("mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }",
    { id: pr.node_id });
  // GitHub requests the code owners just after a PR opens, so read the
  // requests after the conversion has had a moment to settle, not from the event.
  await sleep(settleMs);
  const requested = await request(`pulls/${number}/requested_reviewers`);
  const users = (requested.users ?? []).map((user) => user.login);
  const teams = (requested.teams ?? []).map((team) => team.slug);
  if (users.length || teams.length) {
    await request(`pulls/${number}/requested_reviewers`, { method: "DELETE", body: { reviewers: users, team_reviewers: teams } });
  }
  await updateSummary(request, number, login, (state) => ({
    ...state, status: DRAFT_STATUS, heldReviewers: [...new Set([...state.heldReviewers, ...users])],
  }));
  return { converted: true, removed: users.length + teams.length };
}

export async function main() {
  requireEnv(["GITHUB_TOKEN", "GITHUB_REPOSITORY", "APP_SLUG", "PR_NUMBER"]);
  const result = await toDraft({
    number: Number(process.env.PR_NUMBER), request: githubClient(), graphql: graphqlClient(),
    login: `${process.env.APP_SLUG}[bot]`, repo: process.env.GITHUB_REPOSITORY, setting: process.env.REVIEW_PIPELINE,
  });
  console.log(result.skipped ? `::notice::${result.skipped}` : `Converted to draft; took off ${result.removed} reviewer requests.`);
}

if (isEntrypoint(import.meta.url)) runEntrypoint(main);
