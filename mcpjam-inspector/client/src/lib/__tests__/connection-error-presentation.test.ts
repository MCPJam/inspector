import { describe, expect, it } from "vitest";
import { describeAsSlug } from "@mcpjam/sdk/browser";
import { WebApiError } from "../apis/web/base";
import {
  presentConnectionError,
  readConnectionFailureFacts,
  connectionFailureFields,
} from "../connection-error-presentation";

const context = { serverName: "Prod Asana MCP" };

describe("connection error presentation", () => {
  it("keeps the reviewed Asana unknown fallback and does not infer sign-in", () => {
    const error = "Guest client secret reveal is not supported";
    const result = presentConnectionError(error, context);
    expect(result.title).toBe("Couldn't connect to Prod Asana MCP.");
    expect(result.explanation).toBe(
      "Open the server settings to review the connection, or copy the details for support.",
    );
    expect(result.diagnostics.rawMessage).toBe(error);
    expect(result.recovery).toBe("settings");
  });

  it("only offers available recovery when the cause is unknown", () => {
    const result = presentConnectionError("unknown failure", {
      ...context,
      recoveries: ["copy-details"],
    });
    expect(result.title).toBe("Couldn't connect to Prod Asana MCP.");
    expect(result.explanation).toBe("Copy the details for support.");
    expect(result.recovery).toBe("copy-details");
  });

  it.each([
    new Error("Sign in to MCPJam to continue"),
    { status: 401, message: "Unauthorized" },
    { code: "UNAUTHORIZED", details: { reason: "access_token_expired" } },
    { code: 401, error: "Sign in required" },
    { details: { reason: ["SIGN_IN_REQUIRED"] } },
    { code: "SIGN_IN_REQUIRED" },
    { code: "SESSION_REVOKED" },
    { code: "UNAUTHORIZED", details: { reason: "SIGN_IN_REQUIRED" } },
    { rawCode: "SIGN_IN_REQUIRED", origin: "user_server" },
    { normalized: { rawCode: "SIGN_IN_REQUIRED", origin: "user_server" } },
  ])(
    "does not turn prose or a generic 401 into a MCPJam sign-in requirement: %j",
    (input) => {
      expect(presentConnectionError(input, context).recovery).not.toBe(
        "sign-in",
      );
    },
  );

  it.each([
    new WebApiError(401, "SIGN_IN_REQUIRED", "wire"),
    new WebApiError(401, "UNAUTHORIZED", "wire", undefined, {
      reason: "SIGN_IN_REQUIRED",
    }),
    { failureFacts: { code: "SIGN_IN_REQUIRED" } },
  ])("uses explicit structured sign-in facts: %j", (input) => {
    const result = presentConnectionError(input, context);
    expect(result.explanation).toBe("Sign in to MCPJam to continue.");
    expect(result.recovery).toBe("sign-in");
  });

  it.each([
    new WebApiError(401, "SESSION_REVOKED", "wire"),
    new WebApiError(401, "UNAUTHORIZED", "wire", undefined, {
      reason: "SESSION_REVOKED",
    }),
  ])("distinguishes revoked MCPJam sign-in from server OAuth: %j", (input) => {
    expect(presentConnectionError(input, context).explanation).toMatch(
      /^Your MCPJam sign-in expired/,
    );
  });

  it("keeps credential policy denial separate from origin mismatch and generic 403", () => {
    const denied = readConnectionFailureFacts({
      details: { exportDenied: true },
    });
    const moved = readConnectionFailureFacts({
      credentialRefusal: {
        kind: "origin_mismatch",
        boundOrigin: "https://old.example",
        targetOrigin: "https://new.example",
      },
    });
    expect(
      presentConnectionError("wire", { ...context, facts: denied }).explanation,
    ).toContain("credential export policy");
    expect(
      presentConnectionError("wire", { ...context, facts: moved }).explanation,
    ).toContain("re-enter the credentials");
    expect(readConnectionFailureFacts({ status: 403 })).toEqual({});
    expect(
      readConnectionFailureFacts({ credentialRefusal: { kind: "arbitrary" } }),
    ).toEqual({});
  });

  it("uses the local catalog, never wire titles, arrays, causes or documentation links as visible copy", () => {
    const wire = {
      ...describeAsSlug("auth/consent_required", new Error("wire")),
      title: "WIRE TITLE",
      oneLine: "WIRE SUMMARY",
      likelyCauses: ["WIRE CAUSE"],
      nextSteps: ["WIRE ACTION"],
      docsAnchor: "https://evil.example/",
      cause: { name: "WIRE TYPE", message: "WIRE CAUSE" },
    };
    const result = presentConnectionError(wire, context);
    expect(result.explanation).toContain("permission");
    expect(result.explanation).not.toContain("WIRE");
    expect(result.diagnostics.docsAnchor).not.toContain("evil.example");
    expect(result.diagnostics.cause?.message).toBe("WIRE CAUSE");
  });

  it("preserves sanitized evidence, codes, request IDs, origin and original slug", () => {
    const result = presentConnectionError(
      {
        slug: "future/diagnosis",
        message: "wire client_secret=supersecret",
        rawCode: "CUSTOM",
        requestId: "request-123",
        origin: "user_server",
        stack: 'Error: {"access_token":"supersecret"}',
      },
      { ...context, oauthStage: "Metadata received" },
    );
    expect(result.diagnostics.slug).toBe("internal/unknown");
    expect(result.diagnostics.rawCode).toBe("CUSTOM");
    expect(result.diagnostics.requestId).toBe("request-123");
    expect(result.diagnostics.origin).toBe("user_server");
    expect(result.diagnostics.rawMessage).toContain(
      "Error category: future/diagnosis",
    );
    expect(result.diagnostics.rawMessage).toContain(
      "OAuth step: Metadata received",
    );
    expect(JSON.stringify(result)).not.toContain("supersecret");
  });

  it("bounds and sanitizes names and supports contextual operations without unavailable recovery actions", () => {
    const result = presentConnectionError(null, {
      serverName: "x".repeat(1000),
      operation: "authorize",
      recoveries: [],
    });
    expect(result.title.length).toBeLessThan(200);
    expect(result.title).toMatch(/^Couldn't authorize/);
    expect(result.recovery).toBe("copy-details");
  });

  it.each([
    null,
    undefined,
    42,
    false,
    [],
    {},
    {
      normalized: {
        likelyCauses: [null],
        nextSteps: 5,
        cause: ["wire"],
        requestId: [],
      },
    },
  ])("handles malformed failures without promoting wire data: %j", (input) => {
    expect(() => presentConnectionError(input, context)).not.toThrow();
    expect(presentConnectionError(input, context).title).toBe(
      "Couldn't connect to Prod Asana MCP.",
    );
  });

  it("preserves structured metadata and sanitized diagnostics across the dispatch seam", () => {
    const fields = connectionFailureFields(
      new WebApiError(
        401,
        "SIGN_IN_REQUIRED",
        "client_secret=supersecret",
        {
          ...describeAsSlug(
            "internal/unknown",
            new Error("client_secret=supersecret"),
          ),
          slug: "future/diagnosis",
          origin: "mcpjam",
        },
        undefined,
        "request-123",
      ),
    );
    const result = presentConnectionError(fields.normalized, {
      ...context,
      facts: fields.failureFacts,
    });
    expect(result.recovery).toBe("sign-in");
    expect(result.diagnostics.requestId).toBe("request-123");
    expect(result.diagnostics.origin).toBe("mcpjam");
    expect(result.diagnostics.rawMessage).toContain("future/diagnosis");
    expect(JSON.stringify(result)).not.toContain("supersecret");
  });
});
