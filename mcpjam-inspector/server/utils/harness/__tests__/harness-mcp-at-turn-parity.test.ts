/**
 * The harness MCP receipt rules, against the fixture both hand-mirrored readers
 * run. The backend copy of this file is pinned in its `mirrors.json`, so a rule
 * changed on one side alone fails there.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHarnessMcpAtTurn } from "@mcpjam/sdk/host-config/internal";

const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures/harness-mcp-at-turn-parity-fixtures.json"),
    "utf8",
  ),
) as {
  accept: Array<{ label: string; value: unknown; expect: unknown }>;
  reject: Array<{ label: string; value: unknown }>;
};

describe("harness MCP receipt parity", () => {
  it.each(fixtures.accept)("keeps $label", ({ value, expect: stored }) => {
    expect(parseHarnessMcpAtTurn(value)).toEqual(stored);
  });

  it.each(fixtures.reject)("drops $label", ({ value }) => {
    expect(parseHarnessMcpAtTurn(value)).toBeUndefined();
  });

  it("covers every route and both refusal kinds", () => {
    const labels = fixtures.accept.map((row) => row.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "host-tools-client-with-digest",
        "native-proxy-generic",
        "forwarded-native",
        "forwarded-bridge-client",
        "exactly-at-the-caps",
        "unknown-keys-are-dropped",
      ]),
    );
    expect(fixtures.reject.length).toBeGreaterThan(30);
  });
});
