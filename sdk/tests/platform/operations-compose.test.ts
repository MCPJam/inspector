import { describe, expect, it, vi } from "vitest";
import {
  ensureAdhocEnvironmentOperation,
  getEnvironmentOperation,
  nameEnvironmentOperation,
  PlatformApiClient,
  PlatformApiError,
  runEvalCaseOperation,
  runEvalSuiteOperation,
} from "../../src/platform/index.js";
import { expandComposeModelChoices } from "../../src/platform/operations.js";

/**
 * COMPOSED run targets: assembling a client/model/computer/skills stack instead
 * of naming a saved environment.
 *
 * Two properties are load-bearing and are what these cover. First, a composed
 * stack is an ENVIRONMENT — it resolves to an ad-hoc row and launches through
 * the ordinary environment path, so nothing gains a second execution-context
 * channel. Second, composing WRITES before it spends (it ensures a row and
 * edits the suite's attachment list), so a caller must learn what changed even
 * when the launch itself fails.
 */

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};

const SUITE = {
  id: "suite-1",
  name: "Smoke",
  description: null,
  projectId: PROJECT.id,
  createdAt: 1,
  updatedAt: 2,
};

const HOSTS = [
  { id: "host-claude", name: "Claude Code", projectId: PROJECT.id },
  { id: "host-chatgpt", name: "ChatGPT", projectId: PROJECT.id },
];

const IMAGES = [
  { id: "img-default", name: "default", projectId: PROJECT.id },
  { id: "img-heavy", name: "heavy", projectId: PROJECT.id },
];

const SERVERS = [
  {
    id: "srv-vercel",
    name: "Vercel",
    projectId: PROJECT.id,
    enabled: true,
    transportType: "http",
    url: "https://vercel.test/mcp",
    useOAuth: false,
    hasClientSecret: false,
  },
  {
    id: "srv-sentry",
    name: "Sentry",
    projectId: PROJECT.id,
    enabled: true,
    transportType: "http",
    url: "https://sentry.test/mcp",
    useOAuth: false,
    hasClientSecret: false,
  },
  {
    id: "srv-local",
    name: "Local",
    projectId: PROJECT.id,
    enabled: true,
    transportType: "stdio",
    url: null,
    useOAuth: false,
    hasClientSecret: false,
  },
];

const ADHOC_ENVIRONMENT = {
  id: "env-adhoc-1",
  projectId: PROJECT.id,
  name: null,
  adhoc: true,
  hostId: "host-claude",
  revision: 1,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
};

interface Fixture {
  /** Model a stack that had already been composed. */
  alreadyEnsured?: boolean;
  /** Model an environment already attached to the suite. */
  alreadyAttached?: boolean;
  /** Model a deployment with no ad-hoc environments at all. */
  adhocUnavailable?: boolean;
  /** Make the LAUNCH fail after compose has already written. */
  launchFails?: boolean;
  /** Make promotion fail the way an already-named row does. */
  alreadyNamed?: boolean;
  /** Omit / lie about ephemeralEnvironmentLaunch (old backend). */
  ephemeralLaunch?: boolean;
  /** Deployment that predates environment model overrides. */
  modelOverrides?: boolean;
  /** Suite already has these attached environment ids (union-cap tests). */
  attachedEnvironmentIds?: string[];
  /** Server groups the project already holds. */
  serverGroups?: Array<{ id: string; name: string; serverIds: string[] }>;
  /** Deployment that predates the server-group routes (404s the route). */
  serverGroupsUnavailable?: boolean;
  /**
   * Names whose FIRST create attempt answers 409, modelling a name already
   * taken by a group holding different servers.
   */
  takenGroupNames?: string[];
  /**
   * A concurrent compose that wins the create race: the conflicting POST is
   * answered 409 AND this group appears in the next list.
   */
  raceGroupOnConflict?: { id: string; name: string; serverIds: string[] };
}

function makeClient(fixture: Fixture = {}) {
  // Mutable so a create is visible to the list that follows it — the
  // conflict-then-relist path depends on that ordering.
  const serverGroups = [...(fixture.serverGroups ?? [])];
  let createdGroupCount = 0;
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const path = new URL(String(target)).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
    if (/\/hosts$/.test(path)) return Response.json({ items: HOSTS });
    if (/\/images$/.test(path)) return Response.json({ items: IMAGES });
    if (/\/servers$/.test(path) && method === "GET") {
      return Response.json({ items: SERVERS });
    }
    if (/\/server-groups$/.test(path) && fixture.serverGroupsUnavailable) {
      return Response.json(
        { code: "NOT_FOUND", message: "Not Found" },
        { status: 404 },
      );
    }
    if (/\/server-groups$/.test(path) && method === "GET") {
      return Response.json({
        items: serverGroups.map((group) => ({
          ...group,
          description: null,
          serverNames: [],
          createdAt: 1,
          updatedAt: 1,
        })),
      });
    }
    if (/\/server-groups$/.test(path) && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        name: string;
        serverIds: string[];
      };
      if (fixture.takenGroupNames?.includes(body.name)) {
        if (fixture.raceGroupOnConflict) {
          serverGroups.push(fixture.raceGroupOnConflict);
        }
        return Response.json(
          {
            code: "CONFLICT",
            message:
              "A server group with that name already exists in this project.",
          },
          { status: 409 },
        );
      }
      createdGroupCount += 1;
      const group = {
        id: `grp-created-${createdGroupCount}`,
        name: body.name,
        serverIds: body.serverIds,
      };
      serverGroups.push(group);
      return Response.json(
        {
          ...group,
          description: null,
          serverNames: [],
          createdAt: 1,
          updatedAt: 1,
        },
        { status: 201 },
      );
    }
    if (/\/eval-suites$/.test(path) && method === "GET") {
      return Response.json({ items: [SUITE] });
    }
    if (/\/environments\/capabilities$/.test(path)) {
      return Response.json({
        modelOverrides: fixture.modelOverrides !== false,
        modelMatrix: fixture.modelOverrides !== false,
        ephemeralEnvironmentLaunch: fixture.ephemeralLaunch !== false,
      });
    }
    if (/\/environments\/[^/]+$/.test(path) && method === "GET") {
      const id = path.split("/").pop()!;
      return Response.json({
        ...ADHOC_ENVIRONMENT,
        id,
        name: null,
        adhoc: true,
      });
    }
    if (/\/eval-run-groups$/.test(path) && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        targets: Array<{ environmentId?: string }>;
      };
      return Response.json(
        {
          runGroupId: "grp-composed",
          suiteId: SUITE.id,
          outcome: "started",
          startedCount: body.targets.length,
          failedCount: 0,
          targets: body.targets.map((target, index) => ({
            target,
            status: "started",
            runId: `run-composed-${index + 1}`,
            runStatus: "running",
            servers: [],
            environment: target.environmentId
              ? { id: target.environmentId, name: null, revision: 1 }
              : null,
          })),
        },
        { status: 202 },
      );
    }
    if (/\/eval-suites\/[^/]+\/cases$/.test(path)) {
      return Response.json({
        items: [{ id: "case-1", suiteId: SUITE.id, title: "echo works" }],
      });
    }
    if (/\/environments\/ensure-adhoc$/.test(path) && method === "POST") {
      if (fixture.adhocUnavailable) {
        return Response.json(
          {
            code: "VALIDATION_ERROR",
            message:
              "This deployment predates ad-hoc environments — create a named environment instead (POST /environments).",
            details: { reason: "ADHOC_UNAVAILABLE" },
          },
          { status: 400 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { modelId?: string };
      const id = body.modelId
        ? `env-adhoc-${body.modelId.replace(/[^a-z0-9]+/gi, "-")}`
        : ADHOC_ENVIRONMENT.id;
      return Response.json({
        environment: { ...ADHOC_ENVIRONMENT, id, modelId: body.modelId },
        created: !fixture.alreadyEnsured,
      });
    }
    if (/\/eval-suites\/[^/]+$/.test(path) && method === "GET") {
      return Response.json({
        ...SUITE,
        environmentIds: fixture.attachedEnvironmentIds ?? [],
        hosts: [],
      });
    }
    if (/\/eval-suites\/[^/]+\/environments$/.test(path) && method === "POST") {
      return Response.json({
        suiteId: SUITE.id,
        attached: !fixture.alreadyAttached,
        environmentIds: [ADHOC_ENVIRONMENT.id],
      });
    }
    if (/\/environments\/[^/]+\/name$/.test(path) && method === "POST") {
      if (fixture.alreadyNamed) {
        return Response.json(
          {
            code: "CONFLICT",
            message:
              "This environment already has a name. Rename it from the Environments list.",
          },
          { status: 409 },
        );
      }
      return Response.json({
        ...ADHOC_ENVIRONMENT,
        name: "Claude Code smoke",
        revision: 2,
      });
    }
    if (/\/eval-runs$/.test(path) && method === "POST") {
      if (fixture.launchFails) {
        return Response.json(
          { code: "CONFLICT", message: "environment revision conflict" },
          { status: 409 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { environmentId?: string };
      return Response.json(
        {
          runId: "run-composed",
          suiteId: SUITE.id,
          status: "running",
          caseUpsert: { committed: [], failed: [] },
          servers: [],
          environment: body.environmentId
            ? { id: body.environmentId, name: null, revision: 1 }
            : null,
        },
        { status: 202 },
      );
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, suffix: RegExp) {
  const call = fetchMock.mock.calls.find(([target]) =>
    suffix.test(new URL(String(target)).pathname),
  );
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
}

describe("ensure_adhoc_environment", () => {
  it("resolves host and image SELECTORS to the ids the platform stores", async () => {
    const { client, fetchMock } = makeClient();
    const result = await ensureAdhocEnvironmentOperation.execute(
      {
        host: "Claude Code",
        computer: "heavy",
        model: "anthropic/claude-sonnet-4-5",
      },
      { client },
    );
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toEqual({
      hostId: "host-claude",
      sandboxImageId: "img-heavy",
      modelId: "anthropic/claude-sonnet-4-5",
    });
    expect(result.created).toBe(true);
    expect(result.environment.name).toBeNull();
    expect(result.environment.adhoc).toBe(true);
  });

  it("reports created:false when the same stack was already composed", async () => {
    // Content-addressed: the caller learns a repeat from `created`, because the
    // status line cannot say — get-or-create answers 200 either way.
    const { client } = makeClient({ alreadyEnsured: true });
    const result = await ensureAdhocEnvironmentOperation.execute(
      { host: "Claude Code" },
      { client },
    );
    expect(result.created).toBe(false);
    expect(result.environment.id).toBe(ADHOC_ENVIRONMENT.id);
  });

  it("surfaces the platform's own message when ad-hoc rows are unsupported", async () => {
    const { client } = makeClient({ adhocUnavailable: true });
    const error = await ensureAdhocEnvironmentOperation
      .execute({ host: "Claude Code" }, { client })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toContain(
      "predates ad-hoc environments",
    );
  });
});

/**
 * `server`/`servers` on a composed stack.
 *
 * The bug they close: without a pinned group, a composed environment follows
 * its HOST's live server list, so editing a shared host silently repoints
 * every eval composed against it. These selectors snapshot the servers into a
 * group instead, and the environment pins that group.
 *
 * Reuse is by CONTENT, not name, because the environment fingerprint keys on
 * the group id — minting a fresh group per run would mint a fresh environment
 * per run and leave undeletable near-duplicates behind.
 */
describe("compose server selectors", () => {
  function groupBodies(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls
      .filter(
        ([target, init]) =>
          /\/server-groups$/.test(new URL(String(target)).pathname) &&
          (init as RequestInit | undefined)?.method === "POST",
      )
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
  }

  it("resolves server names, snapshots a group, and pins it on the stack", async () => {
    const { client, fetchMock } = makeClient();
    await ensureAdhocEnvironmentOperation.execute(
      { host: "Claude Code", server: "Vercel" },
      { client },
    );
    expect(groupBodies(fetchMock)).toEqual([
      { name: "Vercel", serverIds: ["srv-vercel"] },
    ]);
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toEqual({
      hostId: "host-claude",
      serverAttachmentId: "grp-created-1",
    });
  });

  it("reuses a group holding the same servers, whatever its name or order", async () => {
    const { client, fetchMock } = makeClient({
      serverGroups: [
        {
          id: "grp-existing",
          name: "hand made",
          serverIds: ["srv-sentry", "srv-vercel"],
        },
      ],
    });
    await ensureAdhocEnvironmentOperation.execute(
      { host: "Claude Code", servers: ["Vercel", "Sentry"] },
      { client },
    );
    expect(groupBodies(fetchMock)).toEqual([]);
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toEqual({
      hostId: "host-claude",
      serverAttachmentId: "grp-existing",
    });
  });

  it("names a group independently of the order the servers were typed", async () => {
    const { client, fetchMock } = makeClient();
    await ensureAdhocEnvironmentOperation.execute(
      { host: "Claude Code", servers: ["Vercel", "Sentry"] },
      { client },
    );
    expect(groupBodies(fetchMock)).toEqual([
      { name: "Sentry + Vercel", serverIds: ["srv-vercel", "srv-sentry"] },
    ]);
  });

  it("resolves the group ONCE across a model matrix, not per cell", async () => {
    // Resolving inside the fan-out would re-list per cell and let the run race
    // itself into a name conflict against its own earlier create.
    const { client, fetchMock } = makeClient();
    await runEvalSuiteOperation.execute(
      {
        suite: "Smoke",
        compose: {
          host: "Claude Code",
          server: "Vercel",
          models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5.6"],
        },
      },
      { client },
    );
    expect(groupBodies(fetchMock)).toHaveLength(1);
    const ensureCalls = fetchMock.mock.calls.filter(([target]) =>
      /ensure-adhoc$/.test(new URL(String(target)).pathname),
    );
    expect(ensureCalls).toHaveLength(2);
    for (const [, init] of ensureCalls) {
      expect(
        JSON.parse(String((init as RequestInit).body)).serverAttachmentId,
      ).toBe("grp-created-1");
    }
  });

  it("reuses the winner when a concurrent compose takes the name first", async () => {
    const { client, fetchMock } = makeClient({
      takenGroupNames: ["Vercel"],
      raceGroupOnConflict: {
        id: "grp-raced",
        name: "Vercel",
        serverIds: ["srv-vercel"],
      },
    });
    await ensureAdhocEnvironmentOperation.execute(
      { host: "Claude Code", server: "Vercel" },
      { client },
    );
    // The conflict is not an error: the other writer created exactly the group
    // this run wanted, so it is adopted rather than suffixed around.
    expect(groupBodies(fetchMock)).toEqual([
      { name: "Vercel", serverIds: ["srv-vercel"] },
    ]);
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toEqual({
      hostId: "host-claude",
      serverAttachmentId: "grp-raced",
    });
  });

  it("suffixes when the name is taken by a group holding OTHER servers", async () => {
    const { client, fetchMock } = makeClient({
      takenGroupNames: ["Vercel"],
      serverGroups: [
        { id: "grp-stale", name: "Vercel", serverIds: ["srv-sentry"] },
      ],
    });
    await ensureAdhocEnvironmentOperation.execute(
      { host: "Claude Code", server: "Vercel" },
      { client },
    );
    expect(groupBodies(fetchMock)).toEqual([
      { name: "Vercel", serverIds: ["srv-vercel"] },
      { name: "Vercel (2)", serverIds: ["srv-vercel"] },
    ]);
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toEqual({
      hostId: "host-claude",
      serverAttachmentId: "grp-created-1",
    });
  });

  it("names the escape hatch on a deployment without the routes", async () => {
    // The routes ship with the inspector server, so a platform that has not
    // taken that deploy 404s the ROUTE. A bare "not found" would name nothing
    // the caller can act on, and --compose-server-group still works there.
    const { client } = makeClient({ serverGroupsUnavailable: true });
    const error = await ensureAdhocEnvironmentOperation
      .execute({ host: "Claude Code", server: "Vercel" }, { client })
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain(
      "--compose-server-group",
    );
  });

  it("refuses a stdio server before writing anything", async () => {
    const { client, fetchMock } = makeClient();
    const error = await ensureAdhocEnvironmentOperation
      .execute({ host: "Claude Code", server: "Local" }, { client })
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain(
      "stdio servers are not supported",
    );
    expect(groupBodies(fetchMock)).toEqual([]);
  });

  it("refuses an unknown server name", async () => {
    const { client } = makeClient();
    const error = await ensureAdhocEnvironmentOperation
      .execute({ host: "Claude Code", server: "Nope" }, { client })
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain("was not found");
  });

  it("rejects `servers` together with an explicit `serverGroup`", async () => {
    // Both fill one slot. Guarded twice on purpose: the schema catches callers
    // that parse their input, and `execute` catches the rest — without the
    // second the resolved group would silently overwrite the explicit one.
    const parsed = ensureAdhocEnvironmentOperation.inputSchema.safeParse({
      host: "Claude Code",
      server: "Vercel",
      serverGroup: "grp-x",
    });
    expect(parsed.success).toBe(false);

    const { client, fetchMock } = makeClient();
    const error = await ensureAdhocEnvironmentOperation
      .execute(
        { host: "Claude Code", server: "Vercel", serverGroup: "grp-x" },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toContain("not both");
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeUndefined();
  });

  it("rejects the singular and plural spellings together", async () => {
    const parsed = ensureAdhocEnvironmentOperation.inputSchema.safeParse({
      host: "Claude Code",
      server: "Vercel",
      servers: ["Sentry"],
    });
    expect(parsed.success).toBe(false);

    // The schema only runs for callers that parse. A direct `execute()` would
    // otherwise drop `server`, silently spending the run on `servers`.
    const { client, fetchMock } = makeClient();
    const error = await ensureAdhocEnvironmentOperation
      .execute(
        { host: "Claude Code", server: "Vercel", servers: ["Sentry"] },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toContain("not both");
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeUndefined();
  });

  it("refuses a composed run that names no servers", async () => {
    // The whole defect in one case: without a pin the run reads the host's
    // list at execution time, so editing that shared host repoints the eval.
    const { client, fetchMock } = makeClient();
    const error = await runEvalSuiteOperation
      .execute({ suite: "Smoke", compose: { host: "Claude Code" } }, { client })
      .catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toContain("must say which servers");
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeUndefined();
    expect(bodyOf(fetchMock, /eval-runs$/)).toBeUndefined();
  });

  it("follows the host's live list only when asked out loud", async () => {
    const { client, fetchMock } = makeClient();
    await runEvalSuiteOperation.execute(
      { suite: "Smoke", compose: { host: "Claude Code", hostServers: true } },
      { client },
    );
    // Opting in composes as before — no group is pinned, so the runner resolves
    // servers from the host.
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toEqual({
      hostId: "host-claude",
    });
  });

  it("refuses a single case run that names no servers", async () => {
    const { client, fetchMock } = makeClient();
    const error = await runEvalCaseOperation
      .execute(
        { suite: "Smoke", case: "case-1", compose: { host: "Claude Code" } },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect(String((error as Error).message)).toContain("must say which servers");
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeUndefined();
  });

  it("pins the same way for a single case run", async () => {
    const { client, fetchMock } = makeClient();
    await runEvalCaseOperation.execute(
      {
        suite: "Smoke",
        case: "case-1",
        compose: { host: "Claude Code", server: "Vercel" },
      },
      { client },
    );
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toEqual({
      hostId: "host-claude",
      serverAttachmentId: "grp-created-1",
    });
  });
});

describe("name_environment", () => {
  it("promotes an ad-hoc row in place, keeping its id", async () => {
    const { client, fetchMock } = makeClient();
    const result = await nameEnvironmentOperation.execute(
      {
        environment: ADHOC_ENVIRONMENT.id,
        expectedRevision: 1,
        name: "Claude Code smoke",
      },
      { client },
    );
    expect(bodyOf(fetchMock, /\/name$/)).toEqual({
      expectedRevision: 1,
      name: "Claude Code smoke",
    });
    // Same id every existing run still points at.
    expect(result.id).toBe(ADHOC_ENVIRONMENT.id);
    expect(result.name).toBe("Claude Code smoke");
  });

  it("passes the platform's refusal through for an already-named row", async () => {
    const { client } = makeClient({ alreadyNamed: true });
    const error = await nameEnvironmentOperation
      .execute(
        { environment: "env-named", expectedRevision: 3, name: "Nope" },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain("already has a name");
  });
});

describe("run_eval_suite compose", () => {
  it("ensures the stack and launches ephemerally without attaching", async () => {
    const { client, fetchMock } = makeClient();
    const result = await runEvalSuiteOperation.execute(
      {
        suite: "Smoke",
        compose: { host: "Claude Code", hostServers: true, computer: "default" },
      },
      { client },
    );

    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toEqual({
      hostId: "host-claude",
      sandboxImageId: "img-default",
    });
    expect(
      bodyOf(fetchMock, /\/eval-suites\/suite-1\/environments$/),
    ).toBeUndefined();
    expect(bodyOf(fetchMock, /\/eval-runs$/)).toEqual({
      suiteId: SUITE.id,
      environmentId: ADHOC_ENVIRONMENT.id,
      ephemeralEnvironment: true,
    });
    expect(result.composed?.attachment).toEqual({ attached: false });
    expect(result.composed?.environment.id).toBe(ADHOC_ENVIRONMENT.id);
  });

  it("attaches on saveTargets", async () => {
    const { client, fetchMock } = makeClient();
    const result = await runEvalSuiteOperation.execute(
      {
        suite: "Smoke",
        compose: { host: "Claude Code", hostServers: true, saveTargets: true },
      },
      { client },
    );
    expect(bodyOf(fetchMock, /\/eval-suites\/suite-1\/environments$/)).toEqual({
      environmentId: ADHOC_ENVIRONMENT.id,
    });
    expect(bodyOf(fetchMock, /\/eval-runs$/)).toEqual({
      suiteId: SUITE.id,
      environmentId: ADHOC_ENVIRONMENT.id,
    });
    expect(result.composed?.attachment).toEqual({ attached: true });
  });

  it("still tells the caller the cells were minted when the launch fails", async () => {
    // Compose writes before it spends. An unannotated error would leave the
    // caller believing nothing happened, when their suite's attachment list
    // has already changed.
    const { client, fetchMock } = makeClient({ launchFails: true });
    const error = await runEvalSuiteOperation
      .execute(
        { suite: "Smoke", compose: { host: "Claude Code", hostServers: true } },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformApiError);
    const message = (error as PlatformApiError).message;
    expect(message).toContain("environment revision conflict");
    expect(message).toContain(ADHOC_ENVIRONMENT.id);
    expect(message).toContain("retrying is safe");
    expect(message).toContain("minted without attaching");
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeDefined();
    expect(
      bodyOf(fetchMock, /\/eval-suites\/suite-1\/environments$/),
    ).toBeUndefined();
    expect((error as PlatformApiError).details?.composed).toMatchObject({
      environment: { id: ADHOC_ENVIRONMENT.id, created: true },
      attachment: { attached: false },
    });
  });

  it("forces a group plan for multi-model compose", async () => {
    const { client, fetchMock } = makeClient();
    const result = await runEvalSuiteOperation.execute(
      {
        suite: "Smoke",
        compose: {
          host: "Claude Code",
          hostServers: true,
          models: [
            "anthropic/claude-haiku-4.5",
            "google/gemini-2.5-flash",
          ],
        },
      },
      { client },
    );
    expect(result.runGroupId).toBe("grp-composed");
    expect(result.startedCount).toBe(2);
    expect(bodyOf(fetchMock, /\/eval-run-groups$/)).toMatchObject({
      suiteId: SUITE.id,
      ephemeralEnvironment: true,
      targets: [
        { environmentId: "env-adhoc-anthropic-claude-haiku-4-5" },
        { environmentId: "env-adhoc-google-gemini-2-5-flash" },
      ],
    });
    expect(
      bodyOf(fetchMock, /\/eval-suites\/suite-1\/environments$/),
    ).toBeUndefined();
  });

  it("rejects multi-cell × refreshSnapshot before minting", async () => {
    const { client, fetchMock } = makeClient();
    const error = await runEvalSuiteOperation
      .execute(
        {
          suite: "Smoke",
          refreshSnapshot: true,
          compose: {
            host: "Claude Code",
            models: ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash"],
          },
        },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain("refreshSnapshot");
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeUndefined();
  });

  it("refuses multi-model compose when the backend lacks ephemeral launch", async () => {
    const { client, fetchMock } = makeClient({ ephemeralLaunch: false });
    const error = await runEvalSuiteOperation
      .execute(
        {
          suite: "Smoke",
          compose: {
            host: "Claude Code",
            models: ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash"],
          },
        },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain(
      "ephemeralEnvironmentLaunch",
    );
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeUndefined();
  });

  it("refuses a named model when the backend lacks model overrides", async () => {
    // `environments create --model` has always preflighted this. The compose
    // path — the one that grew a model axis — did not, so a skew deployment
    // answered --compose-model with the raw validator error from
    // ensure-adhoc. Refused before any write.
    const { client, fetchMock } = makeClient({ modelOverrides: false });
    const error = await runEvalSuiteOperation
      .execute(
        {
          suite: "Smoke",
          compose: {
            host: "Claude Code",
            models: ["anthropic/claude-haiku-4.5"],
          },
        },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain(
      "does not support environment model overrides",
    );
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeUndefined();
  });

  it("still composes an inherit-only stack on a backend without model overrides", async () => {
    // Nothing sends a modelId here, so the missing capability is irrelevant —
    // gating on "compose was used" rather than "a model was named" would
    // break every composed run against an older deployment.
    const { client, fetchMock } = makeClient({ modelOverrides: false });
    await runEvalSuiteOperation.execute(
      { suite: "Smoke", compose: { host: "Claude Code", hostServers: true } },
      { client },
    );
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeDefined();
  });

  it("falls back to attach for a single cell on an old backend", async () => {
    const { client, fetchMock } = makeClient({ ephemeralLaunch: false });
    await runEvalSuiteOperation.execute(
      { suite: "Smoke", compose: { host: "Claude Code", hostServers: true } },
      { client },
    );
    expect(
      bodyOf(fetchMock, /\/eval-suites\/suite-1\/environments$/),
    ).toBeDefined();
    expect(bodyOf(fetchMock, /\/eval-runs$/)).toEqual({
      suiteId: SUITE.id,
      environmentId: ADHOC_ENVIRONMENT.id,
    });
  });

  it("does not compose at all when a CASE selector is wrong", async () => {
    // Compose writes; resolving cases only reads. Composing first meant a
    // mistyped case name left an environment created and attached to the
    // suite, for a run that never started, with an error that said nothing
    // about it. Every read that can reject the request happens while
    // rejecting is still free.
    const { client, fetchMock } = makeClient();
    const error = await runEvalSuiteOperation
      .execute(
        {
          suite: "Smoke",
          compose: { host: "Claude Code", hostServers: true },
          cases: ["no such case"],
        },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeUndefined();
    expect(
      bodyOf(fetchMock, /\/eval-suites\/suite-1\/environments$/),
    ).toBeUndefined();
    expect(bodyOf(fetchMock, /\/eval-runs$/)).toBeUndefined();
  });

  it("rejects compose alongside any target selector, spending nothing", async () => {
    // Silently ignoring it would be worse than usual: composing has a
    // persistent side effect, so the suite would be edited for a run that did
    // not use the result.
    const { client, fetchMock } = makeClient();
    for (const input of [
      { suite: "Smoke", compose: { host: "Claude Code", hostServers: true }, environment: "e" },
      { suite: "Smoke", compose: { host: "Claude Code", hostServers: true }, host: "ChatGPT" },
      { suite: "Smoke", compose: { host: "Claude Code", hostServers: true }, servers: ["s"] },
      { suite: "Smoke", compose: { host: "Claude Code", hostServers: true }, allAttached: true },
    ]) {
      const error = await runEvalSuiteOperation
        .execute(input, { client })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PlatformApiError);
      expect((error as PlatformApiError).message).toContain("compose");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("run_eval_case compose", () => {
  it("composes ephemerally and pins the single-case run to the result", async () => {
    const { client, fetchMock } = makeClient();
    const result = await runEvalCaseOperation.execute(
      {
        suite: "Smoke",
        case: "echo works",
        compose: { host: "Claude Code", hostServers: true, model: "anthropic/claude-haiku-4.5" },
      },
      { client },
    );
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toEqual({
      hostId: "host-claude",
      modelId: "anthropic/claude-haiku-4.5",
    });
    expect(bodyOf(fetchMock, /\/eval-runs$/)).toEqual({
      suiteId: SUITE.id,
      caseIds: ["case-1"],
      environmentId: "env-adhoc-anthropic-claude-haiku-4-5",
      ephemeralEnvironment: true,
    });
    expect(result.composed?.environment.created).toBe(true);
    expect(result.composed?.attachment.attached).toBe(false);
  });

  it("rejects more than one compose model on a case run", async () => {
    const { client, fetchMock } = makeClient();
    const error = await runEvalCaseOperation
      .execute(
        {
          suite: "Smoke",
          case: "echo works",
          compose: {
            host: "Claude Code",
            models: ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash"],
          },
        },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain("only one compose model");
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeUndefined();
  });
});

describe("resolveEnvironmentSelector id passthrough", () => {
  // A real Convex document id: 32 lowercase base32 characters, no separators.
  // The shape is load-bearing — the fast path deliberately ignores anything
  // that could be a display name, so a readable stand-in like
  // `env-adhoc-hidden-01` would take the list path and never reach the GET.
  const HIDDEN_ADHOC_ID = "x173p8g5kd3xvrk2btsp8bq3rs8c7yny";

  it("resolves a list-hidden ad-hoc row by id via GET", async () => {
    const { client } = makeClient();
    const result = await getEnvironmentOperation.execute(
      { environment: HIDDEN_ADHOC_ID },
      { client },
    );
    expect(result.id).toBe(HIDDEN_ADHOC_ID);
  });
});

describe("expandComposeModelChoices", () => {
  it("inherits only when no models are named", () => {
    expect(expandComposeModelChoices({})).toEqual([{ modelId: undefined }]);
  });

  it("replaces the client default unless includeClientDefault is set", () => {
    expect(
      expandComposeModelChoices({ models: ["google/gemini-2.5-flash"] }),
    ).toEqual([{ modelId: "google/gemini-2.5-flash" }]);
    expect(
      expandComposeModelChoices({
        models: ["google/gemini-2.5-flash"],
        includeClientDefault: true,
      }),
    ).toEqual([
      { modelId: undefined },
      { modelId: "google/gemini-2.5-flash" },
    ]);
  });
});
