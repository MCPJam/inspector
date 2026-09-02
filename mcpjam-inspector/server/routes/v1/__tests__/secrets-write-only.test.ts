/**
 * The one contract the secrets surface cannot be allowed to break: NO ROUTE
 * RETURNS A VALUE.
 *
 * Asserted on the RESPONSE SCHEMAS, not on sample bodies. A sample body only
 * proves what one fixture happened not to contain — it passes just as happily
 * the day someone adds a `value` field that this particular row left empty.
 * The schema is the promise, so the schema is what is checked, in all three
 * places it is written down:
 *
 *   1. the OpenAPI response schemas for every `/secrets` route;
 *   2. the SDK's `PlatformSecret` type, which is what a typed caller sees;
 *   3. the route module's own DTO mapper, read as source.
 *
 * The three are separate on purpose. Any one of them could grow a value field
 * without the other two noticing, and each is the only thing some consumer
 * reads.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const OPENAPI_PATH = join(REPO_ROOT, "docs", "reference", "openapi.json");
const SDK_TYPES_PATH = join(REPO_ROOT, "sdk", "src", "platform", "types.ts");
const ROUTE_PATH = join(import.meta.dirname, "..", "secrets.ts");

type JsonObject = Record<string, unknown>;

const openapi = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as {
  paths: Record<string, JsonObject>;
  components: { schemas: Record<string, JsonObject> };
};

/**
 * Every property name reachable from a schema, following `$ref`, `allOf`,
 * `items` and nested `properties`.
 *
 * Recursive with a visited set rather than a fixed depth: the point is that a
 * value cannot hide anywhere in the tree, and a depth limit would be a hole
 * someone could nest past.
 */
function reachableProperties(
  schema: unknown,
  seen = new Set<string>(),
): string[] {
  if (!schema || typeof schema !== "object") return [];
  const node = schema as JsonObject;

  const ref = node.$ref;
  if (typeof ref === "string") {
    const name = ref.replace("#/components/schemas/", "");
    if (seen.has(name)) return [];
    seen.add(name);
    return reachableProperties(openapi.components.schemas[name], seen);
  }

  const out: string[] = [];
  const props = node.properties;
  if (props && typeof props === "object") {
    for (const [key, child] of Object.entries(props as JsonObject)) {
      out.push(key);
      out.push(...reachableProperties(child, seen));
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const branch = node[key];
    if (Array.isArray(branch)) {
      for (const child of branch) out.push(...reachableProperties(child, seen));
    }
  }
  if (node.items) out.push(...reachableProperties(node.items, seen));
  return out;
}

/** Field names that would mean the surface hands a credential back. */
const FORBIDDEN = ["value", "secretValue", "plaintext", "ciphertext"];

describe("the secrets surface is write-only", () => {
  const secretPaths = Object.keys(openapi.paths).filter((path) =>
    path.includes("/secrets"),
  );

  it("has the routes it is supposed to have", () => {
    // If this ever fails because a route was renamed, the assertions below stop
    // checking anything — so the list is pinned rather than derived.
    expect(secretPaths.sort()).toEqual([
      "/projects/{projectId}/secrets",
      "/projects/{projectId}/secrets/{secretId}",
    ]);
  });

  it("declares no value field in ANY response schema", () => {
    const offenders: string[] = [];
    for (const path of secretPaths) {
      for (const [method, operation] of Object.entries(openapi.paths[path]!)) {
        if (method === "parameters") continue;
        const responses = (operation as JsonObject).responses as
          | JsonObject
          | undefined;
        if (!responses) continue;
        for (const [status, response] of Object.entries(responses)) {
          const content = (response as JsonObject).content as
            | JsonObject
            | undefined;
          const schema = (
            content?.["application/json"] as JsonObject | undefined
          )?.schema;
          if (!schema) continue;
          for (const property of reachableProperties(schema)) {
            if (FORBIDDEN.includes(property)) {
              offenders.push(
                `${method.toUpperCase()} ${path} ${status}: ${property}`,
              );
            }
          }
        }
      }
    }
    expect(
      offenders,
      "A secrets response schema exposes a credential field. There is no code " +
        "path that could produce one — if this fails, the schema is a promise " +
        "the implementation does not keep, which is worse than either.",
    ).toEqual([]);
  });

  it("DOES declare a value on the two write REQUESTS, so the check above is real", () => {
    // Guards the guard. If `reachableProperties` silently returned nothing, the
    // assertion above would pass vacuously forever.
    const create = reachableProperties({
      $ref: "#/components/schemas/SecretCreateRequest",
    });
    const update = reachableProperties({
      $ref: "#/components/schemas/SecretUpdateRequest",
    });
    expect(create).toContain("value");
    expect(update).toContain("value");
  });

  it("keeps the value out of the SDK's PlatformSecret type", () => {
    const source = readFileSync(SDK_TYPES_PATH, "utf8");
    const start = source.indexOf("export interface PlatformSecret {");
    expect(start, "PlatformSecret was renamed or removed").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    for (const forbidden of FORBIDDEN) {
      expect(
        new RegExp(`^\\s*${forbidden}\\??:`, "m").test(body),
        `PlatformSecret declares \`${forbidden}\``,
      ).toBe(false);
    }
  });

  it("keeps the value out of the route's own DTO mapper", () => {
    const source = readFileSync(ROUTE_PATH, "utf8");
    const start = source.indexOf("function toSecretDto(");
    expect(start, "toSecretDto was renamed or removed").toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    for (const forbidden of FORBIDDEN) {
      expect(
        new RegExp(`\\b${forbidden}\\s*:`).test(body),
        `toSecretDto emits \`${forbidden}\``,
      ).toBe(false);
    }
  });

  it("is absent from the guest allowlist, so guests cannot reach it", () => {
    // `guest-allowed-paths.ts` is default-deny, so this is not "no rule denies
    // it" — it is "no rule ADMITS it". A single added entry would be the one
    // change that breaks the guarantee, and this is what would catch it.
    const source = readFileSync(
      join(import.meta.dirname, "..", "guest-allowed-paths.ts"),
      "utf8",
    );
    expect(source).not.toContain("/secrets");
  });
});
