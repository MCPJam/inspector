import assert from "node:assert/strict";
import { test } from "node:test";
import { DAILY_RELEASE_CHECKS, readDailyCandidate, selectDailyCandidate, staleCandidateMessage } from "./daily-release-candidate.mjs";

const repository = "MCPJam/inspector";
const now = Date.parse("2026-10-12T00:00:00Z");
const newest = "a".repeat(40);
const older = "b".repeat(40);
const commit = (sha, age = 1) => ({ sha, committedAt: new Date(now - age * 3_600_000).toISOString() });
const run = (sha, overrides = {}) => ({
  head_sha: sha, event: "push", head_branch: "main", head_repository: { full_name: repository },
  status: "completed", conclusion: "success", run_number: 1, run_attempt: 1,
  html_url: `https://github.com/${repository}/actions/runs/1`, ...overrides,
});
const evidence = (runs = [run(newest), run(older)]) => Object.fromEntries(DAILY_RELEASE_CHECKS.map((workflow) => [workflow, runs]));
const select = (overrides = {}) => selectDailyCandidate({
  repository, now, commits: [commit(newest), commit(older, 13)], runsByWorkflow: evidence(), ...overrides,
});

test("selects the newest merged commit with every required workflow passing", () => {
  assert.equal(select().sha, newest);
  assert.equal(select().stale, false);
  assert.equal(select().evidence.length, DAILY_RELEASE_CHECKS.length);
});

test("falls back when a newer commit is failed, pending, skipped or cancelled", () => {
  for (const conclusion of ["failure", null, "skipped", "cancelled"]) {
    const runsByWorkflow = evidence();
    runsByWorkflow[DAILY_RELEASE_CHECKS[0]] = [run(newest, { conclusion }), run(older)];
    assert.equal(select({ runsByWorkflow }).sha, older);
  }
});

test("a newer failure or running retry overrides an earlier success", () => {
  for (const retry of [
    run(newest, { run_number: 2, conclusion: "failure" }),
    run(newest, { run_attempt: 2, status: "in_progress", conclusion: null }),
  ]) {
    const runsByWorkflow = evidence([run(newest), retry, run(older)]);
    assert.equal(select({ runsByWorkflow }).sha, older);
  }
});

test("PRs, other branches, manual runs, and fork evidence cannot authorize release", () => {
  for (const overrides of [
    { event: "pull_request" }, { event: "workflow_dispatch" },
    { head_branch: "feature" }, { head_repository: { full_name: "someone/inspector" } },
  ]) {
    assert.equal(select({ runsByWorkflow: evidence([run(newest, overrides), run(older)]) }).sha, older);
  }
});

test("uses history order instead of timestamps and excludes commits outside main history", () => {
  assert.equal(select({ commits: [commit(older), commit(newest, 13)] }).sha, older);
  assert.equal(select({ commits: [commit(older)] }).sha, older);
});

test("warns strictly beyond 12 hours and includes commit and run links", () => {
  assert.equal(select({ commits: [commit(newest, 12)] }).stale, false);
  const candidate = select({ commits: [commit(newest, 12.01)] });
  assert.equal(candidate.stale, true);
  const message = staleCandidateMessage(candidate, repository, "https://github.com/run");
  assert.ok(message.includes(`/commit/${newest}`));
  assert.ok(message.endsWith("\n<https://github.com/run|Scheduled run>"));
  assert.ok(message.includes(candidate.committedAt));
});

test("fails closed on no healthy commit, missing evidence, invalid SHA or timestamps", () => {
  for (const overrides of [
    { commits: [] }, { runsByWorkflow: {} }, { now: NaN },
    { commits: [{ sha: newest, committedAt: "bad date" }] },
    { commits: [commit(newest, -1)] },
    { commits: [commit("main")], runsByWorkflow: evidence([run("main")]) },
  ]) assert.throws(() => select(overrides));
});

test("reads bounded API history and propagates API failures", async () => {
  let pagesRead = 0;
  const github = {
    rest: { actions: { listWorkflowRuns() {} } },
    paginate: { async *iterator() {
      for (let page = 0; page < 10; page++) {
        pagesRead++;
        yield { data: [run(newest)] };
      }
    } },
  };
  const input = { github, context: { repo: { owner: "MCPJam", repo: "inspector" } }, commits: [commit(newest)], now };
  assert.equal((await readDailyCandidate(input)).sha, newest);
  assert.equal(pagesRead, DAILY_RELEASE_CHECKS.length * 5);
  github.paginate.iterator = async function* () { throw new Error("GitHub unavailable"); };
  await assert.rejects(readDailyCandidate(input), /GitHub unavailable/);
});
