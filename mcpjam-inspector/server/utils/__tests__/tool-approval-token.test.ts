import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  markServerVerifiedApproval,
  mintToolApprovalId,
  requiresServerVerifiedApproval,
  resolveToolApprovalSigningKey,
  TOOL_APPROVAL_TOKEN_MAX_AGE_MS,
  toolApprovalBindingFor,
  toolApprovalSubjectFromAuthHeader,
  verifyToolApprovalId,
  type ToolApprovalBinding,
  type ToolApprovalCall,
} from "../tool-approval-token";

const KEY = randomBytes(32);
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

const CALL: ToolApprovalCall = {
  toolCallId: "call_1",
  toolName: "run_eval_suite",
  input: { suite: "checkout", options: { retries: 2, tags: ["a", "b"] } },
};

const BINDING: ToolApprovalBinding = {
  subject: "sub:issuer:user_1",
  projectId: "project_1",
  chatSessionId: "chat_1",
};

function mint(
  overrides: Partial<Parameters<typeof mintToolApprovalId>[0]> = {},
) {
  const id = mintToolApprovalId({
    call: CALL,
    binding: BINDING,
    key: KEY,
    nowMs: NOW,
    ...overrides,
  });
  if (!id) throw new Error("expected a signed id");
  return id;
}

function verify(
  approvalId: string,
  overrides: Partial<Parameters<typeof verifyToolApprovalId>[0]> = {},
) {
  return verifyToolApprovalId({
    approvalId,
    call: CALL,
    binding: BINDING,
    key: KEY,
    nowMs: NOW + 1_000,
    ...overrides,
  });
}

/** An unsigned JWT: the subject is read, never verified, by design. */
function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.c2ln`;
}

describe("tool approval ids", () => {
  it("verifies an id the server minted for the same call, caller and chat", () => {
    expect(verify(mint())).toEqual({ ok: true });
  });

  it("does not care about key order in the echoed input", () => {
    const id = mint();
    const reordered = {
      ...CALL,
      input: { options: { tags: ["a", "b"], retries: 2 }, suite: "checkout" },
    };
    expect(verify(id, { call: reordered })).toEqual({ ok: true });
  });

  it.each([
    [
      "an edited argument",
      { input: { ...(CALL.input as object), suite: "all" } },
    ],
    ["a renamed tool", { toolName: "waive_eval_gate" }],
    ["another call id", { toolCallId: "call_2" }],
  ])("rejects %s", (_label, change) => {
    const id = mint();
    expect(verify(id, { call: { ...CALL, ...change } })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it.each([
    ["another caller", { subject: "sub:issuer:user_2" }],
    ["another project", { projectId: "project_2" }],
    ["another chat", { chatSessionId: "chat_2" }],
  ])("rejects an id replayed into %s", (_label, change) => {
    const id = mint();
    expect(verify(id, { binding: { ...BINDING, ...change } })).toEqual({
      ok: false,
      reason: "signature_mismatch",
    });
  });

  it("rejects an id minted under another key", () => {
    const id = mint({ key: randomBytes(32) });
    expect(verify(id)).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("treats an id the server never signed as unsigned", () => {
    expect(verify("aitxt-3f9a0c")).toEqual({ ok: false, reason: "unsigned" });
    expect(verify("")).toEqual({ ok: false, reason: "unsigned" });
  });

  it("treats a signed-looking id with the wrong shape as malformed", () => {
    expect(verify("mjap1.abc")).toEqual({ ok: false, reason: "malformed" });
    expect(verify("mjap1.ABC!.nonce.mac")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects an id past its lifetime, but only once it is otherwise valid", () => {
    const id = mint();
    const late = NOW + TOOL_APPROVAL_TOKEN_MAX_AGE_MS + 60_000;
    expect(verify(id, { nowMs: late })).toEqual({
      ok: false,
      reason: "expired",
    });
    // A forged id reports as forged, not as merely old.
    expect(
      verify(id, { nowMs: late, binding: { ...BINDING, chatSessionId: "x" } }),
    ).toEqual({ ok: false, reason: "signature_mismatch" });
  });

  it("rejects an id dated beyond the tolerated clock skew", () => {
    const id = mint({ nowMs: NOW + 60 * 60 * 1000 });
    expect(verify(id)).toEqual({ ok: false, reason: "malformed" });
  });

  it("never mints or verifies without a key", () => {
    expect(
      mintToolApprovalId({ call: CALL, binding: BINDING, key: null }),
    ).toBeNull();
    expect(verify(mint(), { key: null })).toEqual({
      ok: false,
      reason: "no_key",
    });
  });

  it("mints a distinct id for every request, even for the same call", () => {
    expect(mint()).not.toBe(mint());
  });
});

describe("resolveToolApprovalSigningKey", () => {
  const TOKEN = "service-token-with-enough-length";

  it("derives a stable key from INSPECTOR_SERVICE_TOKEN, shared by replicas", () => {
    const a = resolveToolApprovalSigningKey(
      { INSPECTOR_SERVICE_TOKEN: TOKEN },
      true,
    );
    const b = resolveToolApprovalSigningKey(
      { INSPECTOR_SERVICE_TOKEN: ` ${TOKEN} ` },
      true,
    );
    expect(a).not.toBeNull();
    expect(a!.equals(b!)).toBe(true);
    // Derived, not the token itself.
    expect(a!.toString("utf8")).not.toContain(TOKEN);
    const other = resolveToolApprovalSigningKey(
      { INSPECTOR_SERVICE_TOKEN: `${TOKEN}-rotated` },
      true,
    );
    expect(a!.equals(other!)).toBe(false);
  });

  it("has NO key on a hosted deployment without the token", () => {
    expect(resolveToolApprovalSigningKey({}, true)).toBeNull();
    expect(
      resolveToolApprovalSigningKey({ INSPECTOR_SERVICE_TOKEN: "short" }, true),
    ).toBeNull();
  });

  it("uses one random per-process key on a non-hosted process", () => {
    const a = resolveToolApprovalSigningKey({}, false);
    const b = resolveToolApprovalSigningKey({}, false);
    expect(a).not.toBeNull();
    expect(a!.equals(b!)).toBe(true);
  });
});

describe("toolApprovalSubjectFromAuthHeader", () => {
  it("binds a JWT by issuer and subject, so a refreshed token still matches", () => {
    const first = fakeJwt({
      iss: "https://auth.example",
      sub: "user_1",
      iat: 1,
    });
    const refreshed = fakeJwt({
      iss: "https://auth.example",
      sub: "user_1",
      iat: 2,
    });
    expect(toolApprovalSubjectFromAuthHeader(`Bearer ${first}`)).toBe(
      toolApprovalSubjectFromAuthHeader(`bearer ${refreshed}`),
    );
    expect(toolApprovalSubjectFromAuthHeader(`Bearer ${first}`)).not.toBe(
      toolApprovalSubjectFromAuthHeader(
        `Bearer ${fakeJwt({ iss: "https://auth.example", sub: "user_2" })}`,
      ),
    );
  });

  it("binds anything else by a hash, never by its value", () => {
    const subject = toolApprovalSubjectFromAuthHeader(
      "Bearer opaque-api-key-1",
    );
    expect(subject.startsWith("bearer:")).toBe(true);
    expect(subject).not.toContain("opaque-api-key-1");
    expect(subject).not.toBe(
      toolApprovalSubjectFromAuthHeader("Bearer opaque-api-key-2"),
    );
  });

  it("has one subject for every request without a bearer", () => {
    expect(toolApprovalSubjectFromAuthHeader(undefined)).toBe("anonymous");
    expect(toolApprovalSubjectFromAuthHeader("Bearer   ")).toBe("anonymous");
    expect(toolApprovalBindingFor({})).toEqual({
      subject: "anonymous",
      projectId: "",
      chatSessionId: "",
    });
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and drops undefined members", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [1, { f: 2, e: 1 }], c: undefined } }),
    ).toBe('{"a":{"d":[1,{"e":1,"f":2}]},"b":1}');
  });
});

describe("server-verified approval marker", () => {
  it("survives the spreads every toolset wrapper makes", () => {
    const marked = markServerVerifiedApproval({ description: "x" });
    expect(requiresServerVerifiedApproval({ ...marked })).toBe(true);
    expect(requiresServerVerifiedApproval({ description: "x" })).toBe(false);
    expect(JSON.stringify(marked)).toBe('{"description":"x"}');
  });
});
