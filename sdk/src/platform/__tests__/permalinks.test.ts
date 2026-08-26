import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCPJAM_APP_ORIGIN,
  PLATFORM_PERMALINK_ROUTES,
  PROJECT_DEEP_LINK_PARAM,
  PlatformPermalinkError,
  buildAppPermalink,
  buildAppPermalinks,
  derivePermalinksFor,
  formatPermalinkLines,
  isPlatformResourceType,
  noPermalink,
  runOperationWithPermalinks,
  withPermalinkEnvelope,
  type PlatformPermalink,
  type PlatformResourceRef,
  type PlatformResourceType,
} from "../permalinks.js";

const ORIGIN = DEFAULT_MCPJAM_APP_ORIGIN;
const PROJECT = "v977phvmg9dttdemo";

function build(
  resource: PlatformResourceRef,
  appOrigin = ORIGIN,
): PlatformPermalink {
  return buildAppPermalink(resource, { appOrigin });
}

describe("route mappings", () => {
  it("addresses a project by its own landing screen", () => {
    expect(build({ type: "project", id: PROJECT, projectId: PROJECT }).path).toBe(
      `/servers?project=${PROJECT}`,
    );
  });

  it("addresses a saved server, an environment, and a plugin exactly", () => {
    expect(
      build({ type: "project_server", id: "p170b5c", projectId: PROJECT }).path,
    ).toBe(`/servers/p170b5c?project=${PROJECT}`);
    expect(
      build({ type: "project_environment", id: "env_1", projectId: PROJECT })
        .path,
    ).toBe(`/environments/env_1?project=${PROJECT}`);
    expect(
      build({ type: "project_plugin", id: "plg_1", projectId: PROJECT }).path,
    ).toBe(`/servers/plugins/plg_1?project=${PROJECT}`);
  });

  it("nests an eval case and an eval run under their suite", () => {
    expect(
      build({
        type: "eval_case",
        id: "c_1",
        parent: { type: "eval_suite", id: "s_1" },
        projectId: PROJECT,
      }).path,
    ).toBe(`/evals/suite/s_1/test/c_1?project=${PROJECT}`);
    expect(
      build({
        type: "eval_run",
        id: "run_1",
        parent: { type: "eval_suite", id: "s_1" },
        projectId: PROJECT,
      }).path,
    ).toBe(`/evals/suite/s_1/runs/run_1?project=${PROJECT}`);
  });

  it("sends a grouped launch to the suite's runs lens, not one member run", () => {
    // The non-obvious one: a group has an id of its own but no page of its
    // own, and linking to one member would hide a sibling's failure.
    const permalink = build({
      type: "eval_run_group",
      id: "grp_1",
      parent: { type: "eval_suite", id: "s_1" },
      projectId: PROJECT,
    });
    expect(permalink.path).toBe(
      `/evals/suite/s_1?view=runs&project=${PROJECT}`,
    );
    expect(permalink.resource).toEqual({ type: "eval_run_group", id: "grp_1" });
  });

  it("selects a session and a readiness run by query, not by path", () => {
    expect(
      build({ type: "chat_session", id: "qh7fem", projectId: PROJECT }).path,
    ).toBe(`/sessions?session=qh7fem&project=${PROJECT}`);
    expect(
      build({ type: "readiness_run", id: "rr_1", projectId: PROJECT }).path,
    ).toBe(`/conformance?readinessRun=rr_1&project=${PROJECT}`);
  });

  it("addresses a conformance run, a swarm, a wave and a scenario", () => {
    expect(
      build({ type: "conformance_run", id: "cr_1", projectId: PROJECT }).path,
    ).toBe(`/conformance/runs/cr_1?project=${PROJECT}`);
    expect(build({ type: "swarm", id: "sw_1", projectId: PROJECT }).path).toBe(
      `/swarms/sw_1?project=${PROJECT}`,
    );
    // A wave/journey run takes the FIRST segment after /swarms/ — the client
    // routes on it, so `/swarms/runs/<id>` would dead-link.
    expect(
      build({ type: "journey_run", id: "jr_1", projectId: PROJECT }).path,
    ).toBe(`/swarms/jr_1?project=${PROJECT}`);
    expect(
      build({
        type: "user_testing_scenario",
        id: "sc_1",
        projectId: PROJECT,
      }).path,
    ).toBe(`/user-testing/sc_1?project=${PROJECT}`);
  });

  it("leaves an organization unscoped, since it sits above projects", () => {
    const permalink = build({ type: "organization", id: "org_1" });
    expect(permalink.path).toBe("/organizations/org_1");
    expect(permalink.projectId).toBeUndefined();
  });
});

describe("query merging", () => {
  it("keeps a route's own parameters and adds exactly one project", () => {
    const permalink = build({
      type: "eval_run_group",
      id: "grp_1",
      parent: { type: "eval_suite", id: "s_1" },
      projectId: PROJECT,
    });
    const params = new URL(permalink.url).searchParams;
    expect(params.get("view")).toBe("runs");
    expect(params.getAll(PROJECT_DEEP_LINK_PARAM)).toEqual([PROJECT]);
    // One `?`, no orphaned second query string.
    expect(permalink.url.split("?")).toHaveLength(2);
  });

  it("coexists with readinessRun, session, tab and sel selectors", () => {
    for (const [type, key] of [
      ["readiness_run", "readinessRun"],
      ["chat_session", "session"],
    ] as const) {
      const params = new URL(build({ type, id: "x", projectId: PROJECT }).url)
        .searchParams;
      expect(params.get(key)).toBe("x");
      expect(params.get(PROJECT_DEEP_LINK_PARAM)).toBe(PROJECT);
      expect([...params.keys()].sort()).toEqual([key, "project"].sort());
    }
  });
});

describe("encoding and origin validation", () => {
  it("percent-encodes path segments rather than splicing them in", () => {
    const permalink = build({
      type: "project_server",
      id: "a/b?c#d",
      projectId: PROJECT,
    });
    expect(permalink.path).toBe(
      `/servers/a%2Fb%3Fc%23d?project=${PROJECT}`,
    );
    expect(new URL(permalink.url).pathname).toBe("/servers/a%2Fb%3Fc%23d");
  });

  it("encodes a project id carrying query metacharacters", () => {
    const permalink = build({
      type: "project",
      id: "p&x=1",
      projectId: "p&x=1",
    });
    expect(new URL(permalink.url).searchParams.get("project")).toBe("p&x=1");
  });

  it("accepts a custom staging origin, port and all", () => {
    const permalink = build(
      { type: "project_server", id: "s1", projectId: PROJECT },
      "http://localhost:3001",
    );
    expect(permalink.url).toBe(
      `http://localhost:3001/servers/s1?project=${PROJECT}`,
    );
  });

  it("rejects credentials, path prefixes and non-http schemes", () => {
    const resource: PlatformResourceRef = {
      type: "project",
      id: PROJECT,
      projectId: PROJECT,
    };
    for (const origin of [
      "https://user:pass@app.mcpjam.com",
      "https://app.mcpjam.com/app",
      "ftp://app.mcpjam.com",
      "app.mcpjam.com",
      "https://app.mcpjam.com/?a=1",
    ]) {
      expect(() => build(resource, origin), origin).toThrow(
        PlatformPermalinkError,
      );
    }
  });
});

describe("required scope and parents", () => {
  it("refuses to mint a project-scoped link with no project", () => {
    expect(() => build({ type: "project_server", id: "s1" })).toThrow(
      /needs a project id/,
    );
  });

  it("refuses an eval case with no suite, and one nested under the wrong type", () => {
    expect(() =>
      build({ type: "eval_case", id: "c_1", projectId: PROJECT }),
    ).toThrow(/needs its eval_suite parent/);
    expect(() =>
      build({
        type: "eval_case",
        id: "c_1",
        parent: { type: "swarm", id: "sw_1" },
        projectId: PROJECT,
      }),
    ).toThrow(/nests under eval_suite, not swarm/);
  });

  it("refuses an empty id", () => {
    expect(() =>
      build({ type: "project_server", id: "  ", projectId: PROJECT }),
    ).toThrow(/non-empty id/);
  });
});

describe("the resolved-scope receipt", () => {
  it("fills a ref's project from the receipt, and never overrides its own", () => {
    const permalinks = buildAppPermalinks(
      [
        { type: "project_server", id: "s1" },
        { type: "project", id: "other", projectId: "other" },
      ],
      { appOrigin: ORIGIN, resolvedScope: { projectId: PROJECT } },
    );
    expect(permalinks[0]!.projectId).toBe(PROJECT);
    expect(permalinks[1]!.projectId).toBe("other");
  });
});

describe("the route registry is the type list", () => {
  it("every declared resource type has exactly one route", () => {
    const types = Object.keys(PLATFORM_PERMALINK_ROUTES);
    expect(new Set(types).size).toBe(types.length);
    for (const type of types) {
      expect(isPlatformResourceType(type)).toBe(true);
    }
    expect(isPlatformResourceType("not_a_resource")).toBe(false);
  });

  it("every project-scoped route mints exactly one project parameter", () => {
    for (const type of Object.keys(
      PLATFORM_PERMALINK_ROUTES,
    ) as PlatformResourceType[]) {
      const route = PLATFORM_PERMALINK_ROUTES[type] as {
        parent?: string;
        projectScoped?: boolean;
      };
      const permalink = build({
        type,
        id: "id-1",
        ...(route.parent
          ? { parent: { type: route.parent as PlatformResourceType, id: "p-1" } }
          : {}),
        projectId: PROJECT,
      });
      const params = new URL(permalink.url).searchParams;
      expect(params.getAll("project"), type).toEqual(
        route.projectScoped === false ? [] : [PROJECT],
      );
      expect(permalink.label.length, type).toBeGreaterThan(0);
    }
  });
});

describe("policy application", () => {
  const operation = {
    name: "list_project_servers",
    permalink: {
      kind: "derive" as const,
      resources: (result: { items: Array<{ id: string }> }) =>
        result.items.map((item) => ({
          type: "project_server" as const,
          id: item.id,
        })),
    },
    async execute(
      _input: Record<string, never>,
      context: {
        onScopeResolved?: (scope: { projectId: string }) => void;
      },
    ) {
      context.onScopeResolved?.({ projectId: PROJECT });
      return { items: [{ id: "s1" }, { id: "s2" }] };
    },
  };

  it("derives one permalink per row, scoped by the receipt", async () => {
    const { result, permalinks } = await runOperationWithPermalinks(
      operation,
      {},
      {},
      { appOrigin: ORIGIN },
    );
    expect(result.items).toHaveLength(2);
    expect(permalinks.map((p) => p.url)).toEqual([
      `${ORIGIN}/servers/s1?project=${PROJECT}`,
      `${ORIGIN}/servers/s2?project=${PROJECT}`,
    ]);
    expect(permalinks[0]!.resource).toEqual({
      type: "project_server",
      id: "s1",
    });
  });

  it("still calls a caller's own onScopeResolved", async () => {
    const seen: Array<{ projectId: string }> = [];
    await runOperationWithPermalinks(
      operation,
      {},
      { onScopeResolved: (scope) => seen.push(scope) },
      { appOrigin: ORIGIN },
    );
    expect(seen).toEqual([{ projectId: PROJECT }]);
  });

  it("drops one unaddressable row without dropping its siblings", () => {
    const errors: unknown[] = [];
    const permalinks = derivePermalinksFor(
      {
        name: "mixed",
        permalink: {
          kind: "derive",
          resources: () => [
            { type: "project_server", id: "s1", projectId: PROJECT },
            // No project: cannot be scoped, must not take `s1` down with it.
            { type: "project_server", id: "s2" },
          ],
        },
        execute: async () => ({}),
      },
      {},
      {},
      { appOrigin: ORIGIN },
      (error) => errors.push(error),
    );
    expect(permalinks).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("returns nothing for a `none` policy without calling anything", () => {
    expect(
      derivePermalinksFor(
        {
          name: "cancel_eval_run",
          permalink: noPermalink("mutation-only"),
          execute: async () => ({}),
        },
        {},
        {},
        { appOrigin: ORIGIN },
      ),
    ).toEqual([]);
  });
});

describe("the adapter envelope", () => {
  it("spreads an object result and nests a non-object one", () => {
    const permalinks = [build({ type: "organization", id: "o1" })];
    expect(withPermalinkEnvelope({ id: "x" }, permalinks)).toEqual({
      id: "x",
      permalinks,
    });
    expect(withPermalinkEnvelope([1, 2], permalinks)).toEqual({
      result: [1, 2],
      permalinks,
    });
    expect(withPermalinkEnvelope("done", permalinks)).toEqual({
      result: "done",
      permalinks,
    });
  });

  it("caps the text fallback and says how much it withheld", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      build({ type: "project_server", id: `s${index}`, projectId: PROJECT }),
    );
    const text = formatPermalinkLines(many, { limit: 3 });
    expect(text.split("\n")).toHaveLength(4);
    expect(text).toContain("…and 9 more");
    expect(text.startsWith("Open server: ")).toBe(true);
  });
});

describe("the receipt covers a result that stops carrying its project", () => {
  it("still mints a scoped link when `result.project` is gone", async () => {
    // Not hypothetical: the approval path executes an operation and derives
    // the link from whatever it returned. A policy that read `result.project`
    // and found nothing used to produce no link at all, silently, on the one
    // path where a human is waiting to be told where their approved action
    // went. The receipt is what the operation itself reported.
    const operation = {
      name: "run_eval_suite",
      permalink: {
        kind: "derive" as const,
        resources: (result: { project?: { id: string }; runId: string }) => [
          {
            type: "eval_run" as const,
            id: result.runId,
            parent: { type: "eval_suite" as const, id: "s_1" },
            projectId: result.project?.id,
          },
        ],
      },
      async execute(
        _input: Record<string, never>,
        context: { onScopeResolved?: (scope: { projectId: string }) => void },
      ) {
        context.onScopeResolved?.({ projectId: PROJECT });
        return { runId: "run_1" };
      },
    };

    const { permalinks } = await runOperationWithPermalinks(
      operation,
      {},
      {},
      { appOrigin: ORIGIN },
    );
    expect(permalinks[0]!.url).toBe(
      `${ORIGIN}/evals/suite/s_1/runs/run_1?project=${PROJECT}`,
    );
  });
});
