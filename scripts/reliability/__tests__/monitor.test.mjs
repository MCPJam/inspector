import { test } from "node:test";
import assert from "node:assert/strict";
import { heartbeat } from "../monitor.mjs";

test("heartbeat creates external missed-run coverage and checks delivery status", async () => {
  const dsnValue = "https://publickey@o123.ingest.us.sentry.io/123";
  await heartbeat("ok", {
    dsnValue,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://o123.ingest.us.sentry.io/api/123/envelope/");
      assert.equal(init.redirect, "error");
      const lines = init.body.trim().split("\n").map(JSON.parse);
      assert.equal(lines[1].type, "check_in");
      assert.equal(lines[2].status, "ok");
      assert.equal(lines[2].environment, "prod");
      assert.equal(lines[2].monitor_config.checkin_margin, 10);
      assert.equal(lines[2].monitor_config.schedule.value, "*/5 * * * *");
      return new Response("{}");
    },
  });
  await assert.rejects(
    heartbeat("error", {
      dsnValue,
      fetchImpl: async () => new Response("quota", { status: 429 }),
    }),
    /rejected/
  );
  await assert.rejects(
    heartbeat("ok", { dsnValue: "https://example.com/123" }),
    /Invalid/
  );
});

test("version metadata cannot echo an arbitrary response or credential into reports", async () => {
  const { safeVersion } = await import("../monitor.mjs");
  assert.equal(safeVersion("3.5.0"), "3.5.0");
  assert.equal(safeVersion("3.5.0-rc.1"), "3.5.0-rc.1");
  assert.equal(safeVersion("Bearer secret-value"), null);
  assert.equal(safeVersion({ token: "secret" }), null);
});
