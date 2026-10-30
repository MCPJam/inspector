import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/oauth/mcp-oauth", () => ({
  hasOAuthConfig: vi.fn().mockReturnValue(false),
}));

import { hasOAuthConfig } from "@/lib/oauth/mcp-oauth";
import {
  createHttpServerConfig,
  createServer,
  createServerConfig,
} from "@/test/factories";
import type { ServerWithName } from "@/state/app-types";
import {
  headerNamesWithoutBearer,
  resolveServerAuth,
  splitAuthorizationHeader,
} from "../server-auth";

const URL = "https://example.com/mcp";

function httpServer(
  headers?: Record<string, string>,
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return createServer({
    config: createHttpServerConfig(
      URL,
      headers ? { requestInit: { headers } } : {},
    ),
    ...overrides,
  });
}

describe("resolveServerAuth", () => {
  beforeEach(() => {
    vi.mocked(hasOAuthConfig).mockReturnValue(false);
  });

  it.each([
    ["auto", "auto"],
    ["oauth", "oauth"],
    ["xaa", "xaa"],
    ["bearer", "bearer"],
    ["none", "none"],
  ] as const)(
    "lets a canonical authMethod %s win over the derived flags",
    (authMethod, expected) => {
      const server = httpServer(
        { Authorization: "Bearer token" },
        { authMethod, useOAuth: true, useXaa: true },
      );
      expect(resolveServerAuth(server).method).toBe(expected);
    },
  );

  it.each<
    [
      string,
      Partial<ServerWithName>,
      Record<string, string> | undefined,
      string,
    ]
  >([
    ["XAA before OAuth", { useXaa: true, useOAuth: true }, undefined, "xaa"],
    [
      "server OAuth before a bearer header",
      { useOAuth: true },
      { Authorization: "Bearer t" },
      "oauth",
    ],
    ["a local bearer header", {}, { Authorization: "Bearer t" }, "bearer"],
    ["a stored bearer token", { hasBearerToken: true }, undefined, "bearer"],
    ["nothing", {}, undefined, "none"],
  ])(
    "derives the method from legacy flags: %s",
    (_, overrides, headers, expected) => {
      expect(resolveServerAuth(httpServer(headers, overrides)).method).toBe(
        expected,
      );
    },
  );

  it("falls back to OAuth when only stored OAuth config exists", () => {
    vi.mocked(hasOAuthConfig).mockReturnValue(true);
    expect(resolveServerAuth(httpServer()).method).toBe("oauth");
  });

  it("reads a local bearer token case-insensitively and keeps it out of the headers", () => {
    const auth = resolveServerAuth(
      httpServer({ authorization: "bearer abc", "X-Tenant": "acme" }),
    );
    expect(auth.method).toBe("bearer");
    expect(auth.bearer).toEqual({ kind: "value", token: "abc" });
    expect(auth.headers).toEqual({
      kind: "values",
      entries: [["X-Tenant", "acme"]],
    });
  });

  it("marks a redacted bearer token as stored", () => {
    const auth = resolveServerAuth(
      httpServer(undefined, { hasBearerToken: true }),
    );
    expect(auth.bearer).toEqual({ kind: "stored" });
    expect(auth.headers).toBeNull();
  });

  it("reports stored headers for a synced bearer server, leaving names to settle it", () => {
    // A synced bearer token is saved as an Authorization header, so the record
    // carries both flags; only the stored names can say whether other headers
    // exist.
    const auth = resolveServerAuth(
      httpServer(undefined, { hasBearerToken: true, hasHeaders: true }),
    );
    expect(auth.bearer).toEqual({ kind: "stored" });
    expect(auth.headers).toEqual({ kind: "stored" });
  });

  it("keeps a non-Bearer Authorization header as a header", () => {
    const auth = resolveServerAuth(
      httpServer({ Authorization: "Basic dXNlcg==" }),
    );
    expect(auth.method).toBe("none");
    expect(auth.bearer).toBeNull();
    expect(auth.headers).toEqual({
      kind: "values",
      entries: [["Authorization", "Basic dXNlcg=="]],
    });
  });

  it("keeps a Bearer header as a header on an OAuth server", () => {
    const auth = resolveServerAuth(
      httpServer({ Authorization: "Bearer t" }, { authMethod: "oauth" }),
    );
    expect(auth.headers).toEqual({
      kind: "values",
      entries: [["Authorization", "Bearer t"]],
    });
  });

  it("reads the redacted flags off the config too", () => {
    const server = createServer({
      config: {
        ...createHttpServerConfig(URL),
        hasBearerToken: true,
        hasHeaders: true,
      } as ServerWithName["config"],
    });
    expect(resolveServerAuth(server)).toMatchObject({
      method: "bearer",
      bearer: { kind: "stored" },
      headers: { kind: "stored" },
    });
  });

  it("gives a stdio server no credentials", () => {
    const auth = resolveServerAuth(
      createServer({ config: createServerConfig() }),
    );
    expect(auth).toEqual({ method: "none", bearer: null, headers: null });
  });
});

describe("splitAuthorizationHeader", () => {
  it("routes a bearer server's Bearer header into the token", () => {
    expect(
      splitAuthorizationHeader("bearer", {
        Authorization: "Bearer abc",
        "X-Tenant": "acme",
      }),
    ).toEqual({ bearerToken: "abc", entries: [["X-Tenant", "acme"]] });
  });

  it("requires the exact Bearer prefix on revealed values", () => {
    expect(
      splitAuthorizationHeader("bearer", { Authorization: "bearer abc" }),
    ).toEqual({
      bearerToken: undefined,
      entries: [["Authorization", "bearer abc"]],
    });
  });

  it("leaves Authorization alone on a non-bearer server", () => {
    expect(
      splitAuthorizationHeader("none", { Authorization: "Bearer abc" }),
    ).toEqual({
      bearerToken: undefined,
      entries: [["Authorization", "Bearer abc"]],
    });
  });
});

describe("headerNamesWithoutBearer", () => {
  it("drops Authorization when it holds a stored bearer token", () => {
    expect(
      headerNamesWithoutBearer("bearer", true, ["Authorization", "X-Tenant"]),
    ).toEqual(["X-Tenant"]);
  });

  it("keeps Authorization otherwise", () => {
    expect(headerNamesWithoutBearer("none", true, ["Authorization"])).toEqual([
      "Authorization",
    ]);
    expect(
      headerNamesWithoutBearer("bearer", false, ["Authorization"]),
    ).toEqual(["Authorization"]);
  });
});
