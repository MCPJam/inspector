import { describe, expect, it, vi } from "vitest";
import {
  describeError,
  isNormalizedError,
  type NormalizedError,
} from "@mcpjam/sdk/browser";
import {
  credentialRefusalMessage,
  onCredentialReentryRequest,
  readCredentialRefusal,
  withCredentialRefusal,
} from "../credential-refusal";

describe("readCredentialRefusal", () => {
  it("reads a moved-server refusal from a local connect envelope", () => {
    expect(
      readCredentialRefusal({
        success: false,
        error: "Forbidden",
        secretOriginMismatch: true,
        boundOrigin: "https://owner.example.com",
        targetOrigin: "https://moved.example.com",
      }),
    ).toEqual({
      kind: "origin_mismatch",
      boundOrigin: "https://owner.example.com",
      targetOrigin: "https://moved.example.com",
    });
  });

  it("reads an export-policy refusal", () => {
    expect(readCredentialRefusal({ exportDenied: true, policy: "x" })).toEqual({
      kind: "export_denied",
    });
  });

  it("reads the hosted result's nested refusal", () => {
    expect(
      readCredentialRefusal({
        success: false,
        credentialRefusal: { kind: "export_denied" },
      }),
    ).toEqual({ kind: "export_denied" });
  });

  it("ignores every other failure", () => {
    expect(readCredentialRefusal({ success: false, error: "boom" })).toBeNull();
    expect(readCredentialRefusal({ oauthRequired: true })).toBeNull();
    expect(readCredentialRefusal(null)).toBeNull();
  });
});

describe("credentialRefusalMessage", () => {
  it("names both origins and the fix for a moved server", () => {
    const message = credentialRefusalMessage(
      {
        kind: "origin_mismatch",
        boundOrigin: "https://owner.example.com",
        targetOrigin: "https://moved.example.com",
      },
      "Docs",
    );
    expect(message).toContain('"Docs"');
    expect(message).toContain("https://owner.example.com");
    expect(message).toContain("https://moved.example.com");
    expect(message).toMatch(/Re-enter the credentials/);
  });

  it("points at the organization policy for an export refusal", () => {
    const message = credentialRefusalMessage({ kind: "export_denied" }, "Docs");
    expect(message).toMatch(/organization admin/);
    expect(message).toContain(
      "turn on Allow credential export in Organization settings under Security",
    );
  });
});

describe("withCredentialRefusal", () => {
  it("rewrites the error and opens the server's configuration for a moved server", () => {
    const listener = vi.fn();
    const unsubscribe = onCredentialReentryRequest(listener);
    try {
      const result = withCredentialRefusal(
        {
          success: false,
          error: "Forbidden",
          secretOriginMismatch: true,
          boundOrigin: "https://owner.example.com",
          targetOrigin: "https://moved.example.com",
        },
        "Docs",
      ) as { error: string; credentialRefusal: unknown };

      expect(result.error).toMatch(/Re-enter the credentials/);
      expect(result.credentialRefusal).toMatchObject({
        kind: "origin_mismatch",
      });
      expect(listener).toHaveBeenCalledWith(
        "Docs",
        expect.objectContaining({ kind: "origin_mismatch" }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("does not open the form for a policy refusal the person cannot fix there", () => {
    const listener = vi.fn();
    const unsubscribe = onCredentialReentryRequest(listener);
    try {
      const result = withCredentialRefusal(
        { success: false, error: "Forbidden", exportDenied: true },
        "Docs",
      ) as { error: string };
      expect(result.error).toMatch(/Allow credential export/);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("gives the error card the toast's message instead of the generic 403", () => {
    const serverBlock = describeError(
      Object.assign(new Error("not bound to an address"), { status: 403 }),
    );
    expect(serverBlock.slug).toBe("auth/http_403");

    const result = withCredentialRefusal(
      {
        success: false,
        error: "Forbidden",
        normalized: serverBlock,
        credentialRefusal: {
          kind: "origin_mismatch",
          boundOrigin: null,
          targetOrigin: "https://api-sandbox.example.com",
        },
      },
      "Docs",
    ) as { error: string; normalized: NormalizedError };

    expect(result.normalized.title).toBe("Saved credentials not sent");
    expect(result.normalized.oneLine).toBe(result.error);
    expect(result.normalized.oneLine).not.toMatch(/lack permission/);
    expect(result.normalized.likelyCauses).toEqual([]);
    expect(result.normalized.nextSteps).toEqual([]);
    expect(result.normalized.docsAnchor).not.toMatch(/forbidden-403/);
    // Classification and the raw message stay the server's.
    expect(result.normalized.slug).toBe("auth/http_403");
    expect(result.normalized.rawMessage).toBe(serverBlock.rawMessage);
  });

  it("builds the card copy when the result carries no error block", () => {
    const result = withCredentialRefusal(
      { success: false, error: "Forbidden", exportDenied: true },
      "Docs",
    ) as { error: string; normalized: NormalizedError };

    expect(isNormalizedError(result.normalized)).toBe(true);
    expect(result.normalized.title).toBe("Blocked by organization policy");
    expect(result.normalized.oneLine).toBe(result.error);
  });

  it("passes successes and unrelated failures through untouched", () => {
    const ok = { success: true };
    const failed = { success: false, error: "timeout" };
    expect(withCredentialRefusal(ok, "Docs")).toBe(ok);
    expect(withCredentialRefusal(failed, "Docs")).toBe(failed);
  });
});

describe("a shared or uploaded account's refusal", () => {
  const SENTENCE =
    "Local runs aren't allowed yet for this server's shared sign-in. Ask a project admin to turn on Allow local runs in the server's sharing settings.";

  it("is its own kind, with its cause, on a local envelope and a hosted result", () => {
    expect(
      readCredentialRefusal({ exportDenied: true, policy: "hostedOnlyAccount" }),
    ).toEqual({ kind: "hosted_only" });
    expect(
      readCredentialRefusal({
        exportDenied: true,
        policy: "hostedOnlyAccount",
        cause: "not_acknowledged",
      }),
    ).toEqual({ kind: "hosted_only", cause: "not_acknowledged" });
    expect(
      readCredentialRefusal({
        credentialRefusal: { kind: "hosted_only", cause: "not_acknowledged" },
      }),
    ).toEqual({ kind: "hosted_only", cause: "not_acknowledged" });
  });

  it("keeps the server's sentence instead of pointing at the export policy", () => {
    const result = withCredentialRefusal(
      {
        success: false,
        error: SENTENCE,
        exportDenied: true,
        policy: "hostedOnlyAccount",
        cause: "not_acknowledged",
      },
      "Docs",
    ) as { error: string; normalized: NormalizedError };
    expect(result.error).toBe(SENTENCE);
    expect(result.error).not.toMatch(/organization admin/);
    expect(result.normalized.title).toBe("Local runs not allowed yet");
  });

  it("names the admin's step when the result carries no sentence", () => {
    const message = credentialRefusalMessage(
      { kind: "hosted_only", cause: "not_acknowledged" },
      "Docs",
    );
    expect(message).toMatch(/Allow local runs/);
    expect(message).not.toMatch(/organization admin/);
    expect(
      credentialRefusalMessage({ kind: "hosted_only" }, "Docs"),
    ).toMatch(/shared or uploaded account/);
  });

  it("asks for an update when the backend says this app is too old", () => {
    expect(
      credentialRefusalMessage(
        { kind: "hosted_only", cause: "client_upgrade_required" },
        "Docs",
      ),
    ).toBe(
      '"Docs" signs in with a shared or uploaded account. Update MCPJam to use it locally.',
    );
  });
});

describe("a moved server named by only its new address", () => {
  it("says where it points now", () => {
    expect(
      credentialRefusalMessage(
        {
          kind: "origin_mismatch",
          boundOrigin: null,
          targetOrigin: "https://new.example.com",
        },
        "Docs",
      ),
    ).toContain("It now points at https://new.example.com");
  });
});
