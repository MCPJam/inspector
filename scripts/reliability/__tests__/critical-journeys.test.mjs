import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFixtures,
  runJourneys,
  safeBaseUrl,
} from "../critical-journeys.mjs";

const fixtures = ["bearer", "oauth"].map((kind) => ({
  kind,
  projectId: "project",
  serverId: kind,
  toolName: "health",
  expectedText: "healthy",
}));
const run = (options) =>
  runJourneys({
    baseUrl: "https://app.example.com",
    apiKey: "synthetic-api-key",
    fixtures,
    ...options,
  });
const ok = (data) => new Response(JSON.stringify(data), { status: 200 });

test("requires both persisted credential fixtures and rejects credential shortcuts", () => {
  assert.throws(() => parseFixtures(undefined));
  assert.throws(() => parseFixtures(JSON.stringify([fixtures[0]])));
  assert.throws(() =>
    parseFixtures(
      JSON.stringify([fixtures[0], { ...fixtures[1], oauthToken: "shortcut" }])
    )
  );
  assert.throws(() =>
    parseFixtures(
      JSON.stringify([
        fixtures[0],
        { ...fixtures[1], serverId: "../elsewhere" },
      ])
    )
  );
  assert.deepEqual(parseFixtures(JSON.stringify(fixtures)), fixtures);
});

test("refuses unsafe origins and cannot leak API credentials via redirects", async () => {
  for (const url of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/?token=x",
  ])
    assert.throws(() => safeBaseUrl(url));
  await run({
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, "error");
      return ok({
        id: "u",
        items: [{ name: "health" }],
        content: [{ type: "text", text: "healthy" }],
      });
    },
  });
});

test("actual saved-auth operations pass without sending target credentials", async () => {
  const requests = [];
  const report = await run({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      assert.equal(init.headers.Authorization, "Bearer synthetic-api-key");
      if (url.endsWith("/me")) return ok({ id: "u" });
      if (url.endsWith("/call"))
        return ok({ content: [{ type: "text", text: "healthy" }] });
      return ok({ items: [{ name: "health" }] });
    },
  });
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 7);
  assert.equal(requests.filter((r) => r.url.endsWith("/tools")).length, 4);
  assert.ok(requests.every((r) => !r.init.body?.includes("oauthToken")));
});

test("#4932: 403 with missing binding fails even though health and identity pass", async () => {
  const report = await run({
    fetchImpl: async (url) =>
      url.endsWith("/me")
        ? ok({ id: "u" })
        : new Response(
            JSON.stringify({
              message:
                "Server's saved credentials were not recorded against any origin. Bearer secret-value",
            }),
            { status: 403 }
          ),
  });
  assert.equal(report.passed, false);
  assert.equal(report.results.filter((r) => r.outcome === "failed").length, 6);
  assert.ok(!JSON.stringify(report).includes("secret-value"));
});

test("200 error envelopes, empty discovery and wrong tool results are failures", async () => {
  for (const data of [
    { error: "oops" },
    { items: [] },
    { isError: true, content: [{ type: "text", text: "healthy" }] },
  ]) {
    const report = await run({
      fetchImpl: async (url) =>
        url.endsWith("/me") ? ok({ id: "u" }) : ok(data),
    });
    assert.equal(report.passed, false);
  }
});

test("network exceptions are bounded failures without exception text in reports", async () => {
  const report = await run({
    fetchImpl: async () => {
      throw new Error("secret request URL");
    },
  });
  assert.equal(report.passed, false);
  assert.ok(!JSON.stringify(report).includes("secret"));
});

test("missing API key is a coverage failure, not a skipped pass", async () => {
  await assert.rejects(run({ apiKey: "" }), /required/);
});

test("local journeys use the local session guard AND the user JWT through connect and reconnect", async () => {
  const paths = [];
  const report = await run({
    baseUrl: "http://127.0.0.1:6274",
    mode: "local",
    localBearer: "synthetic-user-jwt",
    fetchImpl: async (url, init) => {
      paths.push(new URL(url).pathname);
      if (url.endsWith("/api/session-token"))
        return ok({ token: "loopback-secret" });
      assert.equal(
        init.headers["X-MCP-Session-Auth"],
        "Bearer loopback-secret"
      );
      assert.equal(init.headers.Authorization, "Bearer synthetic-user-jwt");
      if (url.endsWith("/me")) return ok({ id: "u" });
      if (url.endsWith("connect")) return ok({ success: true });
      if (url.endsWith("/list")) return ok({ tools: [{ name: "health" }] });
      const result = { content: [{ type: "text", text: "healthy" }] };
      if (url.endsWith("/execute")) return ok({ status: "completed", result });
      if (url.endsWith("/call")) return ok(result);
      return ok({ items: [{ name: "health" }] });
    },
  });
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 15);
  assert.equal(paths.filter((p) => p === "/api/mcp/connect").length, 2);
  assert.equal(
    paths.filter((p) => p === "/api/mcp/servers/reconnect").length,
    2
  );
});

test("local coverage refuses an API key instead of silently exercising the wrong identity path", async () => {
  await assert.rejects(
    run({ baseUrl: "http://127.0.0.1:6274", mode: "local" }),
    /required/
  );
  await assert.rejects(
    run({
      baseUrl: "http://127.0.0.1:6274",
      mode: "local",
      localBearer: "sk_key",
    }),
    /JWT/
  );
});
