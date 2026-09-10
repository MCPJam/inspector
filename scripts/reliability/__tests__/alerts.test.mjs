import { test } from "node:test";
import assert from "node:assert/strict";
import { notification, postSlack } from "../alerts.mjs";
const bad = {
  passed: false,
  results: [{ name: "bearer.connect", outcome: "failed" }],
};
const good = {
  passed: true,
  results: [{ name: "bearer.connect", outcome: "passed" }],
};

test("pages immediately, deduplicates for 30 minutes, repeats and recovers once", () => {
  const first = notification(bad, {}, 1000);
  assert.equal(first.send, true);
  assert.equal(notification(bad, first.state, 60_000).send, false);
  assert.equal(notification(bad, first.state, 1_801_000).send, true);
  const recovery = notification(good, first.state, 61_000);
  assert.equal(recovery.send, true);
  assert.match(recovery.text, /recovered/);
  assert.equal(notification(good, recovery.state, 62_000).send, false);
  assert.equal(notification(good, {}, 1000).send, false);
});

test("a new failure and missing coverage alert even inside dedup window", () => {
  const prior = notification(bad, {}, 1000).state;
  assert.equal(
    notification({ ...bad, coverageFailure: true }, prior, 2000).send,
    true
  );
  assert.equal(
    notification({ passed: false, results: [] }, {}, 1000).send,
    true
  );
});

test("Slack rejection and redirects cannot count as successful delivery", async () => {
  await assert.rejects(postSlack("https://example.com/services/a", "test"));
  await assert.rejects(
    postSlack(
      "https://hooks.slack.com/services/a",
      "test",
      async () => new Response("invalid_token", { status: 403 })
    )
  );
  await assert.rejects(
    postSlack(
      "https://hooks.slack.com/services/a",
      "test",
      async () => new Response("error")
    )
  );
  await postSlack(
    "https://hooks.slack.com/services/a",
    "test",
    async (_url, init) => {
      assert.equal(init.redirect, "error");
      assert.equal(JSON.parse(init.body).text, "test");
      return new Response("ok");
    }
  );
});
