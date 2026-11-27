import { describe, expect, it } from "vitest";
import { describeError, ERROR_CATALOG } from "@mcpjam/sdk/browser";
import {
  connectFailureActionKind,
  connectFailureActionLabel,
  describeConnectFailure,
  EDIT_INPUT_SLUGS,
  START_OAUTH_SLUGS,
} from "../connect-failure";

describe("describeConnectFailure", () => {
  it("keeps a server block that names a cause", () => {
    const normalized = describeError(
      Object.assign(new Error("HTTP 401"), { code: 401 }),
    );
    expect(describeConnectFailure("HTTP 401", normalized)).toBe(normalized);
  });

  it("files the catch-all and bare text under connect/unclassified", () => {
    const unknown = describeError(new Error("Upstream said no"));
    expect(unknown.slug).toBe("internal/unknown");
    expect(describeConnectFailure("ignored", unknown)).toMatchObject({
      slug: "connect/unclassified",
      oneLine: "Upstream said no",
    });
    expect(describeConnectFailure("Upstream said no").slug).toBe(
      "connect/unclassified",
    );
    expect(describeConnectFailure(undefined).slug).toBe("connect/unclassified");
  });

  it("keeps the server block's diagnostics when it reclassifies", () => {
    const unknown = {
      ...describeError(new Error("Upstream said no")),
      requestId: "req_123",
      stack: "Error: Upstream said no",
      cause: { name: "TypeError", message: "fetch failed" },
    };
    expect(describeConnectFailure("ignored", unknown)).toMatchObject({
      slug: "connect/unclassified",
      requestId: "req_123",
      stack: "Error: Upstream said no",
      cause: { name: "TypeError", message: "fetch failed" },
    });
  });
});

describe("connect failure action", () => {
  it("maps only to slugs the catalog has", () => {
    for (const slug of [...EDIT_INPUT_SLUGS, ...START_OAUTH_SLUGS]) {
      expect(ERROR_CATALOG[slug], slug).toBeDefined();
    }
  });

  it.each([
    ["auth/http_401", "http", "start_oauth", "Start OAuth"],
    ["oauth/invalid_client", "http", "start_oauth", "Start OAuth"],
    ["transport/econnrefused", "http", "edit_input", "Edit URL"],
    ["transport/spawn_failed", "stdio", "edit_input", "Edit command"],
    ["auth/http_401", "stdio", "reconnect", "Reconnect"],
    ["auth/missing_bearer", "http", "reconnect", "Reconnect"],
    ["auth/proxy_rejected", "http", "reconnect", "Reconnect"],
    ["auth/authorization_server_unreachable", "http", "reconnect", "Reconnect"],
    ["oauth/well_known_unreachable", "http", "reconnect", "Reconnect"],
    ["oauth/redirect_mismatch", "http", "reconnect", "Reconnect"],
    ["connect/unclassified", "http", "reconnect", "Reconnect"],
  ] as const)("%s over %s offers %s", (slug, transport, kind, label) => {
    expect(connectFailureActionKind(slug, transport)).toBe(kind);
    expect(connectFailureActionLabel(kind, transport)).toBe(label);
  });
});
