import evalIngest from "../eval-ingest.js";
import evals from "../evals.js";
import { afterEach, beforeEach } from "vitest";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { requireCurrentEvalCli, startsEval } from "../eval-cli-version.js";

function app() {
  const createRun = vi.fn(() => ({ id: "run1" }));
  const router = new Hono();
  router.use("*", requireCurrentEvalCli);
  router.all("*", (c) => c.json(createRun()));
  return { router, createRun };
}

beforeEach(() => {
  vi.stubEnv("MCPJAM_MINIMUM_EVAL_CLI_VERSION", "6.4.1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const start = "/api/v1/projects/project1/eval-runs";
describe("eval CLI compatibility guard", () => {
  it.each(["5.7.1", "6.0.1", "6.4.0", "6.4.1-rc.1"])(
    "refuses CLI %s before creating a run",
    async (version) => {
      const { router, createRun } = app();
      const response = await router.request(start, {
        method: "POST",
        headers: { "user-agent": `mcpjam-cli/${version} mcpjam-sdk/10.0.0` },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringContaining("npm install -g @mcpjam/cli@latest"),
        details: { reason: "CLI_UPGRADE_REQUIRED", minimumCliVersion: "6.4.1" },
      });
      expect(createRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    "mcpjam-cli/6.4.1",
    "mcpjam-cli/6.4.4",
    "mcpjam-cli/7.0.0",
    "mcpjam-sdk/9.0.0",
    "mcpjam-cli/unknown",
  ])("accepts supported or unknown client %s", async (agent) => {
    const { router, createRun } = app();
    const response = await router.request(start, {
      method: "POST",
      headers: agent ? { "user-agent": agent } : {},
    });
    expect(response.status).toBe(200);
    expect(createRun).toHaveBeenCalledOnce();
  });

  it("checks the official declared CLI even if its UA is absent or disagrees", async () => {
    const { router } = app();
    const response = await router.request(start, {
      method: "POST",
      headers: {
        "user-agent": "mcpjam-cli/6.4.4",
        "x-mcpjam-launcher": JSON.stringify({
          kind: "cli",
          client: "mcpjam-cli",
          version: "6.0.1",
        }),
      },
    });
    expect(response.status).toBe(400);
  });

  it("leaves reads, cancel, grading and in-flight upload completion available", async () => {
    const { router } = app();
    for (const [method, path] of [
      ["GET", start],
      ["POST", `${start}/run1/cancel`],
      ["POST", `${start}/run1/judge`],
      ["POST", "/api/v1/projects/p/eval-ingest/runs/iterations"],
      ["POST", "/api/v1/projects/p/eval-ingest/runs/finalize"],
    ]) {
      const response = await router.request(path, {
        method,
        headers: { "user-agent": "mcpjam-cli/5.7.1" },
      });
      expect(response.status).toBe(200);
    }
  });

  it.each([
    "eval-runs",
    "eval-run-groups",
    "eval-runs/run1/rerun",
    "eval-ingest/start-run",
    "eval-ingest/report",
    "eval-ingest/runs/start",
  ])("guards the %s entry point", (suffix) => {
    expect(startsEval("POST", `/api/v1/projects/p/${suffix}`)).toBe(true);
  });
});

it("refuses an old local CLI from start body before forwarding to the backend", async () => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const router = new Hono().route("/api/v1", evalIngest);
  const response = await router.request(
    "/api/v1/projects/p/eval-ingest/start-run",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: "cli", clientVersion: "6.0.1" }),
    },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    details: { reason: "CLI_UPGRADE_REQUIRED" },
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps vocabulary negotiation headers on the real eval router's upgrade refusal", async () => {
  const router = new Hono().route("/api/v1", evals);
  const response = await router.request(start, {
    method: "POST",
    headers: { "user-agent": "mcpjam-cli/5.7.1" },
  });
  expect(response.status).toBe(400);
  expect(response.headers.get("vary")).toContain("x-mcpjam-eval-vocabulary");
  expect(await response.json()).toMatchObject({
    details: { reason: "CLI_UPGRADE_REQUIRED" },
  });
});

it("does not refuse clients using the reporting warning threshold by default", async () => {
  vi.stubEnv("MCPJAM_MINIMUM_EVAL_CLI_VERSION", "");
  const { router, createRun } = app();
  for (const version of ["5.7.1", "6.0.1", "6.4.0"]) {
    const response = await router.request(start, {
      method: "POST",
      headers: { "user-agent": `mcpjam-cli/${version}` },
    });
    expect(response.status).toBe(200);
  }
  expect(createRun).toHaveBeenCalledTimes(3);
});

it("uses the independently configured compatibility floor", async () => {
  vi.stubEnv("MCPJAM_MINIMUM_EVAL_CLI_VERSION", "6.0.0");
  const { router } = app();
  expect(
    (
      await router.request(start, {
        method: "POST",
        headers: { "user-agent": "mcpjam-cli/6.0.1" },
      })
    ).status,
  ).toBe(200);
  const refusal = await router.request(start, {
    method: "POST",
    headers: { "user-agent": "mcpjam-cli/5.7.1" },
  });
  expect(refusal.status).toBe(400);
  expect(await refusal.json()).toMatchObject({
    message: expect.stringContaining("^22.23.4 || ^24.22.1 || >=26.12.1"),
    details: { minimumCliVersion: "6.0.0" },
  });
});
