import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

/**
 * The Playground's HIDDEN environment on a harness (`live_plus`): a client
 * turn that runs the project's plugins through an ad-hoc environment keeps the
 * project's skill pool. The pool AND the environment's own skills reach the
 * box, each with its supporting files, in one pass — and a failed project-wide
 * fetch delivers nothing new rather than deleting the pool's skill folders.
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
  reconcileSkillDirs: vi.fn(async (_args: unknown) => {}),
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
import { skillsFingerprint } from "../runtime-skills";
import { logger } from "../../logger";
import { resolveEffectiveCapabilities } from "../../../services/environments/effective-capabilities";
import {
  runtimeSkills,
  type ResolvedEnvironmentRuntime,
} from "../../../services/environments/runtime";

// The project's pool: a member's skill, plus the skill the client selected
// (which the environment therefore also carries, on the host channel).
const NOTES = {
  skillId: "sk_notes",
  name: "notes",
  description: "Take notes",
  content: "notes body",
  aggregateHash: "agg_notes",
};
const RELEASE_NOTES_LIVE = {
  skillId: "sk_host",
  name: "release-notes",
  description: "Write release notes",
  content: "release notes body",
  aggregateHash: "agg_host",
};
const NOTES_FILE = {
  skillId: "sk_notes",
  path: "references/style.md",
  size: 4,
  url: "https://signed/style",
};
const RELEASE_NOTES_PROJECT_FILE = {
  skillId: "sk_host",
  path: "references/template.md",
  size: 8,
  url: "https://signed/project-template",
};

/** The hidden environment: the client's selection plus one plugin. */
function hiddenEnvironment(versionId: string, pluginSkillName = "keycaps") {
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
        name: pluginSkillName,
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
  };
  const capabilities = resolveEffectiveCapabilities(spec, {
    serverOrigins: new Map(),
    skillOrigins: new Map([
      ["sk_plugin", { modelRef: `bits/${pluginSkillName}`, plugin: version }],
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

function hiddenTurn(versionId = "pv_1", pluginSkillName?: string) {
  return baseOptions({
    ...hiddenEnvironment(versionId, pluginSkillName),
    includeProjectSkills: true,
  });
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
  skillsState.fetchRuntimeSkills.mockReset();
  skillsState.fetchRuntimeSkills.mockResolvedValue({
    ok: true,
    skills: [NOTES, RELEASE_NOTES_LIVE],
  });
  skillsState.fetchRuntimeSkillFiles.mockReset();
  skillsState.fetchRuntimeSkillFiles.mockResolvedValue({
    ok: true,
    files: [NOTES_FILE, RELEASE_NOTES_PROJECT_FILE],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("runHarnessTurn — the Playground's hidden environment (live_plus)", () => {
  it("delivers the project's pool and the environment's skills, with files from both sources in one pass", async () => {
    await runHarnessTurn(hiddenTurn() as never, "none");
    expect(skillsState.fetchRuntimeSkills).toHaveBeenCalledTimes(1);
    // The client's selection is delivered once, as the environment's.
    expect(deliveredSkillNames()).toEqual([
      "release-notes",
      "keycaps",
      "notes",
    ]);
    expect(passes.reconcileSkillDirs).toHaveBeenCalledTimes(1);
    expect(passes.materializeSkillFiles).toHaveBeenCalledTimes(1);
    const args = materializeArgs();
    // The pool's files from the project-wide query; the environment's from
    // its capability set (the only source of a plugin skill's), so a skill
    // both carry is written from one source, never twice.
    expect(args.files.map((file) => [file.skillId, file.url])).toEqual([
      ["sk_notes", "https://signed/style"],
      ["sk_plugin", "https://signed/sizes"],
      ["sk_host", "https://signed/env-template"],
    ]);
    expect([...args.skillNamesById]).toEqual([
      ["sk_host", "release-notes"],
      ["sk_plugin", "keycaps"],
      ["sk_notes", "notes"],
    ]);
  });

  it("delivers nothing new and reconciles nothing when the project-wide fetch fails", async () => {
    skillsState.fetchRuntimeSkills.mockResolvedValue({ ok: false });
    await runHarnessTurn(hiddenTurn() as never, "none");
    expect(deliveredSkillNames()).toEqual([]);
    // A reconcile against the environment's skills alone would delete every
    // folder the pool put on the box.
    expect(passes.reconcileSkillDirs).not.toHaveBeenCalled();
    expect(passes.materializeSkillFiles).not.toHaveBeenCalled();
    // Unknown, so the stored hash stands (no resume churn).
    expect(claimArgs().skillsHash).toBeUndefined();
  });

  it("leaves the pool's files alone when only their file list could not be read", async () => {
    skillsState.fetchRuntimeSkillFiles.mockResolvedValue({ ok: false });
    await runHarnessTurn(hiddenTurn() as never, "none");
    const args = materializeArgs();
    // Only the environment's folders are in play: the pool's folder is
    // neither written nor pruned.
    expect([...args.skillNamesById]).toEqual([
      ["sk_host", "release-notes"],
      ["sk_plugin", "keycaps"],
    ]);
    expect(args.files.map((file) => file.skillId)).toEqual([
      "sk_plugin",
      "sk_host",
    ]);
  });

  it("does not read the project's file list when the pool adds nothing", async () => {
    // The pool holds only the skill the client selected, which the
    // environment already delivers with its own files.
    skillsState.fetchRuntimeSkills.mockResolvedValue({
      ok: true,
      skills: [RELEASE_NOTES_LIVE],
    });
    await runHarnessTurn(hiddenTurn() as never, "none");
    expect(skillsState.fetchRuntimeSkillFiles).not.toHaveBeenCalled();
    expect(deliveredSkillNames()).toEqual(["release-notes", "keycaps"]);
    expect(materializeArgs().files.map((file) => file.skillId)).toEqual([
      "sk_plugin",
      "sk_host",
    ]);
  });

  it("keeps the environment's skill when a project skill wants the same box folder, and logs the drop", async () => {
    const warn = vi.spyOn(logger, "warn");
    skillsState.fetchRuntimeSkills.mockResolvedValue({
      ok: true,
      skills: [NOTES, RELEASE_NOTES_LIVE],
    });
    // The plugin's skill is named like the member's own `notes`.
    await runHarnessTurn(hiddenTurn("pv_1", "notes") as never, "none");
    expect(deliveredSkillNames()).toEqual(["release-notes", "notes"]);
    const args = materializeArgs();
    expect([...args.skillNamesById]).toEqual([
      ["sk_host", "release-notes"],
      ["sk_plugin", "notes"],
    ]);
    // The member's `notes` files are not written into the plugin's folder.
    expect(args.files.map((file) => file.skillId)).toEqual([
      "sk_plugin",
      "sk_host",
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[harness] skills left out: box folder taken",
      {
        problems: [{ code: "skill_folder_collision", skillId: "sk_notes" }],
      },
    );
  });

  it("folds the plugin set into the skills fingerprint", async () => {
    await runHarnessTurn(hiddenTurn("pv_1") as never, "none");
    const first = claimArgs();
    await runHarnessTurn(hiddenTurn("pv_2") as never, "none");
    const second = claimArgs();
    // Same skills, different plugin version: a different hash, so the box's
    // skills are re-written.
    expect(second.skillsHash).not.toBe(first.skillsHash);
    expect(second.runtimeFingerprint).not.toBe(first.runtimeFingerprint);
    // And the pool is part of it: the same environment without the pool
    // hashes differently.
    await runHarnessTurn(
      baseOptions(hiddenEnvironment("pv_1")) as never,
      "none",
    );
    expect(claimArgs().skillsHash).not.toBe(first.skillsHash);
  });

  it("keeps a named environment's turn exactly as it was: its own set, its own files, no live fetch", async () => {
    const environment = hiddenEnvironment("pv_1");
    await runHarnessTurn(baseOptions(environment) as never, "none");
    expect(skillsState.fetchRuntimeSkills).not.toHaveBeenCalled();
    expect(skillsState.fetchRuntimeSkillFiles).not.toHaveBeenCalled();
    expect(deliveredSkillNames()).toEqual(["release-notes", "keycaps"]);
    const args = materializeArgs();
    expect(args.files.map((file) => [file.skillId, file.url])).toEqual([
      ["sk_plugin", "https://signed/sizes"],
      ["sk_host", "https://signed/env-template"],
    ]);
    expect([...args.skillNamesById]).toEqual([
      ["sk_host", "release-notes"],
      ["sk_plugin", "keycaps"],
    ]);
    // The plain skills fingerprint, with no plugin suffix.
    expect(claimArgs().skillsHash).toBe(
      skillsFingerprint(environment.runtimeSkillsOverride),
    );
  });

  it("keeps a plain client turn exactly as it was", async () => {
    await runHarnessTurn(baseOptions() as never, "none");
    expect(deliveredSkillNames()).toEqual(["notes", "release-notes"]);
    const args = materializeArgs();
    expect(args.files).toEqual([NOTES_FILE, RELEASE_NOTES_PROJECT_FILE]);
    expect([...args.skillNamesById]).toEqual([
      ["sk_notes", "notes"],
      ["sk_host", "release-notes"],
    ]);
    expect(claimArgs().skillsHash).toBe(
      skillsFingerprint([NOTES, RELEASE_NOTES_LIVE]),
    );
  });
});
