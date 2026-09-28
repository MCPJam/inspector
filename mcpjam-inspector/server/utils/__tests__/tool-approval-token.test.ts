import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  claimToolApproval,
  claimToolApprovalUse,
  EXPIRED_APPROVAL_RESULT,
  markServerVerifiedApproval,
  mintToolApprovalId,
  requiresServerVerifiedApproval,
  resolveToolApprovalSigningKey,
  TOOL_APPROVAL_TOKEN_MAX_AGE_MS,
  toolApprovalBindingFor,
  toolApprovalClaimKey,
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

  it("answers an approval for fifteen minutes, and no longer", () => {
    expect(TOOL_APPROVAL_TOKEN_MAX_AGE_MS).toBe(15 * 60 * 1000);
    const id = mint();
    expect(
      verify(id, { nowMs: NOW + TOOL_APPROVAL_TOKEN_MAX_AGE_MS - 1_000 }),
    ).toEqual({ ok: true });
    expect(
      verify(id, { nowMs: NOW + TOOL_APPROVAL_TOKEN_MAX_AGE_MS + 1_000 }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("tells the model and the user an expired approval ran nothing and can be asked again", () => {
    expect(EXPIRED_APPROVAL_RESULT).toMatch(/expired/);
    expect(EXPIRED_APPROVAL_RESULT).toMatch(/15 minutes/);
    expect(EXPIRED_APPROVAL_RESULT).toMatch(/nothing was run/);
    expect(EXPIRED_APPROVAL_RESULT).toMatch(/make it again/);
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

describe("claimToolApprovalUse", () => {
  it("lets each approval run its call once", () => {
    const id = mint();
    expect(claimToolApprovalUse(id, NOW)).toBe(true);
    expect(claimToolApprovalUse(id, NOW + 1_000)).toBe(false);
    expect(
      claimToolApprovalUse(id, NOW + TOOL_APPROVAL_TOKEN_MAX_AGE_MS - 1_000),
    ).toBe(false);
  });

  it("tracks every approval on its own", () => {
    const first = mint();
    const second = mint();
    expect(claimToolApprovalUse(first, NOW)).toBe(true);
    expect(claimToolApprovalUse(second, NOW)).toBe(true);
    expect(claimToolApprovalUse(first, NOW)).toBe(false);
    expect(claimToolApprovalUse(second, NOW)).toBe(false);
  });

  it("remembers a used approval for as long as it could still verify", () => {
    const id = mint();
    expect(claimToolApprovalUse(id, NOW)).toBe(true);
    expect(claimToolApprovalUse(id, NOW + TOOL_APPROVAL_TOKEN_MAX_AGE_MS)).toBe(
      false,
    );
    // Past that, the id itself no longer verifies.
    expect(
      verify(id, { nowMs: NOW + TOOL_APPROVAL_TOKEN_MAX_AGE_MS + 1_000 }),
    ).toEqual({ ok: false, reason: "expired" });
  });
});

describe("claimToolApproval", () => {
  const SERVICE_TOKEN = "service-token-with-enough-length";
  const SERVICE_ENV = {
    INSPECTOR_SERVICE_TOKEN: SERVICE_TOKEN,
    CONVEX_HTTP_URL: "https://backend.example.test/",
  };
  const CLAIM_URL =
    "https://backend.example.test/internal/v1/tool-approvals/claim";

  type ClaimRequest = {
    url: string;
    init: RequestInit;
    body: { nonceHash: string; expiresAt: number };
  };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  /** A backend that answers every claim with `respond`, recording each one. */
  function backend(respond: () => Response) {
    const requests: ClaimRequest[] = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          init: init ?? {},
          body: JSON.parse(String(init?.body)),
        });
        return respond();
      },
    ) as unknown as typeof fetch;
    return { requests, fetchImpl };
  }

  it("keeps claims in this process when approvals are signed with its own key", async () => {
    const { requests, fetchImpl } = backend(() => json({ status: "claimed" }));
    const id = mint();

    expect(
      await claimToolApproval(id, { nowMs: NOW, env: {}, fetchImpl }),
    ).toBe("claimed");
    expect(
      await claimToolApproval(id, { nowMs: NOW, env: {}, fetchImpl }),
    ).toBe("already_claimed");
    expect(requests).toEqual([]);
  });

  it("records the claim with the backend, keyed on a digest of the nonce", async () => {
    const { requests, fetchImpl } = backend(() => json({ status: "claimed" }));
    const id = mint();

    expect(
      await claimToolApproval(id, { nowMs: NOW, env: SERVICE_ENV, fetchImpl }),
    ).toBe("claimed");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.url).toBe(CLAIM_URL);
    expect(request.init.method).toBe("POST");
    expect(
      (request.init.headers as Record<string, string>)[
        "x-inspector-service-token"
      ],
    ).toBe(SERVICE_TOKEN);
    expect(request.body).toEqual({
      nonceHash: toolApprovalClaimKey(id),
      // Past the approval's lifetime on every replica's clock.
      expiresAt: NOW + TOOL_APPROVAL_TOKEN_MAX_AGE_MS + 5 * 60 * 1000,
    });
    expect(request.body.nonceHash).toMatch(/^[0-9a-f]{64}$/);
    // Neither the approval id nor its nonce leaves the process.
    const nonce = id.split(".")[2]!;
    expect(String(request.init.body)).not.toContain(nonce);
    expect(String(request.init.body)).not.toContain(id);

    // A second use is answered here, without asking again.
    expect(
      await claimToolApproval(id, { nowMs: NOW, env: SERVICE_ENV, fetchImpl }),
    ).toBe("already_claimed");
    expect(requests).toHaveLength(1);
  });

  it("does not run an approval the backend says was already claimed", async () => {
    const { requests, fetchImpl } = backend(() =>
      json({ status: "already_claimed" }),
    );
    const id = mint();

    expect(
      await claimToolApproval(id, { nowMs: NOW, env: SERVICE_ENV, fetchImpl }),
    ).toBe("already_claimed");
    expect(
      await claimToolApproval(id, { nowMs: NOW, env: SERVICE_ENV, fetchImpl }),
    ).toBe("already_claimed");
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["a server error", () => json({ ok: false }, 503)],
    ["a refused service token", () => json({ ok: false }, 401)],
    ["an answer outside the contract", () => json({ status: "maybe" })],
    ["a body that is not JSON", () => new Response("<html></html>")],
    [
      "a network error",
      (): Response => {
        throw new TypeError("fetch failed");
      },
    ],
  ])(
    "confirms nothing on %s, and asks the backend again on a retry",
    async (_label, failure) => {
      let failing = true;
      const { requests, fetchImpl } = backend(() =>
        failing ? failure() : json({ status: "claimed" }),
      );
      const id = mint();

      expect(
        await claimToolApproval(id, {
          nowMs: NOW,
          env: SERVICE_ENV,
          fetchImpl,
        }),
      ).toBe("unconfirmed");

      failing = false;
      expect(
        await claimToolApproval(id, {
          nowMs: NOW,
          env: SERVICE_ENV,
          fetchImpl,
        }),
      ).toBe("claimed");
      expect(requests).toHaveLength(2);
    },
  );

  it("confirms nothing when the backend does not answer in time", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    ) as unknown as typeof fetch;

    expect(
      await claimToolApproval(mint(), {
        nowMs: NOW,
        env: SERVICE_ENV,
        fetchImpl,
        timeoutMs: 20,
      }),
    ).toBe("unconfirmed");
  });

  it("confirms nothing when there is no backend to record the claim", async () => {
    const { requests, fetchImpl } = backend(() => json({ status: "claimed" }));

    expect(
      await claimToolApproval(mint(), {
        nowMs: NOW,
        env: { INSPECTOR_SERVICE_TOKEN: SERVICE_TOKEN },
        fetchImpl,
      }),
    ).toBe("unconfirmed");
    expect(requests).toEqual([]);
  });

  it("gives every approval its own claim key, and none to an unsigned id", () => {
    const first = mint();
    const second = mint();
    expect(toolApprovalClaimKey(first)).not.toBe(toolApprovalClaimKey(second));
    expect(toolApprovalClaimKey(first)).toBe(toolApprovalClaimKey(first));
    expect(toolApprovalClaimKey("aitxt-client-made-this")).toBeNull();
    expect(toolApprovalClaimKey("mjap1.only-two")).toBeNull();
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
