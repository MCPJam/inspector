import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

/**
 * The Playground's HIDDEN environment on a harness: a client's turn runs in
 * its ad-hoc environment, which the backend resolves in the client's skill
 * selection, the caller's own skills included. The box gets exactly the
 * environment's skills, each with its supporting files from the environment,
 * and the harness reads nothing from the project on its own.
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
    skills: HARNESS_SKILLS["claude-code"],
    mcpDelivery: "mcpjam",
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

const passes = vi.hoisted(() => ({
  reconcileSkillDirs: vi.fn(async (_args: unknown) => {}),
  materializeSkillFiles: vi.fn(async (_args: unknown) => ({
    written: 0,
    skipped: 0,
    failed: new Map<string, string>(),
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
  clearAdapterSkills: vi.fn(async () => {}),
  handOffLegacySkillDirs: vi.fn(async () => {}),
  preseedAdapterSkills: vi.fn(async () => {}),
}));

vi.mock("../materialize-skill-frontmatter.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../materialize-skill-frontmatter.js")>()),
  materializeSkillFrontmatter: vi.fn(async () => ({ rewritten: 0, skipped: 0, removed: new Map() })),
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
import { skillsFingerprint } from "../runtime-skills";
import { HARNESS_SKILLS } from "../skills-descriptor";
import { resolveEffectiveCapabilities } from "../../../services/environments/effective-capabilities";
import {
  runtimeSkills,
  type ResolvedEnvironmentRuntime,
} from "../../../services/environments/runtime";

/**
 * The hidden environment: the client's selected skill, one plugin's, and a
 * skill the backend's visible scope added (the member's own `notes`).
 */
function hiddenEnvironment(versionId: string) {
  const version = {
    pluginId: "pl_bits",
    pluginVersionId: versionId,
    name: "bits",
    bundleHash: `hash_${versionId}`,
  };
  const spec: ResolvedEnvironmentRuntime = {
    specVersion: 1,
    environmentRef: {
      environmentId: "env_hidden",
      name: "Hidden",
      revision: 1,
    },
    host: { hostId: "host_1", runtimeConfig: { modelId: "m" } },
    servers: { effectiveServerIds: [] },
    skills: [
      {
        skillId: "sk_host",
        name: "release-notes",
        description: "Write release notes",
        content: "release notes body",
        aggregateHash: "agg_host",
        channels: ["host"],
        files: [
          {
            path: "references/template.md",
            size: 8,
            url: "https://signed/env-template",
          },
        ],
      },
      {
        skillId: "sk_plugin",
        name: "keycaps",
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
      {
        skillId: "sk_notes",
        name: "notes",
        description: "Take notes",
        content: "notes body",
        aggregateHash: "agg_notes",
        channels: ["host"],
        files: [
          {
            path: "references/style.md",
            size: 4,
            url: "https://signed/style",
          },
        ],
      },
    ],
    pluginVersions: [version],
  };
  const capabilities = resolveEffectiveCapabilities(spec, {
    serverOrigins: new Map(),
    skillOrigins: new Map([
      ["sk_plugin", { modelRef: "bits/keycaps", plugin: version }],
    ]),
    unattributedVersionIds: [],
  });
  return {
    runtimeSkillsOverride: runtimeSkills(spec),
    effectiveCapabilities: capabilities,
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

function materializeArgs(): {
  files: Array<{ skillId: string; url: string | null }>;
  skillNamesById: Map<string, string>;
} {
  return passes.materializeSkillFiles.mock.calls.at(-1)![0] as never;
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
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runHarnessTurn — the Playground's hidden environment", () => {
  it("delivers the environment's skills, the client's own included, with files from the environment", async () => {
    const environment = hiddenEnvironment("pv_1");
    await runHarnessTurn(baseOptions(environment) as never, "none");
    expect(deliveredSkillNames()).toEqual([
      "release-notes",
      "keycaps",
      "notes",
    ]);
    expect(passes.reconcileSkillDirs).toHaveBeenCalledTimes(1);
    const args = materializeArgs();
    // Every file comes from the environment's capability set, the only
    // source of a plugin skill's.
    expect(args.files.map((file) => [file.skillId, file.url])).toEqual([
      ["sk_plugin", "https://signed/sizes"],
      ["sk_host", "https://signed/env-template"],
      ["sk_notes", "https://signed/style"],
    ]);
    expect([...args.skillNamesById]).toEqual([
      ["sk_host", "release-notes"],
      ["sk_plugin", "keycaps"],
      ["sk_notes", "notes"],
    ]);
    expect(claimArgs().skillsHash).toBe(
      skillsFingerprint(environment.runtimeSkillsOverride),
    );
  });

  it("forks the session when the plugin version changes, even with the same skills", async () => {
    await runHarnessTurn(
      baseOptions(hiddenEnvironment("pv_1")) as never,
      "none",
    );
    const first = claimArgs();
    await runHarnessTurn(
      baseOptions(hiddenEnvironment("pv_2")) as never,
      "none",
    );
    const second = claimArgs();
    expect(second.skillsHash).toBe(first.skillsHash);
    expect(second.runtimeFingerprint).not.toBe(first.runtimeFingerprint);
  });
});
