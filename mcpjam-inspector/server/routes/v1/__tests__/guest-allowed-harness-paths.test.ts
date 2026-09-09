/**
 * The guest allowlist is an AUTHORIZATION boundary, so the harness metadata
 * rules get their own coverage rather than riding on the route tests.
 *
 * Both harness rules admit exactly one shape — a GET to one path segment — and
 * every near miss below is a way a loosened pattern could quietly widen the
 * boundary for share-link and local-mode guests.
 */
import { describe, expect, it } from "vitest";
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";

describe("guest access to harness metadata", () => {
  it("allows the canonical GET for every harness id", () => {
    for (const id of ["claude-code", "codex", "cursor"]) {
      expect(
        isGuestAllowedV1Request("GET", `/api/v1/harness/${id}/capabilities`),
      ).toBe(true);
      expect(
        isGuestAllowedV1Request("GET", `/api/v1/harness/${id}/builtin-tools`),
      ).toBe(true);
    }
  });

  it("is GET-only", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(
        isGuestAllowedV1Request(
          method,
          "/api/v1/harness/codex/capabilities",
        ),
      ).toBe(false);
    }
  });

  it("accepts the method case-insensitively", () => {
    // The middleware passes `c.req.method` straight through; a lowercase verb
    // must not read as a different method and fall through to a refusal.
    expect(
      isGuestAllowedV1Request("get", "/api/v1/harness/codex/capabilities"),
    ).toBe(true);
  });

  it("refuses an empty harness id", () => {
    // `[^/]+` must not match nothing: `/harness//capabilities` is not a route
    // the registry can resolve, and admitting it would put an unresolvable id
    // through the guest boundary.
    expect(
      isGuestAllowedV1Request("GET", "/api/v1/harness//capabilities"),
    ).toBe(false);
  });

  it("refuses near-miss paths", () => {
    for (const path of [
      // Extra segments on either side.
      "/api/v1/harness/codex/capabilities/extra",
      "/api/v1/harness/codex/sub/capabilities",
      // A different terminal segment.
      "/api/v1/harness/codex/capability",
      "/api/v1/harness/codex",
      // Not anchored to the harness prefix.
      "/api/v1/projects/p1/harness/codex/capabilities",
      // A trailing slash is a different path.
      "/api/v1/harness/codex/capabilities/",
    ]) {
      expect(isGuestAllowedV1Request("GET", path), path).toBe(false);
    }
  });

  it("does not admit a project-scoped route through the harness rules", () => {
    // The guard against the rule being loosened into something with a project
    // behind it, which is the only way these two rules could leak user data.
    expect(
      isGuestAllowedV1Request("GET", "/api/v1/projects/p1/clients"),
    ).toBe(false);
  });
});
