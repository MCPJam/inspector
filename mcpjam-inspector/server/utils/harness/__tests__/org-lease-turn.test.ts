import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk/browser";

const broker = vi.hoisted(() => ({
  reserveHarnessBox: vi.fn(),
  startHarnessModelBroker: vi.fn(),
  failedTurnEvidence: vi.fn(),
}));

vi.mock("../harness-model-broker.js", () => ({
  reserveHarnessBox: broker.reserveHarnessBox,
  startHarnessModelBroker: broker.startHarnessModelBroker,
}));
vi.mock("../harness-org-lease.js", () => ({
  failedTurnEvidence: broker.failedTurnEvidence,
}));

import { OrgLeaseTurn } from "../org-lease-turn";
import { stampOrgCredentialRevision } from "../org-credential-continuity";
import { HarnessInfraSetupError } from "../harness-provider-error";

const ORG_SELECTION: ModelSelection = {
  source: "org",
  modelId: "anthropic/claude-sonnet-4.5",
  connectionRef: { kind: "orgProvider", id: "conn_1" },
  fallback: { provider: "none", model: "none" },
};

const ORG_UPSTREAM = {
  credentialSource: "org" as const,
  profile: "anthropic-native" as const,
  nativeModelId: "claude-sonnet-4-5",
  credentialRevision: "rev_b",
};

const BOX = { kind: "computer" as const, computerId: "c1", projectId: "p1" };

function turn(modelSelection?: ModelSelection) {
  return new OrgLeaseTurn({
    harness: "claude-code",
    modelSelection,
    authHeader: "Bearer t",
  });
}

async function leaseBox(org: OrgLeaseTurn) {
  await org.reserve({
    box: BOX,
    harnessId: "claude-code",
    modelId: "anthropic/claude-sonnet-4.5",
    runId: "run_1",
    bearer: "Bearer t",
  });
  return org.start({
    box: BOX,
    harnessId: "claude-code",
    modelId: "anthropic/claude-sonnet-4.5",
    runId: "run_1",
    bearer: "Bearer t",
  });
}

beforeEach(() => {
  broker.reserveHarnessBox.mockReset();
  broker.startHarnessModelBroker.mockReset();
  broker.failedTurnEvidence.mockReset();
  broker.reserveHarnessBox.mockResolvedValue({
    ok: true,
    credentialRevision: "rev_b",
  });
  broker.startHarnessModelBroker.mockResolvedValue({
    ok: true,
    runId: "run_1",
    proxyBaseUrl: "https://broker.example",
    orgUpstream: ORG_UPSTREAM,
  });
});

describe("OrgLeaseTurn on MCPJam's key", () => {
  it.each([undefined, {
    modelId: "anthropic/claude-sonnet-4.5", source: "hosted" as const,
    fallback: { provider: "none" as const, model: "none" as const },
    settings: { reasoningEffort: "high" as const },
  }])("keeps a hosted selection out of the org credential lease: %j", async (selection) => {
    const org = turn(selection);
    expect(org.modelId("gpt-5-nano", "openai")).toBe("openai/gpt-5-nano");
    expect(org.brokeredEndpoint).toBe("platform");
    expect(org.fingerprint()).toEqual({});
    await leaseBox(org);
    expect(broker.reserveHarnessBox.mock.calls[0]![0]).not.toHaveProperty(
      "modelSelection",
    );
    const startBody = broker.startHarnessModelBroker.mock.calls[0]![0];
    expect(startBody.modelSelection).toEqual(selection);
    expect(startBody).not.toHaveProperty("expectedCredentialRevision");
    expect(org.runtimeField()).toEqual({});
    expect(org.commitState({ a: 1 })).toEqual({ a: 1 });
  });

  it("fails a refused reservation as the box claim, whatever the backend's code", async () => {
    broker.reserveHarnessBox.mockResolvedValue({
      ok: false,
      status: 409,
      error: "busy",
      code: "box_busy",
    });
    const refused = turn()
      .reserve({
        box: BOX,
        harnessId: "claude-code",
        modelId: "m",
        runId: "r",
        bearer: "b",
      })
      .catch((error: unknown) => error);
    const error = await refused;
    expect(error).toBeInstanceOf(HarnessInfraSetupError);
    expect(error).toMatchObject({
      evidence: { code: "harness_box_reservation_failed" },
    });
  });
});

describe("OrgLeaseTurn on the organization's key", () => {
  it("runs the selection's canonical id and fingerprints the connection", () => {
    const org = turn(ORG_SELECTION);
    expect(org.modelId("claude-sonnet-4-5", "anthropic")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(org.brokeredEndpoint).toBe("byok_hosted");
    expect(org.fingerprint()).toEqual({
      credential: "org:conn_1:anthropic-native",
    });
  });

  it("hands the start the revision /reserve prepared, then runs natively", async () => {
    const org = turn(ORG_SELECTION);
    await leaseBox(org);
    expect(broker.reserveHarnessBox.mock.calls[0]![0]).toMatchObject({
      modelSelection: ORG_SELECTION,
    });
    expect(broker.startHarnessModelBroker.mock.calls[0]![0]).toMatchObject({
      modelSelection: ORG_SELECTION,
      expectedCredentialRevision: "rev_b",
    });
    const toNativeModel = vi.fn(() => "claude-sonnet-4-5");
    org.nativeModel({ toNativeModel }, "anthropic/claude-sonnet-4.5");
    expect(toNativeModel).toHaveBeenCalledWith("anthropic/claude-sonnet-4.5", {
      profile: "anthropic-native",
      nativeModelId: "claude-sonnet-4-5",
    });
    expect(org.commitState({ a: 1 })).toEqual(
      stampOrgCredentialRevision({ a: 1 }, "rev_b"),
    );
  });

  it("keeps the backend's code when /reserve refuses the selection", async () => {
    broker.reserveHarnessBox.mockResolvedValue({
      ok: false,
      status: 422,
      error: "mismatch",
      code: "provider_mismatch",
    });
    const error = await turn(ORG_SELECTION)
      .reserve({
        box: BOX,
        harnessId: "claude-code",
        modelId: "m",
        runId: "r",
        bearer: "b",
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ evidence: { code: "provider_mismatch" } });
  });

  it("starts a fresh session when the lane's state came from another key", async () => {
    const org = turn(ORG_SELECTION);
    const state = org.claimed({
      resumeState: stampOrgCredentialRevision({ a: 1 }, "rev_a"),
    });
    expect(state).toEqual({ resumeState: { a: 1 } });
    await leaseBox(org);
    expect(org.continuityOnLeasedKey({ state, stateVersion: 3 })).toEqual({
      state: null,
      stateVersion: 3,
      runtimeChanged: true,
    });
  });

  it("resumes a lane whose state was produced on the same key", async () => {
    const org = turn(ORG_SELECTION);
    const state = org.claimed({
      resumeState: stampOrgCredentialRevision({ a: 1 }, "rev_b"),
    });
    await leaseBox(org);
    const continuity = { state, stateVersion: 3 };
    expect(org.continuityOnLeasedKey(continuity)).toBe(continuity);
  });

  it("reads a failed turn's refusal back from the lease it started", async () => {
    const org = turn(ORG_SELECTION);
    await org.failedTurnEvidence(undefined, true);
    expect(broker.failedTurnEvidence).toHaveBeenLastCalledWith(
      expect.objectContaining({ leaseRunId: undefined }),
    );
    await leaseBox(org);
    await org.failedTurnEvidence(undefined, true);
    expect(broker.failedTurnEvidence).toHaveBeenLastCalledWith({
      evidence: undefined,
      modelInvoked: true,
      leaseRunId: "run_1",
      bearer: "Bearer t",
      turnStartedAt: expect.any(Number),
    });
  });
});
