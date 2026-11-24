import { describe, expect, it, vi } from "vitest";
import type { PlatformApiClient } from "../../src/platform/client.js";
import { replacementsBody, serverReplacementsInput } from "../../src/platform/run-replacements.js";
import { runEvalSuiteOperation } from "../../src/platform/index.js";

const PROJECT = { id: "project-1", name: "Acme" } as never;
const SERVERS = [
  { id: "s_mock", name: "Echo (mock)" },
  { id: "s_real", name: "Echo" },
];
const client = {
  listProjectServers: vi.fn(async () => ({ items: SERVERS })),
} as unknown as PlatformApiClient;

describe("run_eval_suite serverReplacements", () => {
  it("sends the replacement's id, the name to replace and the optional fields as given", async () => {
    const body = await replacementsBody(
      client,
      PROJECT,
      [{ server: "Echo", replacement: "Echo (mock)", version: "3", realListingHash: "abc" }],
      undefined
    );
    expect(body).toEqual({
      serverReplacements: [
        { serverName: "Echo", replacementServerId: "s_mock", replacementVersion: "3", realListingHash: "abc" },
      ],
    });
  });

  it("leaves the version and hash out when the caller gave none, so the platform fills the hash", async () => {
    const body = await replacementsBody(client, PROJECT, [{ server: "Echo", replacement: "s_mock" }], undefined);
    expect(body).toEqual({ serverReplacements: [{ serverName: "Echo", replacementServerId: "s_mock" }] });
  });

  it("names the saved server it could not find", async () => {
    await expect(
      replacementsBody(client, PROJECT, [{ server: "Echo", replacement: "Nope" }], undefined)
    ).rejects.toThrow(/Nope/);
  });

  it("adds nothing when there are no replacements", async () => {
    expect(await replacementsBody(client, PROJECT, undefined, undefined)).toEqual({});
  });

  it("takes between one and five replacements, and is optional on the operation", () => {
    expect(serverReplacementsInput.safeParse([]).success).toBe(false);
    expect(serverReplacementsInput.safeParse(undefined).success).toBe(true);
    const shape = (runEvalSuiteOperation.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toContain("serverReplacements");
  });
});
