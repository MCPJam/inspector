import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/client.js";
import {
  createEvalCaseOperation,
  deleteEvalCaseOperation,
  deleteEvalSuiteOperation,
  generateEvalCasesOperation,
  getEvalCaseOperation,
  getEvalSuiteOperation,
  setEvalSuiteScheduleOperation,
  updateEvalSuiteOperation,
} from "../../src/platform/operations.js";

const PROJECTS = [{ id: "p1", name: "Default", updatedAt: 2 }];
const SUITES = [{ id: "s1", name: "My Suite", projectId: "p1" }];
const CASES = [
  { id: "c1", title: "First case", kind: "prompt" },
  { id: "c2", title: "Second case", kind: "prompt" },
];

function makeClient(): {
  client: PlatformApiClient;
  calls: Array<{ method: string; path: string; body?: any }>;
} {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    if (path === "/api/v1/projects") return Response.json({ items: PROJECTS });
    if (/\/eval-suites$/.test(path)) return Response.json({ items: SUITES });
    if (/\/eval-suites\/[^/]+\/cases$/.test(path) && method === "GET")
      return Response.json({ items: CASES });
    if (/\/eval-suites\/[^/]+\/cases$/.test(path) && method === "POST")
      return Response.json(
        { id: "c-new", title: body.title, kind: "prompt" },
        { status: 201 }
      );
    if (/\/eval-suites\/[^/]+\/cases\/[^/]+$/.test(path) && method === "DELETE")
      return Response.json({ id: "c2", deleted: true });
    if (/\/eval-suites\/[^/]+\/cases\/[^/]+$/.test(path))
      return Response.json(CASES[1]);
    if (/\/eval-suites\/[^/]+\/cases\/generate$/.test(path))
      return Response.json({
        generationModel: "anthropic/claude-haiku-4.5",
        created: [],
        counts: {},
      });
    if (/\/eval-suites\/[^/]+\/schedule$/.test(path))
      return Response.json({
        id: "s1",
        schedule: { enabled: body.enabled, intervalMinutes: 60 },
      });
    if (/\/eval-suites\/[^/]+$/.test(path) && method === "DELETE")
      return Response.json({ id: "s1", deleted: true });
    if (/\/eval-suites\/[^/]+$/.test(path))
      return Response.json({ id: "s1", name: "My Suite", settings: {} });
    throw new Error(`unexpected ${method} ${path}`);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "tok",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, calls };
}

describe("eval-edit operation input validation", () => {
  it("update_eval_suite requires a suite selector", () => {
    expect(
      updateEvalSuiteOperation.inputSchema.safeParse({ name: "x" }).success
    ).toBe(false);
  });

  it("set_eval_suite_schedule requires enabled", () => {
    expect(
      setEvalSuiteScheduleOperation.inputSchema.safeParse({ suite: "s1" })
        .success
    ).toBe(false);
  });

  it("update_eval_suite rejects an out-of-range minimumAccuracy", () => {
    expect(
      updateEvalSuiteOperation.inputSchema.safeParse({
        suite: "s1",
        settings: { minimumAccuracy: 150 },
      }).success
    ).toBe(false);
  });

  it("update_eval_case accepts null to clear an override", () => {
    expect(
      createEvalCaseOperation.inputSchema.safeParse({
        suite: "s1",
        title: "t",
        matchOptions: null,
      }).success
    ).toBe(true);
  });

  it("read ops are read-only; writes and deletes are not", () => {
    expect(getEvalSuiteOperation.readOnly).toBe(true);
    expect(getEvalCaseOperation.readOnly).toBe(true);
    expect(updateEvalSuiteOperation.readOnly).toBe(false);
    expect(deleteEvalSuiteOperation.readOnly).toBe(false);
    expect(deleteEvalCaseOperation.readOnly).toBe(false);
  });
});

describe("eval-edit operation execution", () => {
  it("update_eval_suite resolves the suite and PATCHes a public body", async () => {
    const { client, calls } = makeClient();
    await updateEvalSuiteOperation.execute(
      { suite: "My Suite", name: "Renamed", settings: { minimumAccuracy: 80 } },
      { client }
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/v1/projects/p1/eval-suites/s1");
    expect(patch?.body).toEqual({
      name: "Renamed",
      settings: { minimumAccuracy: 80 },
    });
  });

  it("get_eval_case resolves a case by title", async () => {
    const { client, calls } = makeClient();
    const result = await getEvalCaseOperation.execute(
      { suite: "s1", case: "Second case" },
      { client }
    );
    expect((result as { id: string }).id).toBe("c2");
    expect(
      calls.some((c) => c.method === "GET" && /\/cases\/c2$/.test(c.path))
    ).toBe(true);
  });

  it("resolveCase throws a helpful error when the case is unknown", async () => {
    const { client } = makeClient();
    await expect(
      getEvalCaseOperation.execute({ suite: "s1", case: "nope" }, { client })
    ).rejects.toThrow(/Eval case/);
  });

  it("delete_eval_case returns the minimal acknowledgement", async () => {
    const { client } = makeClient();
    const result = await deleteEvalCaseOperation.execute(
      { suite: "s1", case: "Second case" },
      { client }
    );
    expect(result).toEqual({ id: "c2", deleted: true });
  });

  it("generate_eval_cases forwards mode + caseModels", async () => {
    const { client, calls } = makeClient();
    await generateEvalCasesOperation.execute(
      {
        suite: "s1",
        mode: "negative",
        caseModels: [{ model: "anthropic/claude-haiku-4.5" }],
      },
      { client }
    );
    const gen = calls.find((c) => /\/cases\/generate$/.test(c.path));
    expect(gen?.body).toEqual({
      mode: "negative",
      caseModels: [{ model: "anthropic/claude-haiku-4.5" }],
    });
  });
});
