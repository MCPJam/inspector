import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

/**
 * A LIVE host turn's active plugins on a harness (`live_plus`): the project's
 * standalone skills AND the plugins' skills reach the box, each with its
 * supporting files, in one pass — and a failed project-wide fetch delivers
 * nothing new rather than deleting every standalone skill folder.
 */

const harnessState = vi.hoisted(() => ({
  lastOpts: undefined as Record<string, unknown> | undefined,
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
    writeTextFile: vi.fn(async () => {}),
    writeBinaryFile: vi.fn(async () => {}),
    readTextFile: vi.fn(async () => null),
    run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    constructor(private readonly opts: Record<string, unknown>) {
      harnessState.lastOpts = opts;
    }
    createSession = vi.fn(async () => {
      const onSandboxSession = this.opts.onSandboxSession as
        | ((a: { session: unknown; sessionWorkDir: string }) => Promise<void>)
        | undefined;
      await onSandboxSession?.({
        session: harnessState.session,
        sessionWorkDir: "/home/user",
      });
      return harnessState.session;
    });
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop" };
      })(),
      text: Promise.resolve("done"),
    }));
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../registry.js", () => ({
  buildBrokerDummyAuth: vi.fn(() => ({
    anthropic: {
      apiKey: "",
      authToken: "mcpjam-broker-dummy",
      baseUrl: "https://broker.example",
    },
  })),
  getHarnessAdapter: vi.fn(() => ({
    id: "claude-code",
    displayName: "Claude Code",
    defaultPermissionMode: "allow-all",
    supportsSkills: true,
    skillsBaseDir: "/home/user/.claude/skills",
    skillsWriteOptions: { trailingNewline: true },
    prepareSkills: (skills: Array<{ name: string }>) => ({
      payload: skills,
      delivered: skills,
      skipped: [],
    }),
    mcpDelivery: "host-executed",
    supportsModel: vi.fn(() => true),
    createHarness: vi.fn(() => ({ harnessId: "claude-code" })),
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
}));

vi.mock("../resolve-sandbox.js", () => ({
  resolveHarnessSandbox: vi.fn(async () => ({
    computerId: "computer-1",
    sandboxId: "sandbox-1",
  })),
}));

vi.mock("../e2b-sandbox-provider.js", () => ({
  createE2BHarnessSandboxProvider: vi.fn(() => ({ sandboxId: "sandbox-1" })),
}));

const skillsState = vi.hoisted(() => ({
  fetchRuntimeSkills: vi.fn(),
  fetchRuntimeSkillFiles: vi.fn(),
}));

vi.mock("../runtime-skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-skills.js")>();
  return {
    ...actual,
    fetchRuntimeSkills: skillsState.fetchRuntimeSkills,
    fetchRuntimeSkillFiles: skillsState.fetchRuntimeSkillFiles,
  };
});

const passes = vi.hoisted(() => ({
  reconcileSkillDirs: vi.fn(async () => {}),
  materializeSkillFiles: vi.fn(async (_args: unknown) => ({
    written: 0,
    skipped: 0,
  })),
}));

vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: passes.reconcileSkillDirs,
  appendManagedSkills: vi.fn(async () => {}),
}));

vi.mock("../materialize-skill-files.js", () => ({
  materializeSkillFiles: passes.materializeSkillFiles,
}));

vi.mock("../preseed-adapter-skills.js", () => ({
  handOffLegacySkillDirs: vi.fn(async () => {}),
  preseedAdapterSkills: vi.fn(async () => {}),
}));

vi.mock("../materialize-skill-frontmatter.js", () => ({
  materializeSkillFrontmatter: vi.fn(async () => {}),
}));

vi.mock("../adopt-sandbox-skills.js", () => ({
  shouldAdoptSandboxSkills: vi.fn(() => false),
  adoptSandboxSkills: vi.fn(async () => ({ adopted: [] })),
}));

const sessionState = vi.hoisted(() => ({
  claim: vi.fn(),
}));

vi.mock("../harness-session-state.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../harness-session-state.js")>();
  return {
    ...actual,
    claimHarnessSessionState: sessionState.claim,
    commitHarnessSessionState: vi.fn(async () => true),
    heartbeatHarnessSessionState: vi.fn(async () => "ok"),
    releaseHarnessSessionState: vi.fn(async () => {}),
  };
});

vi.mock("../harness-model-broker.js", () => ({
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  renewHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    proxyBaseUrl: "https://broker.example",
  })),
}));

vi.mock("../mcp-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp-config.js")>();
  return {
    ...actual,
    buildHarnessMcpJson: vi.fn(() => ({ mcpServers: {} })),
    harnessServerInputFromConfig: vi.fn(),
    harnessServerKeyToName: vi.fn((key: string) => key),
  };
});

import { runHarnessTurn } from "../run-harness-turn";
import { resolveEffectiveCapabilities } from "../../../services/environments/effective-capabilities";
import type { LivePluginDelivery } from "../skill-delivery";

const STANDALONE = {
  skillId: "sk_notes",
  name: "notes",
  description: "Take notes",
  content: "standalone body",
  aggregateHash: "agg_notes",
};
const STANDALONE_FILE = {
  skillId: "sk_notes",
  path: "references/style.md",
  size: 4,
  url: "https://signed/style",
};

function plugin(versionId: string, skillName = "keycaps"): LivePluginDelivery {
  const version = {
    pluginId: "pl_bits",
    pluginVersionId: versionId,
    name: "bits",
    bundleHash: `hash_${versionId}`,
  };
  const capabilities = resolveEffectiveCapabilities(
    {
      servers: { effectiveServerIds: [] },
      skills: [
        {
          skillId: "sk_plugin",
          name: skillName,
          description: "Pick a keycap",
          content: "plugin body",
          aggregateHash: "agg_plugin",
          channels: ["plugin"],
          files: [
            {
              path: "references/sizes.md",
              size: 12,
              url: "https://signed/sizes",
            },
          ],
        },
      ],
      pluginVersions: [version],
    },
    {
      serverOrigins: new Map(),
      skillOrigins: new Map([
        ["sk_plugin", { modelRef: `bits/${skillName}`, plugin: version }],
      ]),
      unattributedVersionIds: [],
    },
  );
  return {
    skills: [
      {
        skillId: "sk_plugin",
        name: skillName,
        description: "Pick a keycap",
        content: "plugin body",
        aggregateHash: "agg_plugin",
      },
    ],
    capabilities,
  };
}

function baseOptions(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    } as unknown as ModelMessage,
  ];
  return {
    messages,
    modelId: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    systemPrompt: "You are Claude Code.",
    authHeader: "Bearer test",
    projectId: "project-1",
    mcpClientManager: { getServerConfig: vi.fn() },
    selectedServers: [],
    requireToolApproval: false,
    sourceType: "direct",
    chatSessionId: "chat-1",
    harness: "claude-code",
    ...overrides,
  };
}

function deliveredSkillNames(): string[] {
  const skills = harnessState.lastOpts?.skills as
    Array<{ name: string }> | undefined;
  return (skills ?? []).map((skill) => skill.name);
}

function claimArgs(): { skillsHash?: string; runtimeFingerprint: string } {
  return sessionState.claim.mock.calls.at(-1)![0];
}

beforeEach(() => {
  vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
  harnessState.lastOpts = undefined;
  passes.reconcileSkillDirs.mockClear();
  passes.materializeSkillFiles.mockClear();
  sessionState.claim.mockReset();
  sessionState.claim.mockResolvedValue({
    ok: true,
    leaseId: "lease-1",
    stateVersion: 1,
    state: null,
    fingerprintChanged: false,
  });
  skillsState.fetchRuntimeSkills.mockReset();
  skillsState.fetchRuntimeSkills.mockResolvedValue({
    ok: true,
    skills: [STANDALONE],
  });
  skillsState.fetchRuntimeSkillFiles.mockReset();
  skillsState.fetchRuntimeSkillFiles.mockResolvedValue({
    ok: true,
    files: [STANDALONE_FILE],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runHarnessTurn — a live turn's active plugins (live_plus)", () => {
  it("delivers the standalone and plugin skills, with both sets of files in one pass", async () => {
    await runHarnessTurn(
      baseOptions({ livePlugins: plugin("pv_1") }) as never,
      "none",
    );
    expect(skillsState.fetchRuntimeSkills).toHaveBeenCalledTimes(1);
    expect(deliveredSkillNames()).toEqual(["notes", "keycaps"]);
    expect(passes.reconcileSkillDirs).toHaveBeenCalledTimes(1);
    expect(passes.materializeSkillFiles).toHaveBeenCalledTimes(1);
    const args = passes.materializeSkillFiles.mock.calls[0]![0] as any;
    expect(args.files).toEqual([
      STANDALONE_FILE,
      {
        skillId: "sk_plugin",
        path: "references/sizes.md",
        size: 12,
        url: "https://signed/sizes",
      },
    ]);
    expect([...args.skillNamesById]).toEqual([
      ["sk_notes", "notes"],
      ["sk_plugin", "keycaps"],
    ]);
  });

  it("delivers nothing new and reconciles nothing when the live fetch fails", async () => {
    skillsState.fetchRuntimeSkills.mockResolvedValue({
      ok: false,
      error: "boom",
    });
    await runHarnessTurn(
      baseOptions({ livePlugins: plugin("pv_1") }) as never,
      "none",
    );
    expect(deliveredSkillNames()).toEqual([]);
    expect(passes.reconcileSkillDirs).not.toHaveBeenCalled();
    expect(passes.materializeSkillFiles).not.toHaveBeenCalled();
    // Unknown, so the stored hash stands (no resume churn).
    expect(claimArgs().skillsHash).toBeUndefined();
  });

  it("leaves standalone files alone when only their file list could not be read", async () => {
    skillsState.fetchRuntimeSkillFiles.mockResolvedValue({ ok: false });
    await runHarnessTurn(
      baseOptions({ livePlugins: plugin("pv_1") }) as never,
      "none",
    );
    const args = passes.materializeSkillFiles.mock.calls[0]![0] as any;
    // Only the plugin's folder is in play: the standalone folder is neither
    // written nor pruned.
    expect([...args.skillNamesById]).toEqual([["sk_plugin", "keycaps"]]);
    expect(args.files.map((file: any) => file.skillId)).toEqual(["sk_plugin"]);
  });

  it("drops a plugin skill whose box folder a standalone skill holds", async () => {
    await runHarnessTurn(
      baseOptions({ livePlugins: plugin("pv_1", "notes") }) as never,
      "none",
    );
    expect(deliveredSkillNames()).toEqual(["notes"]);
    const args = passes.materializeSkillFiles.mock.calls[0]![0] as any;
    expect([...args.skillNamesById]).toEqual([["sk_notes", "notes"]]);
    expect(args.files).toEqual([STANDALONE_FILE]);
  });

  it("folds the plugin set into the skills and runtime fingerprints", async () => {
    await runHarnessTurn(baseOptions() as never, "none");
    const plain = claimArgs();
    await runHarnessTurn(
      baseOptions({ livePlugins: plugin("pv_1") }) as never,
      "none",
    );
    const first = claimArgs();
    await runHarnessTurn(
      baseOptions({ livePlugins: plugin("pv_2") }) as never,
      "none",
    );
    const second = claimArgs();
    expect(first.skillsHash).not.toBe(plain.skillsHash);
    // Same skills, different plugin version: still a different hash.
    expect(second.skillsHash).not.toBe(first.skillsHash);
    expect(second.runtimeFingerprint).not.toBe(first.runtimeFingerprint);
  });

  it("keeps a plain live turn exactly as it was", async () => {
    await runHarnessTurn(baseOptions() as never, "none");
    expect(deliveredSkillNames()).toEqual(["notes"]);
    const args = passes.materializeSkillFiles.mock.calls[0]![0] as any;
    expect(args.files).toEqual([STANDALONE_FILE]);
    expect([...args.skillNamesById]).toEqual([["sk_notes", "notes"]]);
  });

  it("keeps an environment turn exactly as it was: its own set, its own files, no live fetch", async () => {
    const set = plugin("pv_1").capabilities;
    await runHarnessTurn(
      baseOptions({
        runtimeSkillsOverride: plugin("pv_1").skills,
        effectiveCapabilities: set,
      }) as never,
      "none",
    );
    expect(skillsState.fetchRuntimeSkills).not.toHaveBeenCalled();
    expect(skillsState.fetchRuntimeSkillFiles).not.toHaveBeenCalled();
    expect(deliveredSkillNames()).toEqual(["keycaps"]);
    const args = passes.materializeSkillFiles.mock.calls[0]![0] as any;
    expect(args.files.map((file: any) => file.skillId)).toEqual(["sk_plugin"]);
  });
});
