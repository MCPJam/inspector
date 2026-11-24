import { describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  applyServerReplacements,
  resolveMockPins,
  resolveReplacementLaunch,
  serverReplacementSchema,
  withServersReplacedByName,
  type ServerReplacement,
} from "../replacement.js";
import type { ResolvedEnvironmentForLaunch } from "../../environments/resolve.js";

function environment(servers: Array<{ serverId: string; name: string }>): ResolvedEnvironmentForLaunch {
  return {
    environmentRef: { environmentId: "env1", name: "Claude Code", revision: 4 },
    hostId: "host1",
    selectedServerIds: servers.map((server) => server.serverId),
    servers,
  };
}

const ENV = environment([
  { serverId: "s_real", name: "Echo" },
  { serverId: "s_other", name: "Docs" },
]);

describe("applyServerReplacements", () => {
  it("swaps the named server for the replacement and keeps the real name", async () => {
    const hashFor = vi.fn(async () => "hash-of-real");
    const applied = await applyServerReplacements(
      ENV,
      [{ serverName: "echo", replacementServerId: "s_mock", replacementVersion: "2" }],
      hashFor,
    );
    expect(applied.environment.servers).toEqual([
      { serverId: "s_mock", name: "Echo" },
      { serverId: "s_other", name: "Docs" },
    ]);
    expect(applied.replaced).toEqual([{ serverName: "Echo", realServerId: "s_real" }]);
    expect(applied.replacements[0]).toMatchObject({ replacementServerId: "s_mock", realListingHash: "hash-of-real" });
    expect(hashFor).toHaveBeenCalledWith("s_real");
    // The stored set the backend compares is untouched.
    expect(applied.environment.selectedServerIds).toEqual(["s_real", "s_other"]);
    expect(ENV.servers?.[0]?.serverId).toBe("s_real");
  });

  it("uses the caller's hash and reads nothing", async () => {
    const hashFor = vi.fn(async () => "unused");
    const applied = await applyServerReplacements(
      ENV,
      [{ serverName: "Echo", replacementServerId: "s_mock", realListingHash: "given" }],
      hashFor,
    );
    expect(applied.replacements[0]!.realListingHash).toBe("given");
    expect(hashFor).not.toHaveBeenCalled();
  });

  it("refuses a name the environment does not have, naming it", async () => {
    await expect(
      applyServerReplacements(ENV, [{ serverName: "Nope", replacementServerId: "s_mock" }], async () => "h"),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('"Nope"'),
      details: { reason: "REPLACEMENT_SERVER_NOT_IN_ENVIRONMENT" },
    });
  });

  it("refuses a launch with no environment", async () => {
    await expect(
      applyServerReplacements(undefined, [{ serverName: "Echo", replacementServerId: "s_mock" }], async () => "h"),
    ).rejects.toMatchObject({ details: { reason: "REPLACEMENT_NEEDS_ENVIRONMENT" } });
  });

  it("refuses an environment the backend did not list by name", async () => {
    const bare = { ...ENV, servers: undefined };
    await expect(
      applyServerReplacements(bare, [{ serverName: "Echo", replacementServerId: "s_mock" }], async () => "h"),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("resolveMockPins", () => {
  const replacement = (over: Partial<ServerReplacement> = {}): ServerReplacement => ({
    serverName: "Echo",
    replacementServerId: "s_mock",
    replacementVersion: "3",
    realListingHash: "h",
    ...over,
  });

  it("pins the version and carries the hash the backend stored for it", async () => {
    const query = vi.fn(async () => ({ contentHash: "c3", version: 3 }));
    const pins = await resolveMockPins({ query }, [replacement()]);
    expect(pins).toEqual({
      mockVersions: { s_mock: 3 },
      mockPins: [{ serverId: "s_mock", version: 3, contentHash: "c3" }],
    });
    expect(query).toHaveBeenCalledWith(expect.anything(), { mockId: "s_mock", version: 3 });
  });

  it("opens the head and pins nothing without a version, or for a server that is not a mock", async () => {
    const query = vi.fn(async () => {
      throw new ConvexError({ code: "MOCK_NOT_FOUND", message: "no" });
    });
    expect(await resolveMockPins({ query }, [replacement({ replacementVersion: undefined })])).toEqual({
      mockVersions: {},
      mockPins: [],
    });
    expect(query).not.toHaveBeenCalled();
    expect(await resolveMockPins({ query }, [replacement()])).toEqual({ mockVersions: {}, mockPins: [] });
  });

  it("does not hide a missing version", async () => {
    const query = vi.fn(async () => {
      throw new ConvexError({ code: "MOCK_VERSION_NOT_FOUND", message: "no version 9" });
    });
    await expect(resolveMockPins({ query }, [replacement({ replacementVersion: "9" })])).rejects.toThrow();
  });
});

describe("resolveReplacementLaunch", () => {
  it("returns the rewritten environment's ids and names, and the launch's climb id", async () => {
    const swapped = await resolveReplacementLaunch({ query: vi.fn(async () => ({ contentHash: "c" })) }, ENV, {
      list: [{ serverName: "Echo", replacementServerId: "s_mock", replacementVersion: "1" }],
      climbId: "climb1",
      hashFor: async () => "h",
    });
    expect(swapped.serverIds).toEqual(["s_mock", "s_other"]);
    expect(swapped.serverNames).toEqual(["Echo", "Docs"]);
    expect(swapped.launch).toMatchObject({ climbId: "climb1", mockVersions: { s_mock: 1 } });
  });
});

describe("serverReplacementSchema", () => {
  it("is strict and takes at most the four fields", () => {
    expect(serverReplacementSchema.safeParse({ serverName: "a", replacementServerId: "b", extra: 1 }).success).toBe(false);
    expect(serverReplacementSchema.safeParse({ serverName: "a", replacementServerId: "b" }).success).toBe(true);
  });
});

describe("withServersReplacedByName", () => {
  // prepareEvalRun resolves the environment again for its own venue, which
  // brings the real server back; the round's server must go in again.
  it("puts the round's server back into an environment resolved again", () => {
    const resolvedAgain = environment([
      { serverId: "s_real", name: "Echo" },
      { serverId: "s_other", name: "Docs" },
    ]);
    const swapped = withServersReplacedByName(resolvedAgain, [
      { serverName: " echo ", replacementServerId: "s_mock" },
    ]);
    expect(swapped.servers).toEqual([
      { serverId: "s_mock", name: "Echo" },
      { serverId: "s_other", name: "Docs" },
    ]);
    expect(resolvedAgain.servers?.[0]?.serverId).toBe("s_real");
  });

  it("changes nothing on an environment already swapped", () => {
    const once = withServersReplacedByName(ENV, [{ serverName: "Echo", replacementServerId: "s_mock" }]);
    const twice = withServersReplacedByName(once, [{ serverName: "Echo", replacementServerId: "s_mock" }]);
    expect(twice).toEqual(once);
  });

  it("leaves an environment alone when nothing is replaced", () => {
    expect(withServersReplacedByName(ENV, [])).toBe(ENV);
  });
});
