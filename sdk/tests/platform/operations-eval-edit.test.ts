import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/client.js";
import {
  createEvalCaseOperation,
  createEvalCasesOperation,
  deleteEvalCaseOperation,
  deleteEvalSuiteOperation,
  generateEvalCasesOperation,
  getEvalCaseOperation,
  getEvalSuiteOperation,
  setEvalSuiteEnvironmentsOperation,
  setEvalSuiteScheduleOperation,
  updateEvalCaseOperation,
  updateEvalSuiteOperation,
} from "../../src/platform/operations.js";

const PROJECTS = [{ id: "p1", name: "Default", updatedAt: 2 }];
const SUITES = [{ id: "s1", name: "My Suite", projectId: "p1" }];
const CASES = [
  { id: "c1", title: "First case", kind: "prompt" },
  { id: "c2", title: "Second case", kind: "prompt" },
];
const ENVIRONMENTS = [
  { id: "env-stg", projectId: "p1", name: "Staging", revision: 3 },
  { id: "env-prod", projectId: "p1", name: "Prod", revision: 1 },
];

function makeClient(): {
  client: PlatformApiClient;
  calls: Array<{
    method: string;
    path: string;
    query: Record<string, string>;
    body?: any;
    headers: Record<string, string>;
  }>;
} {
  const calls: Array<{
    method: string;
    path: string;
    query: Record<string, string>;
    body?: any;
    headers: Record<string, string>;
  }> = [];
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>
    )) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
      headers,
    });

    if (path === "/api/v1/projects") return Response.json({ items: PROJECTS });
    if (/\/environments$/.test(path))
      return Response.json({ items: ENVIRONMENTS });
    if (/\/eval-suites$/.test(path)) return Response.json({ items: SUITES });
    // `/cases/generate` must precede the `/cases/:caseId` branch — "generate"
    // is itself a single path segment that the :caseId regex would match.
    if (/\/eval-suites\/[^/]+\/cases\/generate$/.test(path))
      return Response.json({
        generationModel: "anthropic/claude-haiku-4.5",
        created: [],
        counts: {},
      });
    if (/\/eval-suites\/[^/]+\/cases\/batch$/.test(path))
      return Response.json({
        created: (body.cases ?? []).map(
          (testCase: { title?: string }, index: number) => ({
            index,
            id: `c-batch-${index}`,
            title: testCase.title,
            kind: "prompt",
          })
        ),
        failed: [],
        duplicatePolicy: {
          effectivePolicy: "block",
          coerced: false,
        },
        warnings: [],
      });
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

  it("update_eval_suite rejects an unknown top-level key rather than stripping it", () => {
    const parsed = updateEvalSuiteOperation.inputSchema.safeParse({
      suite: "s1",
      hostIds: ["h1"],
      servers: ["echo"],
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    expect(detail).toContain("hostIds");
    expect(detail).toContain("servers");
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
      updateEvalCaseOperation.inputSchema.safeParse({
        suite: "s1",
        case: "c1",
        matchOptions: null,
        checks: null,
      }).success
    ).toBe(true);
    // create accepts null too (treated as "no override").
    expect(
      createEvalCaseOperation.inputSchema.safeParse({
        suite: "s1",
        title: "t",
        matchOptions: null,
      }).success
    ).toBe(true);
  });

  it("generate_eval_cases accepts a per-bucket caseMix + varyUserStyles", () => {
    expect(
      generateEvalCasesOperation.inputSchema.safeParse({
        suite: "s1",
        caseMix: { simple: 3, negative: 1 },
        varyUserStyles: true,
      }).success
    ).toBe(true);
  });

  it("generate_eval_cases rejects an out-of-range caseMix bucket", () => {
    expect(
      generateEvalCasesOperation.inputSchema.safeParse({
        suite: "s1",
        caseMix: { simple: 99 },
      }).success
    ).toBe(false);
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

  it("create_eval_case carries the converter's import claim to the wire", async () => {
    const { client, calls } = makeClient();
    const claim = {
      status: "approximated" as const,
      sourceCaseKey: "promptfoo:tests[3]",
      note: "Source asserted a regex; MCPJam asserts a substring.",
    };
    await createEvalCaseOperation.execute(
      { suite: "s1", title: "Converted", import: claim },
      { client }
    );
    const post = calls.find((c) => c.method === "POST");
    // Dropping the claim here does not merely lose provenance: a case with no
    // claim is a NATIVE case, and a native case needs no approval — so an
    // approximated case would run and gate on evidence nobody reviewed.
    expect(post?.body?.import).toEqual(claim);
  });

  it("update_eval_case forwards a claim, and null to clear one", async () => {
    const { client, calls } = makeClient();
    await updateEvalCaseOperation.execute(
      { suite: "s1", case: "c2", import: null },
      { client }
    );
    const patch = calls.find((c) => c.method === "PATCH");
    // `null` CLEARS; omitting leaves the stored claim alone. `buildCaseBody`
    // drops undefined and keeps null, which is exactly that distinction.
    expect(patch?.body).toEqual({ import: null });
  });

  it("forwards intent on create and distinguishes clear from omission on update", async () => {
    const { client, calls } = makeClient();
    await createEvalCaseOperation.execute(
      { suite: "s1", title: "Labelled", intent: "refund" },
      { client }
    );
    expect(calls.find((call) => call.method === "POST")?.body?.intent).toBe(
      "refund"
    );

    await updateEvalCaseOperation.execute(
      { suite: "s1", case: "c2", intent: null },
      { client }
    );
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      intent: null,
    });
  });

  it("create rejects import: null, which the route would 400", async () => {
    // The REST create schema takes the claim or nothing; only PATCH accepts
    // null. An input schema that advertised null here would tell the caller a
    // body is valid and then have the server reject it.
    expect(
      createEvalCaseOperation.inputSchema.safeParse({
        suite: "s1",
        title: "t",
        import: null,
      }).success
    ).toBe(false);
    expect(
      createEvalCasesOperation.inputSchema.safeParse({
        suite: "s1",
        cases: [{ title: "t", import: null }],
      }).success
    ).toBe(false);
    // Update still clears with null — that is the whole point of the asymmetry.
    expect(
      updateEvalCaseOperation.inputSchema.safeParse({
        suite: "s1",
        case: "c1",
        import: null,
      }).success
    ).toBe(true);
  });

  it("create_eval_case rejects an exact claim with no note", async () => {
    // The contract schema is reused verbatim, so a claim means the same thing
    // whether it arrives from a suite file or this operation — including the
    // rule that `exact` must cite the mapping rule that earns it.
    expect(
      createEvalCaseOperation.inputSchema.safeParse({
        suite: "s1",
        title: "t",
        import: { status: "exact" },
      }).success
    ).toBe(false);
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

  it("generate_eval_cases forwards caseMix + varyUserStyles into the body", async () => {
    const { client, calls } = makeClient();
    await generateEvalCasesOperation.execute(
      {
        suite: "s1",
        caseMix: { simple: 3, negative: 1 },
        varyUserStyles: true,
      },
      { client }
    );
    const gen = calls.find((c) => /\/cases\/generate$/.test(c.path));
    expect(gen?.body).toEqual({
      caseMix: { simple: 3, negative: 1 },
      varyUserStyles: true,
    });
  });

  it("generate_eval_cases forwards the idempotency key on BOTH channels", async () => {
    // The bug this pins: the operation used to send no key at all, so the
    // surfaces most likely to time out (CLI, MCP plugin, direct SDK) re-spent
    // on every retry. The body is the channel the route reads by schema —
    // matching run_eval_suite and run_eval_case, the two closest siblings that
    // also spend — and the header is the one the client already speaks. They
    // must carry the SAME key: two channels that could disagree would be a
    // worse bug than the one being fixed.
    const { client, calls } = makeClient();
    await generateEvalCasesOperation.execute(
      { suite: "s1", idempotencyKey: "cli-run-7" },
      { client }
    );
    const gen = calls.find((c) => /\/cases\/generate$/.test(c.path));
    expect(gen?.body).toEqual({ idempotencyKey: "cli-run-7" });
    expect(gen?.headers["idempotency-key"]).toBe("cli-run-7");
  });

  it("generate_eval_cases sends no key when the caller passes none", async () => {
    const { client, calls } = makeClient();
    await generateEvalCasesOperation.execute({ suite: "s1" }, { client });
    const gen = calls.find((c) => /\/cases\/generate$/.test(c.path));
    expect(gen?.body).toEqual({});
    expect(gen?.headers["idempotency-key"]).toBeUndefined();
  });

  it("generate_eval_cases is labelled as spending", () => {
    // `operationDescription` appends the "COSTS MONEY" warning to the MCP tool
    // off this facet, and the operation spends the organization's credits.
    expect(generateEvalCasesOperation.risk).toBe("spend");
  });

  it("generate_eval_cases omits varyUserStyles when not enabled", async () => {
    const { client, calls } = makeClient();
    await generateEvalCasesOperation.execute(
      { suite: "s1", varyUserStyles: false },
      { client }
    );
    const gen = calls.find((c) => /\/cases\/generate$/.test(c.path));
    expect(gen?.body).toEqual({});
  });
});

describe("eval suites × project environments", () => {
  it("set_eval_suite_schedule resolves an environment name into the pin", async () => {
    const { client, calls } = makeClient();
    await setEvalSuiteScheduleOperation.execute(
      {
        suite: "s1",
        enabled: true,
        intervalMinutes: 60,
        environment: "staging",
      },
      { client }
    );
    const schedule = calls.find((c) => /\/schedule$/.test(c.path));
    expect(schedule?.body).toEqual({
      enabled: true,
      intervalMinutes: 60,
      environmentId: "env-stg",
    });
  });

  it("set_eval_suite_schedule refuses an environment on a disable", async () => {
    const { client, calls } = makeClient();
    await expect(
      setEvalSuiteScheduleOperation.execute(
        { suite: "s1", enabled: false, environment: "Staging" },
        { client }
      )
    ).rejects.toThrow(/only applies when enabling/);
    // Rejected before anything is sent — the mutation would have dropped the
    // pin silently, which is exactly what the guard exists to prevent.
    expect(calls.filter((c) => /\/schedule$/.test(c.path))).toHaveLength(0);
  });

  it("generate_eval_cases forwards a resolved environmentId", async () => {
    const { client, calls } = makeClient();
    await generateEvalCasesOperation.execute(
      { suite: "s1", environment: "env-prod" },
      { client }
    );
    const gen = calls.find((c) => /\/cases\/generate$/.test(c.path));
    expect(gen?.body).toEqual({ environmentId: "env-prod" });
  });

  it("generate_eval_cases rejects environment together with servers", async () => {
    const { client, calls } = makeClient();
    await expect(
      generateEvalCasesOperation.execute(
        { suite: "s1", environment: "Staging", servers: ["echo"] },
        { client }
      )
    ).rejects.toThrow(/either environment or servers/);
    expect(calls).toHaveLength(0);
  });

  it("set_eval_suite_environments PATCHes the resolved ids in selector order", async () => {
    const { client, calls } = makeClient();
    await setEvalSuiteEnvironmentsOperation.execute(
      { suite: "My Suite", environments: ["Prod", "env-stg"] },
      { client }
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/v1/projects/p1/eval-suites/s1");
    expect(patch?.body).toEqual({ environmentIds: ["env-prod", "env-stg"] });
    // One listing for both selectors, not one per selector.
    expect(calls.filter((c) => /\/environments$/.test(c.path))).toHaveLength(1);
  });

  it("set_eval_suite_environments clears with null and never lists environments", async () => {
    const { client, calls } = makeClient();
    await setEvalSuiteEnvironmentsOperation.execute(
      { suite: "s1", environments: null },
      { client }
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ environmentIds: null });
    expect(calls.filter((c) => /\/environments$/.test(c.path))).toHaveLength(0);
  });

  it("set_eval_suite_environments catches a duplicate hiding behind two selectors", async () => {
    const { client } = makeClient();
    await expect(
      setEvalSuiteEnvironmentsOperation.execute(
        // Same environment named twice — once by id, once by name.
        { suite: "s1", environments: ["env-stg", "Staging"] },
        { client }
      )
    ).rejects.toThrow(/both refer to the environment "Staging"/);
  });

  it("set_eval_suite_environments rejects an empty list at the schema", () => {
    expect(
      setEvalSuiteEnvironmentsOperation.inputSchema.safeParse({
        suite: "s1",
        environments: [],
      }).success
    ).toBe(false);
    // …and requires the field: omitting it is not the same as clearing.
    expect(
      setEvalSuiteEnvironmentsOperation.inputSchema.safeParse({ suite: "s1" })
        .success
    ).toBe(false);
  });
});

/**
 * The suite-file sync marker on the write operations.
 *
 * A CI-owned suite — one whose configuration lives in a repository — refuses
 * these writes. The file's own sync is the exception, and it says so by naming
 * the suite's own `suite.id`. What these tests pin is that the marker actually
 * reaches the wire, in the right place for each verb, and that it never becomes
 * part of the thing being written.
 */
/**
 * ONE PLACE, EVERY VERB: the marker rides the QUERY STRING.
 *
 * Never the body. Every one of these `/v1` bodies is `.strict()`, on this
 * Inspector and on every Inspector that predates the CI-owned lock, and a
 * strict object refuses an unknown key with a 400. This package is versioned
 * independently of the deployment it talks to, so a body field would turn
 * `eval run --file` into a 400 against any self-hosted Inspector the user had
 * not upgraded in lockstep. A query parameter is read by deployments that know
 * it and ignored by those that do not.
 *
 * These assertions are what stop that regressing: a marker that moved back
 * into a body would still reach a current server, and would still pass a test
 * that only checked "the value arrived".
 */
describe("declaredSuiteId reaches the wire", () => {
  it("rides the query string on update_eval_suite", async () => {
    const { client, calls } = makeClient();
    await updateEvalSuiteOperation.execute(
      { suite: "s1", name: "Renamed", declaredSuiteId: "s_from_file" },
      { client, signal: undefined, onScopeResolved: undefined } as never
    );
    const write = calls.find((call) => call.method === "PATCH");
    expect(write?.query).toMatchObject({ declaredSuiteId: "s_from_file" });
    expect(write?.body).toMatchObject({ name: "Renamed" });
    expect(write?.body).not.toHaveProperty("declaredSuiteId");
  });

  it("rides the query string on update_eval_case, without joining the case definition", async () => {
    const { client, calls } = makeClient();
    await updateEvalCaseOperation.execute(
      {
        suite: "s1",
        case: "c2",
        title: "Renamed",
        declaredSuiteId: "s_from_file",
      },
      { client, signal: undefined, onScopeResolved: undefined } as never
    );
    const write = calls.find((call) => call.method === "PATCH");
    expect(write?.query).toMatchObject({ declaredSuiteId: "s_from_file" });
    expect(write?.body).toMatchObject({ title: "Renamed" });
    // A marker is not a case field. If it ever became one, a suite file's
    // cases would each carry the id of the suite that contains them.
    expect(write?.body).not.toHaveProperty("declaredSuiteId");
    expect(write?.body?.suite).toBeUndefined();
  });

  it("rides the query string on create_eval_cases", async () => {
    const { client, calls } = makeClient();
    await createEvalCasesOperation.execute(
      {
        suite: "s1",
        declaredSuiteId: "s_from_file",
        cases: [
          {
            title: "One",
            steps: [{ id: "s1", kind: "prompt", prompt: "hi" }],
          },
        ],
      } as never,
      { client, signal: undefined, onScopeResolved: undefined } as never
    );
    const write = calls.find((call) => call.method === "POST");
    expect(write?.query).toMatchObject({ declaredSuiteId: "s_from_file" });
    // One marker for the batch, not one per case: a batch is one write to one
    // suite, and a per-item marker would invite items that disagreed. And not
    // in the body at all — that is the 400 against an older Inspector.
    expect(write?.body).not.toHaveProperty("declaredSuiteId");
    expect(write?.body?.cases?.[0]).not.toHaveProperty("declaredSuiteId");
  });

  it("rides the query string on delete_eval_case", async () => {
    const { client, calls } = makeClient();
    await deleteEvalCaseOperation.execute(
      { suite: "s1", case: "c2", declaredSuiteId: "s_from_file" },
      { client, signal: undefined, onScopeResolved: undefined } as never
    );
    const write = calls.find((call) => call.method === "DELETE");
    // A DELETE with no body cannot carry a body field; making one route the
    // exception is a shape callers get wrong. So assert the QUERY STRING —
    // the wire, not just that a request happened.
    expect(write?.query).toMatchObject({ declaredSuiteId: "s_from_file" });
    expect(write?.body).toBeUndefined();
  });

  it("rides the query string on delete_eval_suite", async () => {
    const { client, calls } = makeClient();
    await deleteEvalSuiteOperation.execute(
      { suite: "s1", declaredSuiteId: "s_from_file" },
      { client, signal: undefined, onScopeResolved: undefined } as never
    );
    const write = calls.find((call) => call.method === "DELETE");
    expect(write?.query).toMatchObject({ declaredSuiteId: "s_from_file" });
  });

  it("rides the query string on set_eval_suite_schedule", async () => {
    const { client, calls } = makeClient();
    await setEvalSuiteScheduleOperation.execute(
      { suite: "s1", enabled: false, declaredSuiteId: "s_from_file" },
      { client, signal: undefined, onScopeResolved: undefined } as never
    );
    const write = calls.find((call) => call.method === "PATCH");
    expect(write?.query).toMatchObject({ declaredSuiteId: "s_from_file" });
    expect(write?.body).toMatchObject({ enabled: false });
    expect(write?.body).not.toHaveProperty("declaredSuiteId");
  });

  it("rides the query string on create_eval_case", async () => {
    const { client, calls } = makeClient();
    await createEvalCaseOperation.execute(
      {
        suite: "s1",
        title: "From the file",
        query: "list the invoices",
        declaredSuiteId: "s_from_file",
      },
      { client, signal: undefined, onScopeResolved: undefined } as never
    );
    const write = calls.find((call) => call.method === "POST");
    // Single-case sync has to reach the same file-sync exception the batch
    // form does, or a one-case suite file could not write itself.
    expect(write?.query).toMatchObject({ declaredSuiteId: "s_from_file" });
    expect(write?.body).not.toHaveProperty("declaredSuiteId");
  });

  it("omits the marker entirely on an ordinary edit", async () => {
    const { client, calls } = makeClient();
    await deleteEvalCaseOperation.execute(
      { suite: "s1", case: "c2" },
      { client, signal: undefined, onScopeResolved: undefined } as never
    );
    const write = calls.find((call) => call.method === "DELETE");
    // Not a capability: an app edit sends nothing, and gets the refusal a
    // CI-owned suite is right to give it.
    expect(write?.query).not.toHaveProperty("declaredSuiteId");
  });

  it("rides the query string on set_eval_suite_environments", async () => {
    const { client, calls } = makeClient();
    await setEvalSuiteEnvironmentsOperation.execute(
      { suite: "s1", environments: null, declaredSuiteId: "s_from_file" },
      { client, signal: undefined, onScopeResolved: undefined } as never
    );
    const write = calls.find((call) => call.method === "PATCH");
    expect(write?.query).toMatchObject({ declaredSuiteId: "s_from_file" });
    expect(write?.body).toMatchObject({ environmentIds: null });
    expect(write?.body).not.toHaveProperty("declaredSuiteId");
  });

  it("sends nothing at all when the caller named no id", async () => {
    const { client, calls } = makeClient();
    await updateEvalSuiteOperation.execute(
      { suite: "s1", name: "Renamed" },
      { client, signal: undefined, onScopeResolved: undefined } as never
    );
    // An ordinary edit must not carry an empty marker: the route would forward
    // it, and a platform that predates the lock rejects unknown arguments.
    expect(
      calls.find((call) => call.method === "PATCH")?.body
    ).not.toHaveProperty("declaredSuiteId");
  });
});
