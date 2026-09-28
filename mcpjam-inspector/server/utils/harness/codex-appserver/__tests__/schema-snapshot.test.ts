/**
 * The adapter's dependency on the codex protocol, checked against the committed
 * schema snapshot.
 *
 * A codex version bump is the failure this exists for. The adapter dispatches
 * on fifteen or so method names out of ~180; if upstream REMOVES one, nothing
 * in TypeScript notices — the bridge just sends a request that is never
 * answered, inside a sandbox, minutes into a turn. Naming the dependency here
 * turns that into a failed unit test on the day the pin moves.
 *
 * Additions are deliberately NOT failures: the protocol grew by three methods
 * and six notifications between 0.149.1 and 0.152.0 and none of it concerned
 * this adapter.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PINNED_CODEX_VERSION,
  USED_CLIENT_METHODS,
  USED_NOTIFICATIONS,
  USED_SERVER_REQUESTS,
} from "../bridge/app-server-protocol.js";

const SCHEMA_DIR = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  ".spike-codex-appserver",
  "schema",
  PINNED_CODEX_VERSION,
);

function methodsIn(file: string): Set<string> {
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as {
    oneOf?: Array<{ properties?: { method?: { enum?: string[] } } }>;
    anyOf?: Array<{ properties?: { method?: { enum?: string[] } } }>;
  };
  return new Set(
    (schema.oneOf ?? schema.anyOf ?? [])
      .map((variant) => variant.properties?.method?.enum?.[0])
      .filter((method): method is string => typeof method === "string"),
  );
}

describe("codex protocol dependency", () => {
  it("has the pinned snapshot committed", () => {
    // Without it the assertions below would vacuously pass, which is worse than
    // not having them.
    expect(
      existsSync(join(SCHEMA_DIR, "ClientRequest.json")),
      `expected the pinned schema at ${SCHEMA_DIR}. Regenerate with .spike-codex-appserver/schema/regen.sh`,
    ).toBe(true);
  });

  it.each([
    ["client requests", "ClientRequest.json", USED_CLIENT_METHODS],
    ["server requests", "ServerRequest.json", USED_SERVER_REQUESTS],
    ["notifications", "ServerNotification.json", USED_NOTIFICATIONS],
  ] as const)(
    "every %s the bridge uses exists in codex %s",
    (_label, file, used) => {
      const available = methodsIn(file);
      for (const method of used) {
        expect(
          available.has(method),
          `${method} is gone from ${file} at codex ${PINNED_CODEX_VERSION}`,
        ).toBe(true);
      }
    },
  );

  it("does not depend on a method the protocol does not define", () => {
    // Guards the reverse mistake: a typo in the USED_* list would make the
    // assertions above check a name codex never sends.
    const all = new Set([
      ...methodsIn("ClientRequest.json"),
      ...methodsIn("ServerRequest.json"),
      ...methodsIn("ServerNotification.json"),
    ]);
    for (const method of [
      ...USED_CLIENT_METHODS,
      ...USED_SERVER_REQUESTS,
      ...USED_NOTIFICATIONS,
    ]) {
      expect(all.has(method), `${method} is not a codex method`).toBe(true);
    }
  });

  it("pins the same version the bootstrap installs", () => {
    // Two places name the codex version — the protocol types and the
    // bootstrap manifest — and they describe the same binary. Drift between
    // them means the adapter is written against a protocol the box does not
    // run.
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "..", "bootstrap", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@openai/codex"]).toBe(PINNED_CODEX_VERSION);
  });

  it("names the approval requests the transport exists for", () => {
    // If these ever leave the protocol, the app-server transport has lost the
    // capability it was built to provide and the registry arm's
    // `supportsNativeToolApproval: true` becomes a lie.
    const serverRequests = methodsIn("ServerRequest.json");
    expect(serverRequests.has("item/commandExecution/requestApproval")).toBe(
      true,
    );
    expect(serverRequests.has("item/fileChange/requestApproval")).toBe(true);
  });

  it("still has no approval request for an MCP tool call", () => {
    // The reason MCP delivery stays host-executed. If codex ever adds one,
    // native delivery becomes possible for a Strict-mode host and this test is
    // the prompt to revisit that decision.
    const serverRequests = [...methodsIn("ServerRequest.json")];
    expect(
      serverRequests.filter(
        (method) =>
          method.toLowerCase().includes("mcp") &&
          method.toLowerCase().includes("approval"),
      ),
    ).toEqual([]);
  });
});
