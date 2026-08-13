/**
 * The handoff page's routing and its callback marker.
 *
 * These are small pure functions guarding two failures that are silent when
 * they happen: routing a request id as if it were a handoff token, which burns
 * a single-use claim that could never have succeeded; and letting a connection
 * flow's marker capture an `/oauth/callback` that belonged to the Inspector's
 * own OAuth flow, which would post someone else's `state` to the wrong
 * endpoint.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  clearPendingAuthorization,
  handoffRequestPath,
  isTerminalHandoffStatus,
  isWaitingHandoffStatus,
  matchHandoffRoute,
  readCallbackParams,
  readPendingAuthorization,
  rememberPendingAuthorization,
} from "../server-connection-handoff";

afterEach(() => {
  clearPendingAuthorization();
});

describe("matchHandoffRoute", () => {
  it("reads a handoff token", () => {
    expect(matchHandoffRoute("/connect/server/abc-123_XYZ")).toEqual({
      kind: "claim",
      handoffToken: "abc-123_XYZ",
    });
  });

  it("reads a request id", () => {
    expect(matchHandoffRoute("/connect/server/request/scr_abc123")).toEqual({
      kind: "request",
      requestId: "scr_abc123",
    });
  });

  it("never mistakes a request path for a token", () => {
    // Both shapes live under the same prefix. Claiming with `request` as the
    // token would consume the single-use claim on a value that cannot match,
    // leaving the user a dead link and no explanation.
    expect(matchHandoffRoute("/connect/server/request")).toBeNull();
    expect(matchHandoffRoute("/connect/server/request/")).toBeNull();
  });

  it("declines anything else", () => {
    for (const path of [
      "/",
      "/connect",
      "/connect/server",
      "/connect/server/",
      "/connect/servers/abc",
      "/oauth/callback",
      "/connect/server/abc/extra",
      "/connect/server/has spaces",
    ]) {
      expect(matchHandoffRoute(path)).toBeNull();
    }
  });

  it("round-trips a request id through its path", () => {
    expect(matchHandoffRoute(handoffRequestPath("scr_xyz"))).toEqual({
      kind: "request",
      requestId: "scr_xyz",
    });
  });
});

describe("the pending-authorization marker", () => {
  it("remembers and forgets a request id", () => {
    expect(readPendingAuthorization()).toBeNull();
    rememberPendingAuthorization("scr_abc");
    expect(readPendingAuthorization()).toBe("scr_abc");
    clearPendingAuthorization();
    expect(readPendingAuthorization()).toBeNull();
  });

  it("holds nothing but the request id", () => {
    rememberPendingAuthorization("scr_abc");
    // The request id is printable by design; the AUTHORITY is the HttpOnly
    // cookie the browser sends on its own. If anything secret ever landed
    // here, every script on this origin could read it.
    expect(sessionStorage.getItem("mcpjam-server-connection-pending")).toBe(
      "scr_abc"
    );
  });
});

describe("readCallbackParams", () => {
  it("reads a successful callback", () => {
    expect(
      readCallbackParams("?code=auth-code&state=st&iss=https://as.example")
    ).toEqual({
      state: "st",
      code: "auth-code",
      iss: "https://as.example",
      error: undefined,
      errorDescription: undefined,
    });
  });

  it("reads a denial", () => {
    const params = readCallbackParams(
      "?error=access_denied&error_description=User+said+no&state=st"
    );
    expect(params?.error).toBe("access_denied");
    expect(params?.errorDescription).toBe("User said no");
    expect(params?.code).toBeUndefined();
  });

  it("declines a callback that is not an answer", () => {
    // `/oauth/callback` is shared with the Inspector's own flow. A query with
    // a state but neither a code nor an error is not this flow's business, and
    // posting it would send another flow's state to the wrong endpoint.
    expect(readCallbackParams("?state=st")).toBeNull();
    expect(readCallbackParams("?code=auth-code")).toBeNull();
    expect(readCallbackParams("")).toBeNull();
  });

  it("bounds a third party's prose before it reaches the page", () => {
    const long = "x".repeat(600);
    const params = readCallbackParams(
      `?error=server_error&error_description=${long}&state=st`
    );
    expect(params?.errorDescription).toHaveLength(300);
  });
});

describe("status predicates", () => {
  it("stops on every terminal status the backend has", () => {
    // Mirrors TERMINAL_STATUSES in the backend's serverConnectionPolicy. A
    // status missing from here is a page that polls forever.
    for (const status of ["ready", "failed", "expired", "cancelled"]) {
      expect(isTerminalHandoffStatus(status)).toBe(true);
      expect(isWaitingHandoffStatus(status)).toBe(false);
    }
  });

  it("waits while someone else is working", () => {
    for (const status of ["discovering", "authorizing", "validating"]) {
      expect(isWaitingHandoffStatus(status)).toBe(true);
      expect(isTerminalHandoffStatus(status)).toBe(false);
    }
  });

  it("treats the two statuses that need the user as neither", () => {
    // `awaiting_project` and `awaiting_authorization` are the only ones where
    // the page shows a control. If either were classed as waiting, the user
    // would watch a spinner for something only they can do.
    for (const status of ["awaiting_project", "awaiting_authorization"]) {
      expect(isWaitingHandoffStatus(status)).toBe(false);
      expect(isTerminalHandoffStatus(status)).toBe(false);
    }
  });
});
