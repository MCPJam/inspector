import { describe, expect, it, vi } from "vitest";
import {
  ensureAdhocEnvironmentOperation,
  nameEnvironmentOperation,
  PlatformApiClient,
  PlatformApiError,
  runEvalCaseOperation,
  runEvalSuiteOperation,
} from "../../src/platform/index.js";

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
}

function makeClient(fixture: Fixture = {}) {
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const path = new URL(String(target)).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
    if (/\/hosts$/.test(path)) return Response.json({ items: HOSTS });
    if (/\/images$/.test(path)) return Response.json({ items: IMAGES });
    if (/\/eval-suites$/.test(path)) return Response.json({ items: [SUITE] });
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
      return Response.json({
        environment: ADHOC_ENVIRONMENT,
        created: !fixture.alreadyEnsured,
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
  it("ensures the stack, ATTACHES it, and launches pinned to it", async () => {
    const { client, fetchMock } = makeClient();
    const result = await runEvalSuiteOperation.execute(
      {
        suite: "Smoke",
        compose: { host: "Claude Code", computer: "default" },
      },
      { client },
    );

    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toEqual({
      hostId: "host-claude",
      sandboxImageId: "img-default",
    });
    // ATOMIC APPEND, not a replace: the replace door would silently detach an
    // environment someone else attached between read and write.
    expect(bodyOf(fetchMock, /\/eval-suites\/suite-1\/environments$/)).toEqual({
      environmentId: ADHOC_ENVIRONMENT.id,
    });
    // The launch takes the ORDINARY environment path — no new run-level
    // execution-context channel.
    expect(bodyOf(fetchMock, /\/eval-runs$/)).toEqual({
      suiteId: SUITE.id,
      environmentId: ADHOC_ENVIRONMENT.id,
    });
    expect(result.composed).toEqual({
      environment: {
        id: ADHOC_ENVIRONMENT.id,
        name: null,
        adhoc: true,
        created: true,
      },
      attachment: { attached: true },
    });
  });

  it("reports both persisted writes as no-ops on a repeat compose", async () => {
    const { client } = makeClient({
      alreadyEnsured: true,
      alreadyAttached: true,
    });
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke", compose: { host: "Claude Code" } },
      { client },
    );
    expect(result.composed).toEqual({
      environment: {
        id: ADHOC_ENVIRONMENT.id,
        name: null,
        adhoc: true,
        created: false,
      },
      attachment: { attached: false },
    });
  });

  it("still tells the caller the suite CHANGED when the launch fails", async () => {
    // Compose writes before it spends. An unannotated error would leave the
    // caller believing nothing happened, when their suite's attachment list
    // has already changed.
    const { client, fetchMock } = makeClient({ launchFails: true });
    const error = await runEvalSuiteOperation
      .execute(
        { suite: "Smoke", compose: { host: "Claude Code" } },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformApiError);
    const message = (error as PlatformApiError).message;
    expect(message).toContain("environment revision conflict");
    expect(message).toContain(ADHOC_ENVIRONMENT.id);
    expect(message).toContain("retrying is safe");
    // The writes really did happen, in order.
    expect(bodyOf(fetchMock, /ensure-adhoc$/)).toBeDefined();
    expect(
      bodyOf(fetchMock, /\/eval-suites\/suite-1\/environments$/),
    ).toBeDefined();
    // STRUCTURED as well as prose, so a surface deciding whether to warn about
    // the suite edit reads a field instead of parsing a sentence.
    expect((error as PlatformApiError).details?.composed).toEqual({
      environment: {
        id: ADHOC_ENVIRONMENT.id,
        name: null,
        adhoc: true,
        created: true,
      },
      attachment: { attached: true },
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
          compose: { host: "Claude Code" },
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
      { suite: "Smoke", compose: { host: "Claude Code" }, environment: "e" },
      { suite: "Smoke", compose: { host: "Claude Code" }, host: "ChatGPT" },
      { suite: "Smoke", compose: { host: "Claude Code" }, servers: ["s"] },
      { suite: "Smoke", compose: { host: "Claude Code" }, allAttached: true },
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
  it("composes, attaches, and pins the single-case run to the result", async () => {
    const { client, fetchMock } = makeClient();
    const result = await runEvalCaseOperation.execute(
      {
        suite: "Smoke",
        case: "echo works",
        compose: { host: "Claude Code", model: "anthropic/claude-haiku-4.5" },
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
      environmentId: ADHOC_ENVIRONMENT.id,
    });
    expect(result.composed?.environment.created).toBe(true);
    expect(result.composed?.attachment.attached).toBe(true);
  });
});
