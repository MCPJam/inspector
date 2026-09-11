import { expect, it, vi, afterEach } from "vitest";
import { generateTestCases, type GeneratedTestCase } from "../eval-agent";
import {
  filterReadOnlyGeneratedCases,
  readOnlyGenerationSnapshot,
} from "../eval-generation-coverage";
import type { ServerToolSnapshot } from "../../utils/export-helpers";

const snapshot: ServerToolSnapshot = {
  version: 2,
  capturedAt: 0,
  servers: [
    {
      serverId: "s",
      tools: [
        { name: "list", annotations: { readOnlyHint: true } },
        { name: "create", annotations: { readOnlyHint: false } },
        { name: "unknown" },
      ],
    },
  ],
};
const testCase: GeneratedTestCase = {
  title: "List records",
  query: "List records",
  runs: 1,
  expectedToolCalls: [{ toolName: "list", arguments: {} }],
  scenario: "Browse",
  expectedOutput: "Records are shown",
};
afterEach(() => vi.unstubAllGlobals());
it("filters unknown and write tools while preserving server attachment identities", () => {
  const result = readOnlyGenerationSnapshot(snapshot);
  expect(result.servers[0].serverId).toBe("s");
  expect(result.servers[0].tools.map((tool) => tool.name)).toEqual(["list"]);
  expect(snapshot.servers[0].tools).toHaveLength(3);
});
it("rejects a scope with no declared read tools", () => {
  expect(() =>
    readOnlyGenerationSnapshot({
      ...snapshot,
      servers: [{ serverId: "s", tools: [{ name: "unknown" }] }],
    }),
  ).toThrow(/No tools are marked read-only/);
});
it("filters write prerequisites in later turns before assertions are reduced", () => {
  const write = {
    ...testCase,
    promptTurns: [
      {
        id: "follow-up",
        prompt: "Create a record",
        expectedToolCalls: [{ toolName: "create", arguments: {} }],
      },
    ],
  };
  expect(
    filterReadOnlyGeneratedCases(
      [testCase, write],
      readOnlyGenerationSnapshot(snapshot),
    ),
  ).toEqual([testCase]);
  expect(() =>
    filterReadOnlyGeneratedCases([write], readOnlyGenerationSnapshot(snapshot)),
  ).toThrow(/No read-only cases/);
});
it("sends the selected scope and filtered snapshot to generation", async () => {
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, tests: [testCase] }),
  }));
  vi.stubGlobal("fetch", fetch);
  await generateTestCases(
    snapshot,
    "https://example.test",
    "token",
    undefined,
    undefined,
    { toolCoverage: "read-only", testSet: "quick" },
  );
  const body = JSON.parse(
    (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
  );
  expect(body.toolCoverage).toBe("read-only");
  expect(body.testSet).toBe("quick");
  expect(body.toolSnapshot.servers[0].tools).toHaveLength(1);
});
it("keeps all tools for read/write generation", async () => {
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, tests: [testCase] }),
  }));
  vi.stubGlobal("fetch", fetch);
  await generateTestCases(
    snapshot,
    "https://example.test",
    "token",
    undefined,
    undefined,
    { toolCoverage: "read-write" },
  );
  const body = JSON.parse(
    (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
  );
  expect(body.toolCoverage).toBe("read-write");
  expect(body.toolSnapshot.servers[0].tools).toHaveLength(3);
});
