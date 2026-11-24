import { describe, expect, it } from "vitest";
import {
  listEvidenceContexts,
  selectServerEvidence,
} from "../evidence-input.js";
import { checkEvidenceFromDigest } from "../check-evidence.js";
import {
  computeCaptureContextHash,
  hashClientCapabilities,
} from "../context.js";

const CTX_A = "ctx_aaaaaaaaaaaaaaaa";
const CTX_B = "ctx_bbbbbbbbbbbbbbbb";

const inspection = {
  snapshot: {
    serverId: "srv",
    tools: [{ name: "a" }],
    discovery: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
    coverage: { tools: "complete", capabilities: "complete" },
  },
  latestEnvelopeVersion: 3,
  latestCapturedAt: 100,
  latestCaptureContextHash: CTX_A,
  latestCaptureContext: { transport: "streamable-http", protocolVersion: "2025-11-25" },
  latestAttempt: { status: "failed", at: 200, error: "timeout" },
};

const probeResults = [
  {
    contextHash: CTX_B,
    captureContext: { transport: "streamable-http", protocolVersion: "2026-07-28" },
    probes: [],
    updatedAt: 300,
  },
  {
    contextHash: CTX_A,
    captureContext: { transport: "streamable-http", protocolVersion: "2025-11-25" },
    probes: [
      {
        probeId: "authorization",
        status: "ok",
        coverage: "complete",
        at: 150,
        values: { oauthRequired: true, grantTypesSupported: ["authorization_code"], junk: { nested: 1 } },
        checks: { "oauth:oauth_token_format": "passed", "nope:x": "passed" },
      },
      { probeId: "unknown-probe", status: "ok", at: 1, values: {} },
    ],
    failures: [{ probeId: "server-card", status: "failed", at: 160, detail: "404" }],
    oauthFlow: {
      completedAt: 90,
      resourceIndicatorSent: true,
      scopesRequested: ["read"],
      scopesGranted: ["read"],
      issReturned: true,
      issValidated: true,
      refreshTokenIssued: false,
      accessToken: "must-not-survive",
    },
    updatedAt: 150,
  },
];

const observations = [
  { featureId: "tools.result.text", contextHash: CTX_A, count: 3, firstSeenAt: 1, lastSeenAt: 2, lastSource: "rpc" },
  { featureId: "tools.result.image", contextHash: CTX_B, count: 1, firstSeenAt: 1, lastSeenAt: 400, lastSource: "rpc" },
];

describe("selectServerEvidence", () => {
  it("defaults to the latest capture's context and never mixes contexts", () => {
    const selected = selectServerEvidence(
      { inspection, probeResults, observations },
      { connected: true },
    );
    expect(selected.contextHash).toBe(CTX_A);
    expect(selected.input.declared?.surface.protocolVersion).toBe("2025-11-25");
    expect(selected.input.declared?.capturedAt).toBe(100);
    expect(selected.input.observations?.map((o) => o.featureId)).toEqual([
      "tools.result.text",
    ]);
    expect(selected.input.probes?.authorization?.values).toEqual({
      oauthRequired: true,
      grantTypesSupported: ["authorization_code"],
    });
    expect(selected.input.probes?.authorization?.checks).toEqual({
      "oauth:oauth_token_format": "passed",
    });
    expect(selected.probeFailures).toEqual([
      { probeId: "server-card", status: "failed", at: 160, detail: "404" },
    ]);
    expect(selected.latestAttempt).toEqual({ status: "failed", at: 200, error: "timeout" });
    expect(selected.input.oauthFlow).not.toHaveProperty("accessToken");
    expect(selected.input.oauthFlow?.issValidated).toBe(true);
  });

  it("shows another context without the latest capture's declarations", () => {
    const selected = selectServerEvidence(
      { inspection, probeResults, observations },
      { connected: true, contextHash: CTX_B },
    );
    expect(selected.input.declared).toBeUndefined();
    expect(selected.input.context?.protocolVersion).toBe("2026-07-28");
    expect(selected.input.observations?.map((o) => o.featureId)).toEqual([
      "tools.result.image",
    ]);
  });

  it("uses a legacy inspection only when no context is known", () => {
    const legacy = { ...inspection, latestCaptureContextHash: undefined, latestCaptureContext: undefined };
    const selected = selectServerEvidence({ inspection: legacy }, { connected: false });
    expect(selected.contextHash).toBeUndefined();
    expect(selected.input.declared?.surface.tools).toHaveLength(1);
    expect(selected.input.connected).toBe(true);
    expect(selected.input.context?.protocolVersion).toBe("2025-11-25");
  });

  it("lists every context newest first", () => {
    const contexts = listEvidenceContexts({ inspection, probeResults, observations });
    expect(contexts.map((c) => c.contextHash)).toEqual([CTX_B, CTX_A]);
    expect(contexts[0].updatedAt).toBe(400);
    expect(contexts[1].context?.protocolVersion).toBe("2025-11-25");
  });

  it("shows a failed probe run as the attempt when no capture was saved", () => {
    const row = (fields: Record<string, unknown>) => ({
      contextHash: CTX_A,
      captureContext: { transport: "streamable-http", protocolVersion: "2025-11-25" },
      probes: [],
      updatedAt: 500,
      ...fields,
    });
    const failedCapture = row({
      lastAttemptAt: 500,
      lastAttemptStatus: "partial",
      lastAttemptError: "capture_failed",
    });
    expect(
      selectServerEvidence({ probeResults: [failedCapture] }, { connected: true })
        .latestAttempt,
    ).toEqual({ status: "failed", at: 500, error: "capture_failed" });
    expect(
      selectServerEvidence(
        { probeResults: [row({ lastAttemptAt: 500, lastAttemptError: "list_failed" })] },
        { connected: true },
      ).latestAttempt,
    ).toEqual({ status: "partial", at: 500, error: "list_failed" });
    expect(
      selectServerEvidence(
        { probeResults: [row({ lastAttemptAt: 500, lastAttemptStatus: "failed" })] },
        { connected: true },
      ).latestAttempt,
    ).toEqual({ status: "failed", at: 500, error: undefined });
    // A run that only lost some probes is not a failed capture.
    expect(
      selectServerEvidence(
        { probeResults: [row({ lastAttemptAt: 500, lastAttemptStatus: "partial" })] },
        { connected: true },
      ).latestAttempt,
    ).toBeUndefined();
    // With a saved capture shown, only the inspection's own attempt counts.
    const good = { ...inspection, latestAttempt: undefined };
    expect(
      selectServerEvidence(
        { inspection: good, probeResults: [failedCapture] },
        { connected: true },
      ).latestAttempt,
    ).toBeUndefined();
  });

  it("does not count a stored failed Refresh as connection history", () => {
    const row = (fields: Record<string, unknown>) => ({
      contextHash: CTX_A,
      captureContext: { transport: "streamable-http", protocolVersion: "2025-11-25" },
      updatedAt: 500,
      ...fields,
    });
    const failedOnly = row({
      probes: [{ probeId: "authorization", status: "failed", at: 500, coverage: "not-captured", values: {} }],
      lastAttemptAt: 500,
      lastAttemptStatus: "failed",
      lastAttemptError: "capture_failed",
    });
    expect(
      selectServerEvidence({ probeResults: [failedOnly] }, { connected: false }).input
        .connected,
    ).toBe(false);
    const answered = row({
      probes: [{ probeId: "authorization", status: "ok", at: 500, coverage: "complete", values: {} }],
    });
    expect(
      selectServerEvidence({ probeResults: [answered] }, { connected: false }).input
        .connected,
    ).toBe(true);
  });

  it("reports never-connected servers as not connected", () => {
    const selected = selectServerEvidence({}, { connected: false });
    expect(selected.input.connected).toBe(false);
    expect(selected.contexts).toEqual([]);
  });
});

describe("checkEvidenceFromDigest", () => {
  it("maps digest cases to check refs and drops pending ones", () => {
    const evidence = checkEvidenceFromDigest({
      runId: "run_1",
      runAt: 10,
      protocolVersion: "2025-11-25",
      suites: [
        {
          suiteKind: "protocol",
          cases: [
            { id: "tools-list", status: "passed" },
            { id: "ping", status: "could_not_run" },
            { id: "prompts-list", status: "pending" },
          ],
        },
        { suiteKind: "mystery", cases: [{ id: "x", status: "passed" }] },
      ],
    });
    expect(evidence).toEqual([
      { ref: "protocol:tools-list", status: "passed", runId: "run_1", runAt: 10, protocolVersion: "2025-11-25" },
      { ref: "protocol:ping", status: "skipped", runId: "run_1", runAt: 10, protocolVersion: "2025-11-25" },
    ]);
  });
});

describe("capture context hash", () => {
  it("is stable across set order and ignores empty fields", () => {
    const a = computeCaptureContextHash({
      transport: "streamable-http",
      protocolVersion: "2025-11-25",
      clientExtensions: ["b", "a"],
      hostProfile: "",
    });
    const b = computeCaptureContextHash({
      protocolVersion: "2025-11-25",
      transport: "streamable-http",
      clientExtensions: ["a", "b", "a"],
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^ctx_[0-9a-f]{16}$/);
  });

  it("separates contexts that differ in account binding", () => {
    const base = { transport: "streamable-http" as const, protocolVersion: "2025-11-25" };
    expect(computeCaptureContextHash({ ...base, accountBinding: "conn_1" })).not.toBe(
      computeCaptureContextHash({ ...base, accountBinding: "conn_2" }),
    );
  });

  it("hashes client capabilities independent of key order", () => {
    expect(hashClientCapabilities({ a: 1, b: { c: 2 } })).toBe(
      hashClientCapabilities({ b: { c: 2 }, a: 1 }),
    );
  });
});
