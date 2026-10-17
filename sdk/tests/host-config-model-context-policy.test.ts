import { describe, expect, it } from "vitest";
import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
  MODEL_CONTEXT_POLICY_CEILINGS,
  MODEL_CONTEXT_POLICY_DEFAULTS,
  resolveModelContextPolicy,
} from "../src/host-config/internal";
import type {
  HostConfigInputV2,
  HostConfigMcpProfileV1,
} from "../src/host-config/internal";
import { seedHostTemplate } from "../src/host-config/templates/index.js";
import {
  bundledHostCompatCatalog,
  getCatalogTemplate,
} from "../src/host-compat/index";

const base = (mcpProfile?: HostConfigMcpProfileV1): HostConfigInputV2 =>
  ({
    hostStyle: "chatgpt",
    modelId: "openai/gpt-5-nano",
    systemPrompt: "",
    temperature: 0.7,
    requireToolApproval: false,
    serverIds: [],
    optionalServerIds: [],
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
    clientCapabilities: {},
    hostContext: {},
    ...(mcpProfile ? { mcpProfile } : {}),
  }) as HostConfigInputV2;

const profile = (modelContextPolicy: unknown): HostConfigMcpProfileV1 =>
  ({
    profileVersion: 1,
    apps: { modelContextPolicy },
  }) as HostConfigMcpProfileV1;

describe("mcpProfile.apps.modelContextPolicy canonicalization", () => {
  it("keeps the budgets, sorts the keys, and changes the hash", async () => {
    const input = base(
      profile({ updateMaxBytes: 2_548_000, maxBlocks: 256, turnMaxBytes: 1 })
    );
    const policy =
      canonicalizeHostConfigV2(input).mcpProfile?.apps?.modelContextPolicy;
    expect(policy).toEqual({
      maxBlocks: 256,
      turnMaxBytes: 1,
      updateMaxBytes: 2_548_000,
    });
    expect(Object.keys(policy ?? {})).toEqual([
      "maxBlocks",
      "turnMaxBytes",
      "updateMaxBytes",
    ]);
    expect(await computeHostConfigHashV2(input)).not.toBe(
      await computeHostConfigHashV2(base())
    );
  });

  it("collapses an empty policy so it hashes like no policy", async () => {
    const input = base(profile({}));
    expect(canonicalizeHostConfigV2(input).mcpProfile).toEqual({
      profileVersion: 1,
    });
    expect(await computeHostConfigHashV2(input)).toBe(
      await computeHostConfigHashV2(base({ profileVersion: 1 }))
    );
  });

  it("accepts every ceiling exactly", () => {
    expect(
      canonicalizeHostConfigV2(base(profile(MODEL_CONTEXT_POLICY_CEILINGS)))
        .mcpProfile?.apps?.modelContextPolicy
    ).toEqual(MODEL_CONTEXT_POLICY_CEILINGS);
  });

  it.each([
    ["an unknown key", { images: "model" }, /unknown key "images"/],
    ["a fraction", { maxBlocks: 1.5 }, /maxBlocks must be a positive integer/],
    ["zero", { turnMaxBytes: 0 }, /turnMaxBytes must be a positive integer/],
    ["a negative", { maxBlocks: -1 }, /maxBlocks must be a positive integer/],
    ["a string", { updateMaxBytes: "1" }, /updateMaxBytes must be a positive/],
    [
      "a value over the ceiling",
      { updateMaxBytes: MODEL_CONTEXT_POLICY_CEILINGS.updateMaxBytes + 1 },
      /updateMaxBytes must be a positive integer no larger than 4194304/,
    ],
    ["an array", [], /modelContextPolicy must be a plain object/],
    ["null", null, /modelContextPolicy must be a plain object/],
  ])("rejects %s", (_, policy, message) => {
    expect(() => canonicalizeHostConfigV2(base(profile(policy)))).toThrow(
      message
    );
  });
});

describe("resolveModelContextPolicy", () => {
  it("resolves a client with no policy to MCPJam's defaults", () => {
    expect(resolveModelContextPolicy(undefined)).toEqual({
      maxBlocks: 64,
      turnMaxBytes: 1024 * 1024,
      updateMaxBytes: 256 * 1024,
    });
    expect(resolveModelContextPolicy(base())).toEqual(
      MODEL_CONTEXT_POLICY_DEFAULTS
    );
  });

  it("gives a ChatGPT client ChatGPT's budgets, from the seed and the bundled catalog alike", () => {
    const chatgpt = {
      maxBlocks: 256,
      turnMaxBytes: 8 * 1024 * 1024,
      updateMaxBytes: 2_548_000,
    };
    expect(resolveModelContextPolicy(seedHostTemplate("chatgpt"))).toEqual(
      chatgpt
    );
    expect(
      resolveModelContextPolicy(
        getCatalogTemplate(bundledHostCompatCatalog(), "chatgpt")
      )
    ).toEqual(chatgpt);
    expect(resolveModelContextPolicy(seedHostTemplate("codex"))).toEqual(
      MODEL_CONTEXT_POLICY_DEFAULTS
    );
  });

  it("takes each saved key and defaults the rest", () => {
    expect(
      resolveModelContextPolicy(base(profile({ updateMaxBytes: 2_548_000 })))
    ).toEqual({ ...MODEL_CONTEXT_POLICY_DEFAULTS, updateMaxBytes: 2_548_000 });
  });

  it("reads malformed stored values as the default, never as unlimited", () => {
    const resolved = resolveModelContextPolicy({
      mcpProfile: {
        apps: {
          modelContextPolicy: {
            updateMaxBytes: Number.MAX_SAFE_INTEGER,
            maxBlocks: "256",
            turnMaxBytes: -1,
          },
        },
      },
    });
    expect(resolved).toEqual(MODEL_CONTEXT_POLICY_DEFAULTS);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it.each([null, "apps", { apps: [] }, { apps: { modelContextPolicy: 7 } }])(
    "tolerates a malformed profile: %j",
    (mcpProfile) => {
      expect(
        resolveModelContextPolicy({
          mcpProfile: mcpProfile as Record<string, unknown> | null,
        })
      ).toEqual(MODEL_CONTEXT_POLICY_DEFAULTS);
    }
  );
});
