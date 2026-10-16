import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  grantLocalHarnessConsent,
  hashGrantBinding,
  revokeLocalHarnessGrants,
  verifyLocalHarnessGrant,
  type HarnessGrantBinding,
} from "../grants.js";
import { isLocalStudyGrantBinding } from "../study-grant-binding.js";
import { LOCAL_HARNESS_POLICY_VERSION } from "../targets.js";

const project: HarnessGrantBinding = {
  userId: "participant-a",
  machineId: "machine-a",
  projectId: "project-a",
  workspaceGrantId: "workspace-a",
  harnessId: "claude-code",
  targetKind: "local-native",
  runtimeId: "runtime-a",
  permissionProfile: "workspace-edits",
  policyVersion: LOCAL_HARNESS_POLICY_VERSION,
};
const study: HarnessGrantBinding = {
  ...project,
  study: { scenarioId: "study-a", accessVersion: 1, chatSessionId: "chat-a" },
};
const now = 1_800_000_000_000;
let home: string;
let originalHome: string | undefined;

beforeEach(async () => {
  originalHome = process.env.HOME;
  home = await mkdtemp(join(tmpdir(), "mcpjam-study-grants-"));
  process.env.HOME = home;
});
afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(home, { recursive: true, force: true });
});

describe("study-owned local grants", () => {
  it("preserves the canonical hash of an ordinary project grant", () => {
    const serialized = JSON.stringify([
      "attended",
      "participant-a",
      "machine-a",
      "project-a",
      "workspace-a",
      "claude-code",
      "local-native",
      null,
      "runtime-a",
      "workspace-edits",
      LOCAL_HARNESS_POLICY_VERSION,
    ]);
    expect(hashGrantBinding(project)).toBe(
      createHash("sha256").update(serialized).digest("hex"),
    );
    expect(hashGrantBinding(project)).not.toBe(hashGrantBinding(study));
  });

  it.each(["attended", "unattended"] as const)(
    "persists study ownership independently of %s execution",
    async (scope) => {
      const binding = { ...study, scope };
      const grant = await grantLocalHarnessConsent(binding, { now });
      await expect(
        verifyLocalHarnessGrant(grant.token, binding, { now }),
      ).resolves.toEqual({ ok: true, grantId: grant.grantId });
      const persisted = await readFile(
        join(home, ".mcpjam", "harness-local", "grants.json"),
        "utf8",
      );
      expect(persisted).toContain('"chatSessionId":"chat-a"');
      expect(persisted).not.toContain(grant.token);
    },
  );

  it.each([
    { userId: "participant-b" },
    { machineId: "machine-b" },
    { projectId: "project-b" },
    { workspaceGrantId: "workspace-b" },
    { harnessId: "codex" as const },
    { scope: "unattended" as const },
    {
      study: {
        scenarioId: "study-b",
        accessVersion: 1,
        chatSessionId: "chat-a",
      },
    },
    {
      study: {
        scenarioId: "study-a",
        accessVersion: 2,
        chatSessionId: "chat-a",
      },
    },
    {
      study: {
        scenarioId: "study-a",
        accessVersion: 1,
        chatSessionId: "chat-b",
      },
    },
  ])("refuses substitution %j", async (overrides) => {
    const grant = await grantLocalHarnessConsent(study, { now });
    await expect(
      verifyLocalHarnessGrant(grant.token, { ...study, ...overrides }, { now }),
    ).resolves.toMatchObject({ ok: false, reason: "binding-mismatch" });
  });

  it("never upgrades a project grant or downgrades a study grant", async () => {
    const ordinary = await grantLocalHarnessConsent(project, { now });
    const owned = await grantLocalHarnessConsent(study, { now });
    await expect(
      verifyLocalHarnessGrant(ordinary.token, study, { now }),
    ).resolves.toMatchObject({ ok: false, reason: "binding-mismatch" });
    await expect(
      verifyLocalHarnessGrant(owned.token, project, { now }),
    ).resolves.toMatchObject({ ok: false, reason: "binding-mismatch" });
  });

  it.each([
    null,
    {},
    [],
    { scenarioId: "s", chatSessionId: "c" },
    { scenarioId: " ", accessVersion: 1, chatSessionId: "c" },
    { scenarioId: "s", accessVersion: -1, chatSessionId: "c" },
    { scenarioId: "s", accessVersion: 1.5, chatSessionId: "c" },
    { scenarioId: "s", accessVersion: 1, chatSessionId: "" },
  ])("rejects malformed ownership metadata %j", (value) => {
    expect(isLocalStudyGrantBinding(value)).toBe(false);
  });

  it("refuses malformed ownership before minting and verification", async () => {
    const invalid = {
      ...study,
      study: { scenarioId: "", accessVersion: 1, chatSessionId: "c" },
    };
    expect(() => grantLocalHarnessConsent(invalid, { now })).toThrow(
      "Invalid local study",
    );
    await expect(
      verifyLocalHarnessGrant("a".repeat(32), invalid, { now }),
    ).resolves.toMatchObject({ ok: false, reason: "binding-mismatch" });
  });

  it("fails closed when persisted study metadata is malformed", async () => {
    const grant = await grantLocalHarnessConsent(study, { now });
    const path = join(home, ".mcpjam", "harness-local", "grants.json");
    const persisted = await readFile(path, "utf8");
    await writeFile(
      path,
      persisted.replace('"accessVersion":1', '"accessVersion":null'),
    );
    await expect(
      verifyLocalHarnessGrant(grant.token, study, { now }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid" });
  });

  it("expires and revokes study grants through the existing store", async () => {
    const expiring = await grantLocalHarnessConsent(study, { now, ttlMs: 100 });
    await expect(
      verifyLocalHarnessGrant(expiring.token, study, { now: now + 100 }),
    ).resolves.toMatchObject({ ok: false, reason: "expired" });
    const active = await grantLocalHarnessConsent(study, { now });
    expect(await revokeLocalHarnessGrants({ binding: study })).toBe(2);
    await expect(
      verifyLocalHarnessGrant(active.token, study, { now }),
    ).resolves.toMatchObject({ ok: false, reason: "absent" });
  });
});

it("binds automatic commands to the exact study approval policy", async () => {
  const automatic = { ...study, study: { scenarioId: "study-a", accessVersion: 1, chatSessionId: "chat-a", requireToolApproval: false } };
  const prompted = { ...automatic, study: { ...automatic.study, requireToolApproval: true } };
  const grant = await grantLocalHarnessConsent(automatic, { now });
  expect((await verifyLocalHarnessGrant(grant.token, automatic, { now })).ok).toBe(true);
  expect((await verifyLocalHarnessGrant(grant.token, prompted, { now })).ok).toBe(false);
  expect((await verifyLocalHarnessGrant(grant.token, study, { now })).ok).toBe(false);
  expect(isLocalStudyGrantBinding({ ...automatic.study, requireToolApproval: "false" })).toBe(false);
});
