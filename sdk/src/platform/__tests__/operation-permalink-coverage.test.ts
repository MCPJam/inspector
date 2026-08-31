/**
 * Every catalog operation states a permalink policy, and every "not
 * addressable yet" answer is tracked debt rather than a shrug.
 *
 * The compile-time half of this invariant is `PlatformOperation.permalink`
 * being required — an operation cannot be declared without one. This file is
 * the half a type cannot express: that the reasons are HONEST. A required
 * field with a permissive catch-all value is satisfied by
 * `noPermalink("route-not-addressable")` on everything, which would leave the
 * catalog exactly where it started while reporting full coverage.
 */
import { describe, expect, it } from "vitest";
import { ALL_OPERATIONS } from "../operations.js";
import {
  PLATFORM_PERMALINK_ROUTES,
  derivePermalinksFor,
  type PlatformNoPermalinkReason,
} from "../permalinks.js";

/**
 * Operations whose resource is durable and real but has no exact app route
 * yet. Each entry names the route that is owed.
 *
 * This list may SHRINK freely. Growing it is the reviewable event: a new
 * entry says a resource shipped with no way to link to it, and the note has
 * to say which route would fix that.
 */
const ROUTE_DEBT_ALLOWLIST: Readonly<Record<string, string>> = {
  // Sandbox images: selected inside /computer as component state.
  list_sandbox_images: "computer/images/:imageId",
  get_sandbox_image: "computer/images/:imageId",
  create_sandbox_image: "computer/images/:imageId",
  update_sandbox_image: "computer/images/:imageId",
  build_sandbox_image: "computer/images/:imageId",
  promote_sandbox_image: "computer/images/:imageId",
  // Journeys and personas: edited inside the Swarms surface as component state.
  list_journeys: "swarms/journeys/:journeyId",
  get_journey: "swarms/journeys/:journeyId",
  create_journey: "swarms/journeys/:journeyId",
  update_journey: "swarms/journeys/:journeyId",
  generate_journeys: "swarms/journeys/:journeyId",
  list_personas: "swarms/personas/:personaId",
  // Readiness runs: the /conformance section rediscovers the LATEST run for a
  // server, so no query parameter or segment can address a specific one.
  start_claude_readiness_run: "conformance/readiness/:runId",
  start_openai_readiness_run: "conformance/readiness/:runId",
  get_readiness_run: "conformance/readiness/:runId",
  list_readiness_runs: "conformance/readiness/:runId",
  get_readiness_report: "conformance/readiness/:runId",
  // Saved swarm DEFINITIONS: `/swarms/:swarmId` addresses a launched wave, so
  // a definition's id on that route renders an empty run detail.
  list_swarms: "swarms/definitions/:swarmId",
  get_swarm: "swarms/definitions/:swarmId",
  create_swarm: "swarms/definitions/:swarmId",
  update_swarm: "swarms/definitions/:swarmId",
  // Cloud Skills: the /skills surface selects a skill as component state.
  list_project_skills: "skills/:skillId",
  get_project_skill: "skills/:skillId",
  get_persona: "swarms/personas/:personaId",
  create_persona: "swarms/personas/:personaId",
  update_persona: "swarms/personas/:personaId",
  generate_personas: "swarms/personas/:personaId",
};

const VALID_REASONS: ReadonlySet<PlatformNoPermalinkReason> = new Set([
  "no-addressable-resource",
  "mutation-only",
  "external-resource",
  "route-not-addressable",
]);

describe("every catalog operation declares a permalink policy", () => {
  it("declares one of the three kinds, with a callable body", () => {
    for (const operation of ALL_OPERATIONS) {
      const policy = operation.permalink;
      expect(policy, operation.name).toBeDefined();
      if (policy.kind === "derive") {
        expect(typeof policy.resources, operation.name).toBe("function");
      } else if (policy.kind === "response") {
        expect(typeof policy.permalinks, operation.name).toBe("function");
      } else {
        expect(policy.kind, operation.name).toBe("none");
        expect(VALID_REASONS.has(policy.reason), operation.name).toBe(true);
      }
    }
  });

  it("keeps route debt on the named allowlist, with the missing route in the note", () => {
    const declared = ALL_OPERATIONS.filter(
      (operation) =>
        operation.permalink.kind === "none" &&
        operation.permalink.reason === "route-not-addressable"
    );
    expect(declared.map((operation) => operation.name).sort()).toEqual(
      Object.keys(ROUTE_DEBT_ALLOWLIST).sort()
    );
    for (const operation of declared) {
      const policy = operation.permalink as {
        kind: "none";
        note?: string;
      };
      // A typed reason with no note is the shrug this reason exists to
      // prevent: it says "not addressable" without saying what would fix it.
      expect(policy.note, operation.name).toBeTruthy();
      expect(policy.note, operation.name).toContain(
        ROUTE_DEBT_ALLOWLIST[operation.name]
      );
    }
  });

  it("explains every other `none`, so the reason can be argued with", () => {
    for (const operation of ALL_OPERATIONS) {
      const policy = operation.permalink;
      if (policy.kind !== "none") continue;
      if (policy.reason === "mutation-only") continue; // Self-explanatory.
      expect(policy.note, `${operation.name} (${policy.reason})`).toBeTruthy();
    }
  });

  it("covers the resources humans act on with a real policy", () => {
    // Named explicitly rather than left to a count: these are the operations
    // the reproduction was about, and a refactor that quietly downgraded one
    // to `none` would otherwise still pass every check above.
    const mustDerive = [
      "list_projects",
      "list_project_servers",
      "create_project_server",
      "list_project_environments",
      "list_project_plugins",
      "create_eval_suite",
      "get_eval_suite",
      "list_eval_suites",
      "list_eval_suite_runs",
      "run_eval_suite",
      "run_eval_case",
      "get_eval_run",
      "create_eval_case",
      "create_eval_cases",
      "generate_eval_cases",
      "create_project",
      "create_persona",
      "launch_journey_run",
      "start_conformance_run",
      "get_conformance_run",
      "start_claude_readiness_run",
      "start_openai_readiness_run",
      "list_chat_sessions",
      "get_chat_session",
      "publish_scenario",
    ];
    const byName = new Map(ALL_OPERATIONS.map((op) => [op.name, op]));
    for (const name of mustDerive) {
      const operation = byName.get(name);
      expect(operation, `${name} is missing from the catalog`).toBeDefined();
      // `create_persona` is the deliberate exception: personas are real and
      // durable but have no route, so it is allowed to be route debt.
      const allowed =
        ROUTE_DEBT_ALLOWLIST[name] !== undefined
          ? ["derive", "none"]
          : ["derive"];
      expect(allowed, name).toContain(operation!.permalink.kind);
    }
  });

  it("uses the backend's own permalinks where the backend owns them", () => {
    const byName = new Map(ALL_OPERATIONS.map((op) => [op.name, op]));
    expect(byName.get("search_sessions")!.permalink.kind).toBe("response");
  });

  it("links a CONTINUED chat session, which resolves no scope of its own", () => {
    // `send_chat_message` deliberately skips `resolveProjectOrThrow` when
    // continuing an existing session, so there is no scope receipt and the
    // context carries none. If the policy leaned on the receipt, every
    // successful continuation would silently drop the session link — silently
    // because an unbuildable permalink is reported and skipped, not thrown.
    const byName = new Map(ALL_OPERATIONS.map((op) => [op.name, op]));
    const operation = byName.get("send_chat_message")!;
    const errors: unknown[] = [];
    const permalinks = derivePermalinksFor(
      operation as never,
      {
        sessionId: "cs_1",
        turnId: "t_1",
        projectId: "p1",
        persisted: { outcome: "ok" },
        origin: "api",
      } as never,
      { message: "hi", sessionId: "cs_1" } as never,
      { appOrigin: "https://app.mcpjam.com" },
      (error) => errors.push(error)
    );
    expect(errors).toEqual([]);
    expect(permalinks.map((permalink) => permalink.url)).toEqual([
      "https://app.mcpjam.com/sessions?session=cs_1&project=p1",
    ]);
  });

  it("names no route that the registry does not have", () => {
    const routes = new Set(Object.keys(PLATFORM_PERMALINK_ROUTES));
    // Cheap structural guard on the debt list: a debt entry naming a resource
    // type the registry HAS is a mistake — the route exists, so the operation
    // should be deriving instead.
    for (const missingRoute of Object.values(ROUTE_DEBT_ALLOWLIST)) {
      expect(routes.has(missingRoute)).toBe(false);
    }
  });
});
