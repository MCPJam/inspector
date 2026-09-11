import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  batch: vi.fn(),
  token: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("../../../services/evals/route-helpers.js", () => ({
  createConvexClient: () => ({ query: mocks.query }),
  requireConvexHttpUrl: () => "https://backend.test",
}));
vi.mock("../eval-case-batch.js", () => ({
  createEvalCasesInBatches: mocks.batch,
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: mocks.token,
}));
import { handleMarkdownImport } from "../markdown-case-import";
const app = new Hono();
app.post("/local/extract", (c) => handleMarkdownImport(c, "extract", true));
app.post("/hosted/extract", (c) => handleMarkdownImport(c, "extract", false));
app.post("/local/save", (c) => handleMarkdownImport(c, "save", true));
const source = {
  format: "markdown",
  method: "ai",
  fileName: "cases.md",
  fileHash: "a".repeat(64),
  excerpt: "Find projects",
  startLine: 1,
  endLine: 1,
  extractorVersion: "markdown-v1",
};
const body = {
  projectId: "p",
  suiteId: "s",
  fileName: "cases.md",
  markdown: "Find projects",
};
const caseItem = {
  title: "Find projects",
  prompt: "Find my projects",
  expectedOutput: "Projects appear",
  source,
  caseId: "c_one",
  idempotencyKey: "markdown:key",
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.query.mockResolvedValue(true);
  mocks.token.mockResolvedValue("hosted-token");
  mocks.fetch.mockResolvedValue(
    Response.json({ ok: true, drafts: [], warnings: ["No tests"] }),
  );
  mocks.batch.mockResolvedValue({
    committed: [],
    failed: [{ index: 0, code: "DUPLICATE", message: "Exists" }],
  });
});
function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
describe("Markdown import adapters", () => {
  it.each(["local", "hosted"])(
    "forwards %s auth and extraction without a write",
    async (mode) => {
      const response = await post(`/${mode}/extract`, {
        ...body,
        ...(mode === "local" ? { convexAuthToken: "local-token" } : {}),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        warnings: ["No tests"],
      });
      expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe(
        `Bearer ${mode}-token`,
      );
      expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual(body);
      expect(mocks.batch).not.toHaveBeenCalled();
    },
  );
  it("does not forward an unauthorized extraction", async () => {
    mocks.query.mockRejectedValueOnce(new Error("Forbidden"));
    expect(
      (await post("/local/extract", { ...body, convexAuthToken: "token" }))
        .status,
    ).not.toBe(200);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("maps reviewed cases to the batch contract and preserves partial failures", async () => {
    const response = await post("/local/save", {
      projectId: "p",
      suiteId: "s",
      convexAuthToken: "token",
      cases: [caseItem],
    });
    expect(response.status).toBe(200);
    expect((await response.json()).failed).toHaveLength(1);
    expect(mocks.batch.mock.calls[0][1]).toMatchObject({
      duplicatePolicy: "block",
      cases: [
        {
          source,
          caseId: "c_one",
          idempotencyKey: "markdown:key",
          isNegativeTest: false,
          models: [],
          steps: [{ id: "prompt", kind: "prompt", prompt: "Find my projects" }],
        },
      ],
    });
  });
  it("rejects missing expectations before writing", async () => {
    const response = await post("/local/save", {
      projectId: "p",
      suiteId: "s",
      convexAuthToken: "token",
      cases: [{ ...caseItem, expectedOutput: "" }],
    });
    expect(response.status).toBe(400);
    expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("preserves backend billing errors", async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ error: "Credits exhausted" }, { status: 402 }),
    );
    const response = await post("/local/extract", {
      ...body,
      convexAuthToken: "token",
    });
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "Credits exhausted" });
  });
});

it("returns JSON failure when the extraction upstream serves HTML", async () => {
  mocks.fetch.mockResolvedValue(
    new Response("<!DOCTYPE html><html>missing route</html>", { status: 200 }),
  );
  const response = await post("/hosted/extract", body);
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({
    code: "extraction_upstream_invalid_response",
    upstreamStatus: 200,
    error: expect.stringContaining("extraction service is unavailable"),
  });
});
