import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";

/**
 * The published `harness` enum must match what the route actually accepts.
 *
 * `PATCH /clients/{id}` validates with `z.enum(HARNESS_IDS)`, but
 * `docs/reference/openapi.json` is HAND-AUTHORED, and neither existing guard
 * covers this: `openapi-drift` compares paths and methods only, and
 * `openapi-types-parity` compares enum values but only for schemas paired with
 * an SDK interface — `ClientFieldSet` has none, so it is not looked at.
 *
 * That gap is how `cursor` shipped accepted-but-undocumented: the API took the
 * value while the published contract said it was invalid. Whichever direction
 * the two drift, someone is misled — a client that trusts the spec refuses a
 * value the API accepts, and a generated client refuses to send it at all.
 */
const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(
  readFileSync(
    resolve(here, "../../../../../docs/reference/openapi.json"),
    "utf8",
  ),
) as {
  components: {
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
