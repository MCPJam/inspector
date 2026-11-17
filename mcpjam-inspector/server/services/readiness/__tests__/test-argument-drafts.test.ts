/**
 * Which of a plan's cases go to the drafting broker and in what form, and
 * what each answer the broker can give becomes. The broker is a stubbed
 * `fetch`; only a stop signal throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryTestPlan, DirectoryToolEvidence } from "@mcpjam/sdk";
import {
  ReadinessLeaseLostError,
  ReadinessRunCancelledError,
} from "../runner.js";
import {
  draftMissingArguments,
  requestTestArgumentDrafts,
  type TestArgumentPass,
  type TestArgumentRequester,
} from "../test-argument-drafts.js";
import { TOOLS, samplePlan } from "./test-plan-fixtures.js";

const LEASE = { runId: "run_1", jobId: "job_1" };
const LISTED: DirectoryToolEvidence[] = TOOLS.map((tool) => ({
  ...tool,
  description: `What ${tool.name} does.`,
}));
const PASS: TestArgumentPass = {
  status: "completed",
  drafts: [],
  undecided: [],
  dropped: { schema: 0, credential: 0 },
};

/** The sample plan with the named cases' arguments left to draft. */
function undrafted(...ids: string[]): DirectoryTestPlan {
  const plan = samplePlan();
  const cases = plan.cases.map(({ arguments: args, ...testCase }) =>
    ids.includes(testCase.id) ? testCase : { ...testCase, arguments: args },
  );
  return { ...plan, cases };
}

/** What a requester was sent, for a plan and the server's tools. */
async function sent(plan: DirectoryTestPlan, tools = LISTED) {
  const request = vi.fn<TestArgumentRequester>(async () => PASS);
  const drafting = await draftMissingArguments({
    plan,
    tools,
    request,
    signal: new AbortController().signal,
    endBy: Date.now() + 10 * 60_000,
  });
  const items = request.mock.calls[0]?.[0]?.items ?? [];
  return { request, drafting, items };
}

describe("the cases a run sends", () => {
  it("are those without arguments that would run, in plan order, with their tools as listed", async () => {
    const plan = undrafted("get_project#valid", "rename_project#valid");
    plan.cases.push({
      id: "send_invite#valid",
      tool: "send_invite",
      kind: "valid",
    });
    const { items, drafting } = await sent(plan);

    // The excluded tool's case never runs, so it is neither sent nor waiting.
    expect(items.map((item) => item.caseId)).toEqual([
      "get_project#valid",
      "rename_project#valid",
    ]);
    expect(drafting?.unsent).toBe(0);
    expect(items[1]).toEqual({
      caseId: "rename_project#valid",
      tool: "rename_project",
      kind: "valid",
      inputSchema: TOOLS[3]!.inputSchema,
      description: "What rename_project does.",
      annotations: { destructiveHint: false, openWorldHint: false },
      // Created before this case, and a fixture the tool may write: first.
      fixtures: [
        {
          id: "scratchProject",
          description: "A project the sweep creates and deletes.",
          values: ["id"],
        },
        {
          id: "demoProject",
          description: "The project the reviewer account starts with.",
          values: ["id"],
        },
      ],
    });
    // The scratch project is created after this case, so it is not offered.
    expect(items[0]?.fixtures?.map((fixture) => fixture.id)).toEqual([
      "demoProject",
    ]);
    // Value names travel; an existing fixture's values never do.
    expect(JSON.stringify(items)).not.toContain("proj_demo");
  });

  it("leave out a negative-only tool's valid case", async () => {
    const plan = undrafted("get_project#valid", "get_project#missing-id");
    plan.tools = plan.tools.map((entry) =>
      entry.tool === "get_project"
        ? { ...entry, action: "negative-only" as const }
        : entry,
    );
    const { items } = await sent(plan);
    expect(items.map((item) => item.caseId)).toEqual([
      "get_project#missing-id",
    ]);
    expect(items[0]?.kind).toBe("negative");
  });

  it("stay inside the broker's bounds, and the rest are counted unsent", async () => {
    const plan = undrafted("list_projects#valid", "get_project#valid");
    plan.cases.push({ id: "big#valid", tool: "rename_project", kind: "valid" });
    for (let index = 0; index < 30; index += 1) {
      plan.cases.push({
        id: `get_project#${index}`,
        tool: "get_project",
        kind: "valid",
      });
    }
    const tools = LISTED.map((tool) =>
      tool.name === "get_project"
        ? {
            ...tool,
            description: "x".repeat(2_500),
            annotations: {
              title: "t".repeat(300),
              readOnlyHint: true,
              color: "red",
            },
          }
        : tool.name === "rename_project"
          ? {
              ...tool,
              inputSchema: { type: "object", enum: ["y".repeat(13_000)] },
            }
          : tool,
    );
    const { items, drafting } = await sent(plan, tools);

    // At most 24 a run. No object schema (list_projects) and a case over
    // 12,000 characters stay unsent, as do the cases past the cap.
    expect(items).toHaveLength(24);
    expect(items.every((item) => item.tool === "get_project")).toBe(true);
    expect(drafting?.unsent).toBe(33 - 24);
    expect(items[0]?.description).toHaveLength(2_000);
    expect(items[0]?.annotations).toEqual({
      readOnlyHint: true,
      title: "t".repeat(200),
    });
  });

  it("are not asked for without a requester, or when every case has arguments", async () => {
    const signal = new AbortController().signal;
    const plan = undrafted("get_project#valid");
    const endBy = Date.now() + 10 * 60_000;
    await expect(
      draftMissingArguments({ plan, tools: LISTED, signal, endBy }),
    ).resolves.toBeUndefined();
    const { request, drafting } = await sent(samplePlan());
    expect(request).not.toHaveBeenCalled();
    expect(drafting).toBeUndefined();
  });

  it("are reported undrafted when the requester throws, unless the run must stop", async () => {
    const plan = undrafted("get_project#valid");
    const input = {
      plan,
      tools: LISTED,
      signal: new AbortController().signal,
      endBy: Date.now(),
    };
    const failing = draftMissingArguments({
      ...input,
      request: async () => Promise.reject(new Error("boom")),
    });
    await expect(failing).resolves.toMatchObject({
      status: "provider-failed",
      detail: expect.stringMatching(/could not draft test arguments/),
      drafts: [],
      unsent: 0,
    });
    const stopped = draftMissingArguments({
      ...input,
      request: async () => Promise.reject(new ReadinessLeaseLostError()),
    });
    await expect(stopped).rejects.toBeInstanceOf(ReadinessLeaseLostError);
  });
});

const ITEMS = [
  {
    caseId: "get_project#valid",
    tool: "get_project",
    kind: "valid" as const,
    inputSchema: { type: "object" },
  },
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The broker, answering each request with the next responder. */
function broker(...responders: Array<() => Response | Promise<Response>>) {
  const fetchMock = vi.fn(async () =>
    (responders.length > 1 ? responders.shift()! : responders[0]!)(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function ask(
  signal = new AbortController().signal,
  endBy = Date.now() + 14 * 60_000,
) {
  return requestTestArgumentDrafts(LEASE, { items: ITEMS, signal, endBy });
}

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "service-token";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CONVEX_HTTP_URL;
  delete process.env.INSPECTOR_SERVICE_TOKEN;
});

describe("requestTestArgumentDrafts", () => {
  it("asks once, on the run's lease, and keeps the arguments as the broker checked them", async () => {
    const draft = {
      caseId: "get_project#valid",
      arguments: {
        code: "US",
        projectId: { $fixture: "demoProject", value: "id" },
      },
      rationale: "Reads the sample project. Bearer abcdef123456",
      note: "not kept",
    };
    const fetchMock = broker(() =>
      json({
        ok: true,
        status: "completed",
        drafts: [
          draft,
          { caseId: "x", arguments: "{}", rationale: "unreadable" },
        ],
        undecided: [
          {
            caseId: "rename_project#valid",
            reason: "needs_fixture",
            detail: "No project to rename.",
          },
          { caseId: "y", reason: "a reason this build does not know" },
        ],
        dropped: { schema: 1, credential: -1 },
        modelId: "sample-model",
        promptVersion: "1",
      }),
    );
    const pass = await ask();

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://backend.test/internal/v1/claude-readiness/test-arguments",
    );
    expect(new Headers(init.headers).get("x-inspector-service-token")).toBe(
      "service-token",
    );
    expect(JSON.parse(String(init.body))).toEqual({ ...LEASE, items: ITEMS });
    expect(pass).toEqual({
      status: "completed",
      // A `code` argument and the fixture reference stay as proposed.
      drafts: [
        {
          caseId: "get_project#valid",
          arguments: draft.arguments,
          rationale: "Reads the sample project. Bearer [REDACTED]",
        },
      ],
      undecided: [
        {
          caseId: "rename_project#valid",
          reason: "needs_fixture",
          detail: "No project to rename.",
        },
      ],
      dropped: { schema: 1, credential: 0 },
      modelId: "sample-model",
      promptVersion: "1",
    });
  });

  it.each(["drafting_disabled", "drafting_not_requested"])(
    "reads a 403 %s as drafting being off for the run",
    async (error) => {
      broker(() => json({ ok: false, error }, 403));
      expect(await ask()).toBeUndefined();
    },
  );

  it.each([
    ["a lost lease", () => json({ ok: false, error: "lease_lost" }, 409)],
    ["a 409 it cannot read", () => new Response("conflict", { status: 409 })],
  ])("throws on %s, the node's signal to stop", async (_label, responder) => {
    broker(responder);
    await expect(ask()).rejects.toBeInstanceOf(ReadinessLeaseLostError);
  });

  it.each([
    [
      "a malformed request",
      () => json({ ok: false, error: "invalid_case" }, 400),
    ],
    ["an unknown run", () => json({ ok: false, error: "not_found" }, 404)],
    ["a backend error", () => new Response("boom", { status: 500 })],
    [
      "an unreadable answer",
      () => json({ ok: true, status: "drafted-somehow" }),
    ],
    ["an unreachable broker", () => Promise.reject(new Error("ECONNRESET"))],
  ])("reports no drafts, and what to do, on %s", async (_label, responder) => {
    broker(responder);
    expect(await ask()).toEqual({
      status: "provider-failed",
      reason: "provider_error",
      detail:
        "MCPJam could not draft test arguments for this run. Start a new run to try again.",
      drafts: [],
      undecided: [],
      dropped: { schema: 0, credential: 0 },
    });
  });

  it("gives a pass five minutes, then reports it timed out", async () => {
    vi.useFakeTimers();
    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    vi.stubGlobal("fetch", hanging);
    const answer = ask();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await answer).toMatchObject({
      reason: "provider_timeout",
      detail: expect.stringMatching(
        /^Drafting test arguments took longer than 5 minutes/,
      ),
    });
  });

  it("stops when the run is cancelled mid-request", async () => {
    const run = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        run.abort();
        throw new DOMException("This operation was aborted", "AbortError");
      }),
    );
    await expect(ask(run.signal)).rejects.toBeInstanceOf(
      ReadinessRunCancelledError,
    );
  });

  it("asks nothing when the run has too little time left for a pass", async () => {
    const fetchMock = broker(() => json({ ok: true, status: "completed" }));
    expect(await ask(undefined, Date.now() + 4 * 60_000)).toMatchObject({
      reason: "provider_timeout",
      detail:
        "This run had too little time left to draft test arguments. Start a new run to draft them.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a pass already running for the run", () => {
  const inProgress = () =>
    json({ ok: false, error: "drafting_in_progress" }, 409);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("is waited for, and its stored drafts are the run's", async () => {
    const replay = {
      ok: true,
      status: "completed",
      replayed: true,
      drafts: [
        {
          caseId: "get_project#valid",
          arguments: {},
          rationale: "Takes no input.",
        },
      ],
    };
    const fetchMock = broker(inProgress, inProgress, () => json(replay));
    const answer = ask();
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await answer)?.drafts).toEqual(replay.drafts);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("is given up on after as long as a pass takes", async () => {
    const fetchMock = broker(inProgress);
    const answer = ask();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await answer).toMatchObject({
      status: "provider-failed",
      detail: expect.stringMatching(/still being drafted after 5 minutes/),
    });
    // The first request and ten retries, 30 seconds apart.
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it("is not waited for past the time the run has left", async () => {
    const fetchMock = broker(inProgress);
    const answer = ask(undefined, Date.now() + 6 * 60_000);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(await answer).toMatchObject({
      reason: "provider_timeout",
      detail: expect.stringMatching(/still being drafted/),
    });
    // Asked at 0, 30 and 60 seconds; at 90 a whole pass no longer fits.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops waiting for it when the run is cancelled", async () => {
    const fetchMock = broker(inProgress);
    const run = new AbortController();
    const answer = ask(run.signal);
    await vi.advanceTimersByTimeAsync(10_000);
    run.abort();
    await expect(answer).rejects.toBeInstanceOf(ReadinessRunCancelledError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
