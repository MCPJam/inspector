import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allPages,
  hasQualifyingApproval,
  mergedBetween,
  renderMarkdown,
  reportWindow,
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

test("a later change request from the same reviewer replaces their approval", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("reviewer", "APPROVED", "2026-10-05T10:00:00Z"),
      review("reviewer", "CHANGES_REQUESTED", "2026-10-05T11:00:00Z"),
    ]),
    false,
  );
});

test("a later approval from the same reviewer replaces their change request", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("reviewer", "CHANGES_REQUESTED", "2026-10-05T10:00:00Z"),
      review("reviewer", "APPROVED", "2026-10-05T11:00:00Z"),
    ]),
    true,
  );
});

test("a comment after an approval leaves the approval standing", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("reviewer", "APPROVED", "2026-10-05T10:00:00Z"),
      review("reviewer", "COMMENTED", "2026-10-05T11:00:00Z"),
    ]),
    true,
  );
});

test("a dismissed review is not an approval", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("reviewer", "DISMISSED", "2026-10-05T10:00:00Z"),
    ]),
    false,
  );
});

test("a dismissal is the reviewer's latest stance over an earlier approval", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("reviewer", "APPROVED", "2026-10-05T10:00:00Z"),
      review("reviewer", "DISMISSED", "2026-10-05T11:00:00Z"),
    ]),
    false,
  );
});

test("an approval in the same second as the merge counts (auto-merge)", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("reviewer", "APPROVED", "2026-10-05T12:00:00Z"),
    ]),
    true,
  );
});

test("on equal timestamps the later-listed review is the stance", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      review("reviewer", "APPROVED", "2026-10-05T11:00:00Z"),
      review("reviewer", "CHANGES_REQUESTED", "2026-10-05T11:00:00Z"),
    ]),
    false,
  );
});

test("a review from a deleted account (user: null) does not count", () => {
  assert.equal(
    hasQualifyingApproval(pr, [
      { user: null, state: "APPROVED", submitted_at: "2026-10-05T11:00:00Z" },
    ]),
    false,
  );
});

test("a manual run reports the given days up to now", () => {
  const now = new Date("2026-10-07T09:15:00Z");
  assert.deepEqual(reportWindow({ now, days: 3, scheduled: false }), {
    since: new Date("2026-10-04T09:15:00Z"),
    until: now,
  });
});

test("a late scheduled run anchors to that Monday's 13:30 UTC", () => {
  assert.deepEqual(
    reportWindow({
      now: new Date("2026-10-05T13:50:00Z"),
      days: 7,
      scheduled: true,
    }),
    {
      since: new Date("2026-09-28T13:30:00Z"),
      until: new Date("2026-10-05T13:30:00Z"),
    },
  );
});

test("a scheduled run on a later day anchors to the previous Monday", () => {
  assert.deepEqual(
    reportWindow({
      now: new Date("2026-10-06T02:00:00Z"),
      days: 7,
      scheduled: true,
    }).until,
    new Date("2026-10-05T13:30:00Z"),
  );
  // Before 13:30 on a Monday the anchor is the Monday before.
  assert.deepEqual(
    reportWindow({
      now: new Date("2026-10-12T13:29:00Z"),
      days: 7,
      scheduled: true,
    }).until,
    new Date("2026-10-05T13:30:00Z"),
  );
});

test("consecutive scheduled windows tile with no gap", () => {
  const first = reportWindow({
    now: new Date("2026-10-05T13:31:00Z"),
    days: 7,
    scheduled: true,
  });
  const second = reportWindow({
    now: new Date("2026-10-12T13:50:00Z"),
    days: 7,
    scheduled: true,
  });
  assert.deepEqual(second.since, first.until);
});

const listedPr = (number, merged_at, updated_at = merged_at) => ({
  number,
  merged_at,
  updated_at,
});

test("merged PRs are kept once, in the window, reading one page past it", async () => {
  const since = new Date("2026-10-01T00:00:00Z");
  const until = new Date("2026-10-05T00:00:00Z");
  const pages = [
    [
      listedPr(1, "2026-10-04T00:00:00Z"),
      listedPr(2, null, "2026-10-03T00:00:00Z"),
      listedPr(9, "2026-10-06T00:00:00Z"),
      ...Array.from({ length: 96 }, (_, i) =>
        listedPr(100 + i, "2026-10-02T00:00:00Z"),
      ),
      listedPr(3, "2026-09-20T00:00:00Z"),
    ],
    // Page 2 starts after the window, but an update between fetches shifted
    // PR 4 here, and PR 1 is listed again.
    [
      listedPr(1, "2026-10-04T00:00:00Z"),
      listedPr(4, "2026-10-01T00:00:00Z", "2026-09-30T00:00:00Z"),
      ...Array.from({ length: 98 }, (_, i) =>
        listedPr(300 + i, "2026-09-10T00:00:00Z"),
      ),
    ],
    [listedPr(5, "2026-10-02T00:00:00Z")],
  ];
  const requested = [];
  const merged = await mergedBetween(
    "/repos/o/r/pulls?state=closed",
    since,
    until,
    async (path) => {
      requested.push(path);
      return pages[requested.length - 1];
    },
  );
  assert.deepEqual(requested, [
    "/repos/o/r/pulls?state=closed&per_page=100&page=1",
    "/repos/o/r/pulls?state=closed&per_page=100&page=2",
  ]);
  const numbers = merged.map((p) => p.number);
  assert.equal(numbers.filter((n) => n === 1).length, 1);
  assert.ok(numbers.includes(4));
  assert.ok(!numbers.includes(2), "never merged");
  assert.ok(!numbers.includes(3), "merged before the window");
  assert.ok(!numbers.includes(9), "merged after the window");
  assert.equal(merged.length, 98);
});

test("an approval on a later page of reviews is found", async () => {
  const pages = [
    Array.from({ length: 100 }, () =>
      review("reviewer", "COMMENTED", "2026-10-05T10:00:00Z"),
    ),
    [review("reviewer", "APPROVED", "2026-10-05T11:00:00Z")],
  ];
  const requested = [];
  const reviews = await allPages("/repos/o/r/pulls/1/reviews", async (path) => {
    requested.push(path);
    return pages[requested.length - 1];
  });
  assert.deepEqual(requested, [
    "/repos/o/r/pulls/1/reviews?per_page=100&page=1",
    "/repos/o/r/pulls/1/reviews?per_page=100&page=2",
  ]);
  assert.equal(reviews.length, 101);
  assert.equal(hasQualifyingApproval(pr, reviews), true);
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
    mergerUnknown: 0,
    byMerger: [["x", 2]],
  });
});

test("a merge with no recorded merger is called out, not counted as independent", () => {
  const withUnknown = [
    ...merges,
    {
      number: 4,
      title: "e",
      url: "u4",
      author: "z",
      mergedBy: null,
      mergedAt: "t4",
      approved: false,
    },
  ];
  const s = summarize(withUnknown);
  assert.equal(s.mergerUnknown, 1);
  assert.equal(s.selfMerged, 1);
  assert.deepEqual(s.byMerger, [
    ["x", 2],
    ["(merger unknown)", 1],
  ]);
  const md = renderMarkdown({
    repo: "o/r",
    since: new Date("2026-09-28T00:00:00Z"),
    until: new Date("2026-10-05T00:00:00Z"),
    merges: withUnknown,
  });
  assert.match(md, /no merger recorded by GitHub.*\*\*1\*\*/);
  assert.match(md, /\[#4\]\(u4\) e \| z \| \(merger unknown\) \| t4 \|/);
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
