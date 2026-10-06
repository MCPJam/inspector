import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasQualifyingApproval,
  renderMarkdown,
  summarize,
} from "./unapproved-merges.mjs";

const pr = {
  user: { login: "author" },
  merged_at: "2026-10-05T12:00:00Z",
};
const review = (login, state, submitted_at, type = "User") => ({
  user: { login, type },
  state,
  submitted_at,
});

test("an approval from another person before the merge counts", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("reviewer", "APPROVED", "2026-10-05T11:00:00Z"),
    ]),
    true,
  );
});

test("the author cannot approve their own pull request", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("author", "APPROVED", "2026-10-05T11:00:00Z"),
    ]),
    false,
  );
});

test("a bot approval does not satisfy the control", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("coderabbitai[bot]", "APPROVED", "2026-10-05T11:00:00Z", "Bot"),
    ]),
    false,
  );
});

test("an approval submitted after the merge does not count", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("reviewer", "APPROVED", "2026-10-05T13:00:00Z"),
    ]),
    false,
  );
});

test("comments and change requests are not approvals", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("reviewer", "COMMENTED", "2026-10-05T11:00:00Z"),
      review("other", "CHANGES_REQUESTED", "2026-10-05T11:30:00Z"),
    ]),
    false,
  );
});

const merges = [
  {
    number: 1,
    title: "a | b",
    url: "u1",
    author: "x",
    mergedBy: "x",
    mergedAt: "t1",
    approved: false,
  },
  {
    number: 2,
    title: "c",
    url: "u2",
    author: "y",
    mergedBy: "x",
    mergedAt: "t2",
    approved: false,
  },
  {
    number: 3,
    title: "d",
    url: "u3",
    author: "y",
    mergedBy: "y",
    mergedAt: "t3",
    approved: true,
  },
];

test("summarize counts unapproved and self-merged, ranked by merger", () => {
  assert.deepEqual(summarize(merges), {
    total: 3,
    unapproved: 2,
    selfMerged: 1,
    byMerger: [["x", 2]],
  });
});

test("the markdown lists only unapproved merges and escapes table pipes", () => {
  const md = renderMarkdown({
    repo: "o/r",
    since: new Date("2026-09-28T00:00:00Z"),
    until: new Date("2026-10-05T00:00:00Z"),
    merges,
  });
  assert.match(md, /\[#1\]\(u1\) a \\\| b/);
  assert.match(md, /\[#2\]\(u2\)/);
  assert.doesNotMatch(md, /\[#3\]/);
});
