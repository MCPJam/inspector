import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveLabeledKey,
  resolveSigningKeyRing,
  signingSecretsStillAcceptingLegacy,
} from "../signing-keys.js";
import {
  mintToolApprovalId,
  resolveToolApprovalKeyRing,
  resolveToolApprovalSigningKey,
  verifyToolApprovalId,
} from "../tool-approval-token.js";
import {
  historyProvenanceContextFor,
  historyVerificationFor,
  resolveHistoryProvenanceKeyRing,
  signAssistantText,
  verifyAssistantText,
} from "../history-provenance.js";

const SERVICE = "service-token-0123456789abcdef";
const OLD_SECRET = "old-dedicated-secret-0123456789";
const NEW_SECRET = "new-dedicated-secret-0123456789";
const LABEL = "mcpjam/test/v1";

describe("resolveSigningKeyRing", () => {
  it("is null with no dedicated secret and no service credential", () => {
    expect(
      resolveSigningKeyRing({ secretEnv: "X", label: LABEL, env: {} }),
    ).toBeNull();
  });

  it("falls back to the legacy service-token key while the secret is unset", () => {
    const ring = resolveSigningKeyRing({
      secretEnv: "X",
      label: LABEL,
      env: { INSPECTOR_SERVICE_TOKEN: SERVICE },
    })!;
    expect(ring.signing.equals(deriveLabeledKey(SERVICE, LABEL)!)).toBe(true);
    expect(ring.accepted).toHaveLength(1);
  });

  it("signs with the dedicated secret and still accepts previous + legacy", () => {
    const ring = resolveSigningKeyRing({
      secretEnv: "X",
      label: LABEL,
      env: {
        X: NEW_SECRET,
        X_PREVIOUS: OLD_SECRET,
        INSPECTOR_SERVICE_TOKEN: SERVICE,
      },
    })!;
    expect(ring.signing.equals(deriveLabeledKey(NEW_SECRET, LABEL)!)).toBe(
      true,
    );
    expect(ring.accepted.map((key) => key.toString("hex"))).toEqual(
      [NEW_SECRET, OLD_SECRET, SERVICE].map((secret) =>
        deriveLabeledKey(secret, LABEL)!.toString("hex"),
      ),
    );
  });

  it("ignores a too-short secret", () => {
    expect(deriveLabeledKey("short", LABEL)).toBeNull();
    const ring = resolveSigningKeyRing({
      secretEnv: "X",
      label: LABEL,
      env: { X: "short", INSPECTOR_SERVICE_TOKEN: SERVICE },
    })!;
    expect(ring.signing.equals(deriveLabeledKey(SERVICE, LABEL)!)).toBe(true);
  });

  it("setting PREVIOUS to the old service token reproduces the legacy key", () => {
    expect(
      deriveLabeledKey(SERVICE, LABEL)!.equals(
        resolveSigningKeyRing({
          secretEnv: "X",
          label: LABEL,
          env: { X: NEW_SECRET, X_PREVIOUS: SERVICE },
        })!.accepted[1]!,
      ),
    ).toBe(true);
  });
});

const call = {
  toolCallId: "call_1",
  toolName: "create_suite",
  input: { a: 1 },
};
const binding = {
  subject: "user_1",
  projectId: "proj_1",
  chatSessionId: "chat_1",
};

describe("retiring the legacy service-token key", () => {
  const legacyKey = () => deriveLabeledKey(SERVICE, LABEL)!;

  it("still accepts the legacy key next to a dedicated secret by default", () => {
    const ring = resolveSigningKeyRing({
      secretEnv: "TEST_SECRET",
      label: LABEL,
      env: { TEST_SECRET: NEW_SECRET, INSPECTOR_SERVICE_TOKEN: SERVICE },
    })!;
    expect(ring.accepted.some((key) => key.equals(legacyKey()))).toBe(true);
  });

  it("drops it under MCPJAM_ACCEPT_LEGACY_SIGNING_KEY=false, so the token cannot forge a signature", () => {
    const ring = resolveSigningKeyRing({
      secretEnv: "TEST_SECRET",
      label: LABEL,
      env: {
        TEST_SECRET: NEW_SECRET,
        INSPECTOR_SERVICE_TOKEN: SERVICE,
        MCPJAM_ACCEPT_LEGACY_SIGNING_KEY: "false",
      },
    })!;
    expect(ring.accepted.some((key) => key.equals(legacyKey()))).toBe(false);
    expect(ring.signing.equals(deriveLabeledKey(NEW_SECRET, LABEL)!)).toBe(
      true,
    );
  });

  it("keeps PREVIOUS (e.g. the old token value) accepted when the legacy key is dropped", () => {
    const ring = resolveSigningKeyRing({
      secretEnv: "TEST_SECRET",
      label: LABEL,
      env: {
        TEST_SECRET: NEW_SECRET,
        TEST_SECRET_PREVIOUS: SERVICE,
        INSPECTOR_SERVICE_TOKEN: "rotated-service-token-abcdef0123",
        MCPJAM_ACCEPT_LEGACY_SIGNING_KEY: "false",
      },
    })!;
    expect(ring.accepted.some((key) => key.equals(legacyKey()))).toBe(true);
  });

  it("cannot drop the legacy key while it is still the only signer", () => {
    const ring = resolveSigningKeyRing({
      secretEnv: "TEST_SECRET",
      label: LABEL,
      env: {
        INSPECTOR_SERVICE_TOKEN: SERVICE,
        MCPJAM_ACCEPT_LEGACY_SIGNING_KEY: "false",
      },
    })!;
    expect(ring.signing.equals(legacyKey())).toBe(true);
  });

  it("names the secrets still accepting the legacy key, for the boot warning", () => {
    expect(
      signingSecretsStillAcceptingLegacy({
        HISTORY_PROVENANCE_SECRET: NEW_SECRET,
        INSPECTOR_SERVICE_TOKEN: SERVICE,
      }),
    ).toEqual(["HISTORY_PROVENANCE_SECRET"]);
    expect(
      signingSecretsStillAcceptingLegacy({
        HISTORY_PROVENANCE_SECRET: NEW_SECRET,
        INSPECTOR_SERVICE_TOKEN: SERVICE,
        MCPJAM_ACCEPT_LEGACY_SIGNING_KEY: "false",
      }),
    ).toEqual([]);
    expect(
      signingSecretsStillAcceptingLegacy({
        HISTORY_PROVENANCE_SECRET: NEW_SECRET,
      }),
    ).toEqual([]);
  });
});

describe("tool approvals across a key rotation", () => {
  it("an approval signed under the legacy token verifies after the dedicated secret is set", () => {
    const legacy = resolveToolApprovalSigningKey(
      { INSPECTOR_SERVICE_TOKEN: SERVICE },
      true,
    );
    const approvalId = mintToolApprovalId({ call, binding, key: legacy })!;
    const ring = resolveToolApprovalKeyRing({
      TOOL_APPROVAL_SIGNING_SECRET: NEW_SECRET,
      INSPECTOR_SERVICE_TOKEN: SERVICE,
    })!;
    // The new signer is the dedicated secret…
    expect(ring.signing.equals(legacy!)).toBe(false);
    // …and the old approval still verifies under the ring's accept-list.
    expect(
      ring.accepted.some(
        (key) => verifyToolApprovalId({ approvalId, call, binding, key }).ok,
      ),
    ).toBe(true);
  });

  it("rotating the service token no longer invalidates approvals signed under the dedicated secret", () => {
    const before = resolveToolApprovalKeyRing({
      TOOL_APPROVAL_SIGNING_SECRET: NEW_SECRET,
      INSPECTOR_SERVICE_TOKEN: SERVICE,
    })!;
    const approvalId = mintToolApprovalId({
      call,
      binding,
      key: before.signing,
    })!;
    const after = resolveToolApprovalKeyRing({
      TOOL_APPROVAL_SIGNING_SECRET: NEW_SECRET,
      INSPECTOR_SERVICE_TOKEN: "rotated-service-token-abcdef0123",
    })!;
    expect(
      verifyToolApprovalId({ approvalId, call, binding, key: after.signing })
        .ok,
    ).toBe(true);
  });
});

describe("tool approval verification reads the whole ring by default", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies an approval minted under the previous secret with no explicit key", () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("TOOL_APPROVAL_SIGNING_SECRET", OLD_SECRET);
    const approvalId = mintToolApprovalId({ call, binding })!;
    vi.stubEnv("TOOL_APPROVAL_SIGNING_SECRET", NEW_SECRET);
    vi.stubEnv("TOOL_APPROVAL_SIGNING_SECRET_PREVIOUS", OLD_SECRET);
    expect(verifyToolApprovalId({ approvalId, call, binding }).ok).toBe(true);
    vi.stubEnv("TOOL_APPROVAL_SIGNING_SECRET_PREVIOUS", "");
    expect(verifyToolApprovalId({ approvalId, call, binding })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });
});

describe("history provenance across a key rotation", () => {
  it("stored history signed under the previous secret keeps verifying", () => {
    const oldRing = resolveHistoryProvenanceKeyRing(
      { HISTORY_PROVENANCE_SECRET: OLD_SECRET },
      true,
    )!;
    const signer = historyProvenanceContextFor("proj_1", "chat_1", oldRing)!;
    const signature = signAssistantText(signer, "hello");

    const rotated = historyVerificationFor("proj_1", "chat_1", true, {
      HISTORY_PROVENANCE_SECRET: NEW_SECRET,
      HISTORY_PROVENANCE_SECRET_PREVIOUS: OLD_SECRET,
    })!.ctx!;
    expect(verifyAssistantText(rotated, "hello", signature)).toBe(true);
    expect(verifyAssistantText(rotated, "tampered", signature)).toBe(false);

    const forgotten = historyVerificationFor("proj_1", "chat_1", true, {
      HISTORY_PROVENANCE_SECRET: NEW_SECRET,
    })!.ctx!;
    expect(verifyAssistantText(forgotten, "hello", signature)).toBe(false);
  });

  it("rotating the service token no longer wipes history signed under the dedicated secret", () => {
    const signer = historyVerificationFor("proj_1", "chat_1", true, {
      HISTORY_PROVENANCE_SECRET: NEW_SECRET,
      INSPECTOR_SERVICE_TOKEN: SERVICE,
    })!.ctx!;
    const signature = signAssistantText(signer, "remember me");
    const afterRotation = historyVerificationFor("proj_1", "chat_1", true, {
      HISTORY_PROVENANCE_SECRET: NEW_SECRET,
      INSPECTOR_SERVICE_TOKEN: "rotated-service-token-abcdef0123",
    })!.ctx!;
    expect(verifyAssistantText(afterRotation, "remember me", signature)).toBe(
      true,
    );
  });

  it("history signed under the legacy token still verifies during the fallback release", () => {
    const legacy = historyVerificationFor("proj_1", "chat_1", true, {
      INSPECTOR_SERVICE_TOKEN: SERVICE,
    })!.ctx!;
    const signature = signAssistantText(legacy, "from before the switch");
    const switched = historyVerificationFor("proj_1", "chat_1", true, {
      HISTORY_PROVENANCE_SECRET: NEW_SECRET,
      INSPECTOR_SERVICE_TOKEN: SERVICE,
    })!.ctx!;
    expect(
      verifyAssistantText(switched, "from before the switch", signature),
    ).toBe(true);
  });

  it("history signed before the switch survives a later token rotation only if PREVIOUS keeps the old token", () => {
    const ROTATED = "rotated-service-token-abcdef0123";
    const legacy = historyVerificationFor("proj_1", "chat_1", true, {
      INSPECTOR_SERVICE_TOKEN: SERVICE,
    })!.ctx!;
    const signature = signAssistantText(legacy, "from before the switch");

    // Migration: the dedicated secret is set, the token is unchanged.
    const migrated = historyVerificationFor("proj_1", "chat_1", true, {
      HISTORY_PROVENANCE_SECRET: NEW_SECRET,
      INSPECTOR_SERVICE_TOKEN: SERVICE,
    })!.ctx!;
    expect(
      verifyAssistantText(migrated, "from before the switch", signature),
    ).toBe(true);

    // Rotating the token alone takes the old legacy key out of the ring.
    const rotatedBare = historyVerificationFor("proj_1", "chat_1", true, {
      HISTORY_PROVENANCE_SECRET: NEW_SECRET,
      INSPECTOR_SERVICE_TOKEN: ROTATED,
    })!.ctx!;
    expect(
      verifyAssistantText(rotatedBare, "from before the switch", signature),
    ).toBe(false);

    // Keeping the old token in PREVIOUS, as the runbook requires, keeps it.
    const rotatedKept = historyVerificationFor("proj_1", "chat_1", true, {
      HISTORY_PROVENANCE_SECRET: NEW_SECRET,
      HISTORY_PROVENANCE_SECRET_PREVIOUS: SERVICE,
      INSPECTOR_SERVICE_TOKEN: ROTATED,
    })!.ctx!;
    expect(
      verifyAssistantText(rotatedKept, "from before the switch", signature),
    ).toBe(true);
  });
});
