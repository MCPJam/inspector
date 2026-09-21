import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";

/**
 * The published harness ids must match what the routes actually accept.
 *
 * Two sites, one failure mode. `PATCH /clients/{id}` validates its body with
 * `z.enum(HARNESS_IDS)`, and `GET /harness/{harnessId}/builtin-tools` resolves
 * its path segment through `getHarnessAdapter` — but
 * `docs/reference/openapi.json` is HAND-AUTHORED, and no other guard covers
 * either one. `openapi-drift` compares paths and methods, and checks path
 * parameters by `name`/`in` only, never their `enum`; `openapi-types-parity`
 * compares enum values but only for schemas paired with an SDK interface —
 * `ClientFieldSet` has none, and a path parameter is not a schema at all.
 *
 * That gap is how `cursor` shipped accepted-but-undocumented on the client
 * field, and how both `codex` and `cursor` shipped that way on the path
 * parameter. Whichever direction the two drift, someone is misled — a client
 * that trusts the spec refuses a value the API accepts, and a generated client
 * refuses to send it at all.
 */

/** OpenAPI verbs. Anything else under a path item is not an operation. */
const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

type SpecParameter = {
  $ref?: string;
  name?: string;
  in?: string;
  schema?: { enum?: unknown[] };
};

/** Item-level `parameters`, plus the operations that may declare their own. */
type Operation = { parameters?: SpecParameter[] };
type PathItem = Operation & Partial<Record<HttpMethod, Operation>>;

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(
  readFileSync(
    resolve(here, "../../../../../docs/reference/openapi.json"),
    "utf8",
  ),
) as {
  paths: Record<string, PathItem>;
  components: {
    parameters?: Record<string, SpecParameter>;
    schemas: Record<
      string,
      { properties?: Record<string, { enum?: unknown[] }> }
    >;
  };
};

describe("openapi.json ClientFieldSet.harness ↔ HARNESS_IDS", () => {
  const harness = spec.components.schemas.ClientFieldSet?.properties?.harness;

  it("documents the field at all", () => {
    // Guard the guard: a renamed schema or property would make every
    // assertion below vacuous.
    expect(
      harness,
      "ClientFieldSet.harness is missing from the spec",
    ).toBeDefined();
    expect(Array.isArray(harness?.enum)).toBe(true);
  });

  it("lists exactly the harness ids the route accepts, plus null", () => {
    // `null` is the documented clear-this-field sentinel, so it belongs in the
    // enum and nowhere in HARNESS_IDS.
    const documented = (harness?.enum ?? []).filter((v) => v !== null);
    expect(new Set(documented)).toEqual(new Set(HARNESS_IDS));
    expect(harness?.enum).toContain(null);
  });

  it("keeps cursor in the contract", () => {
    // Named explicitly rather than left to the set comparison: this is the
    // value the gap was found on, and a future edit that drops it should say
    // so in the failure.
    expect(harness?.enum).toContain("cursor");
  });
});

/** Resolve a local `#/components/parameters/*` ref; inline params pass through. */
function resolveParameter(param: SpecParameter): SpecParameter {
  if (!param.$ref) return param;
  const name = param.$ref.split("/").pop() ?? "";
  return spec.components.parameters?.[name] ?? param;
}

/**
 * Every `harnessId` path parameter the spec documents, paired with its route.
 *
 * DERIVED, not hardcoded: a second harness route added later is picked up with
 * no edit here, which is the whole point — `/harness/{harnessId}/builtin-tools`
 * was the only one when this was written, and it was already stale. Refs are
 * resolved because every other path parameter in this spec (`projectId`,
 * `serverId`, `runId`, …) is a `#/components/parameters/*` ref, so `harnessId`
 * being inline today is a coincidence this must not depend on.
 */
const harnessIdParameters = Object.entries(spec.paths).flatMap(
  ([route, item]) =>
    [
      ...(item.parameters ?? []),
      ...HTTP_METHODS.flatMap((method) => item[method]?.parameters ?? []),
    ]
      .map(resolveParameter)
      .filter((param) => param.in === "path" && param.name === "harnessId")
      .map((param) => [route, param] as const),
);

describe("openapi.json harnessId path parameters ↔ HARNESS_IDS", () => {
  it("finds a harnessId path parameter to check", () => {
    // Guard the guard: both assertions below iterate this list, so a
    // derivation that quietly matched nothing would pass them by doing
    // nothing at all.
    expect(
      harnessIdParameters.length,
      "no harnessId path parameter found in openapi.json — either the routes " +
        "are gone or this derivation stopped seeing them",
    ).toBeGreaterThan(0);
  });

  it("lists exactly the harness ids the routes accept", () => {
    // These routes resolve the segment through `getHarnessAdapter`, which
    // accepts every key of HARNESS_ADAPTERS — a set that
    // server/utils/harness/__tests__/registry.test.ts pins to HARNESS_IDS. So
    // every registered harness is a valid segment on every one of them.
    for (const [route, param] of harnessIdParameters) {
      expect(
        new Set(param.schema?.enum ?? []),
        `${route}: the documented harnessId enum has drifted from HARNESS_IDS`,
      ).toEqual(new Set(HARNESS_IDS));
    }
  });

  it("keeps codex in the contract", () => {
    // Named explicitly for the same reason `cursor` is above: `codex` is a
    // value this site documented as invalid while the route served it, and a
    // future edit that drops it should say so in the failure.
    for (const [route, param] of harnessIdParameters) {
      expect(
        param.schema?.enum,
        `${route} dropped codex from its harnessId enum`,
      ).toContain("codex");
    }
  });
});
