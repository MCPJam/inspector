/**
 * The handoff page.
 *
 * What is pinned here is the handling of the two values that must not linger:
 * the single-use handoff token, which has to leave the address bar the moment
 * it is spent, and the marker written before the OAuth redirect, which has to
 * be cleared the moment the callback is consumed. Both failures are invisible
 * in a working flow — the page looks identical either way — and both leave a
 * live artifact behind: a token in `history` that a share or a `Referer` can
 * carry, and a marker that hijacks the next unrelated `/oauth/callback` in the
 * same tab.
 *
 * The polling rule is here for the same reason: the page must stop asking on
 * every status the user has to act on, or it renders a spinner over a button
 * only they can press.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ServerConnectionHandoff } from "../ServerConnectionHandoff";
import {
  clearPendingAuthorization,
  readPendingAuthorization,
  rememberPendingAuthorization,
} from "@/lib/server-connection-handoff";

const ORIGIN = "https://app.mcpjam.test";

function stateBody(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "scr_1",
    status: "awaiting_project",
    live: true,
    displayUrl: "https://target.example.com/mcp?key=REDACTED",
    hasQuery: true,
    requestedName: "Target",
    serverName: null,
    isGuestOwner: false,
    errorCode: null,
    errorMessage: null,
    errorRetryable: null,
    projects: [{ id: "proj_1", name: "Personal" }],
    ...overrides,
  };
}

/** Routes by path so a test can assert what was called without caring about
 * the order the component happens to call things in. */
function mockApi(handlers: Record<string, () => unknown>) {
  const calls: Array<{ path: string; body: unknown }> = [];
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).replace("/api/web/server-connections", "");
      calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const handler = handlers[path];
      if (!handler) {
        return new Response(JSON.stringify({ message: "unhandled" }), {
          status: 500,
        });
      }
      return new Response(JSON.stringify(handler()), { status: 200 });
    }
  );
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function goTo(path: string, search = "") {
  window.history.replaceState({}, "", `${path}${search}`);
}

// `window.location` is deliberately NOT stubbed. The component reads
// `pathname` and `search` from it, and those are accessors — a stub built by
// spreading the real location silently drops them, which makes every route
// look like "no route" and the page quietly falls through to a plain state
// fetch. Nothing below triggers a navigation, so the real object is fine.

afterEach(() => {
  clearPendingAuthorization();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  goTo("/");
});

describe("the claim", () => {
  it("spends the token and takes it out of the address bar", async () => {
    const calls = mockApi({
      "/claim": () => ({ requestId: "scr_1", status: "awaiting_project" }),
      "/state": () => stateBody(),
    });
    goTo("/connect/server/handoff-token-abc");

    render(<ServerConnectionHandoff />);
    await screen.findByText("Personal");

    expect(calls[0]).toEqual({
      path: "/claim",
      body: { handoffToken: "handoff-token-abc" },
    });
    // The token is single-use and must not survive in a URL that a share, a
    // bookmark, or a `Referer` header could carry onward.
    expect(window.location.pathname).toBe("/connect/server/request/scr_1");
    expect(window.location.href).not.toContain("handoff-token-abc");
  });

  it("does not re-claim when the page is already on a request path", async () => {
    const calls = mockApi({ "/state": () => stateBody() });
    goTo("/connect/server/request/scr_1");

    render(<ServerConnectionHandoff />);
    await screen.findByText("Personal");

    expect(calls.some((call) => call.path === "/claim")).toBe(false);
  });

  it("says the link is unusable rather than showing an empty page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "That link has expired." }), {
            status: 404,
          })
      )
    );
    goTo("/connect/server/dead-token");

    render(<ServerConnectionHandoff />);

    expect(
      await screen.findByText("That link has expired.")
    ).toBeInTheDocument();
  });
});

describe("what the page shows", () => {
  it("shows the redacted url and warns about the query without revealing it", async () => {
    mockApi({ "/state": () => stateBody() });
    goTo("/connect/server/request/scr_1");

    const { container } = render(<ServerConnectionHandoff />);
    await screen.findByText("Personal");

    expect(
      screen.getByText("https://target.example.com/mcp?key=REDACTED")
    ).toBeInTheDocument();
    expect(container.textContent).toContain("query parameters");
    // The whole reason `displayUrl` exists: a keyed endpoint's query IS the
    // credential, so the page tells the user it is there without showing it.
    expect(container.textContent).not.toContain("secret");
  });

  it("offers a retry only when the backend says the failure may clear", async () => {
    mockApi({
      "/state": () =>
        stateBody({
          status: "failed",
          errorMessage: "That address is not allowed.",
          errorRetryable: false,
        }),
    });
    goTo("/connect/server/request/scr_1");

    const { container } = render(<ServerConnectionHandoff />);
    await screen.findByText("That address is not allowed.");

    // `errorRetryable` is the backend's judgement. Offering "try again" for a
    // refusal that will never clear wastes the user's time and misdescribes
    // what happened.
    expect(container.textContent).not.toContain("may work");
  });
});

describe("polling", () => {
  /**
   * Advance fake timers INSIDE `act`.
   *
   * Without it React never flushes the state update that the poll effect
   * depends on, so no interval is ever created — and a "does not poll" test
   * passes without exercising anything. Both cases below have to share this,
   * or the negative one proves nothing.
   */
  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("stops asking on a status only the user can advance", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockApi({ "/state": () => stateBody() });
      goTo("/connect/server/request/scr_1");

      render(<ServerConnectionHandoff />);
      await tick(0);
      expect(calls.filter((c) => c.path === "/state")).toHaveLength(1);
      expect(screen.getByText("Personal")).toBeInTheDocument();

      await tick(10_000);

      // `awaiting_project` waits on a click, not on a worker. Polling through
      // it would put a spinner over the only control that can move it.
      expect(calls.filter((c) => c.path === "/state")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps asking while a worker owns the step", async () => {
    vi.useFakeTimers();
    try {
      const calls = mockApi({
        "/state": () => stateBody({ status: "validating" }),
      });
      goTo("/connect/server/request/scr_1");

      render(<ServerConnectionHandoff />);
      await tick(0);
      expect(screen.getByText("Verifying the connection…")).toBeInTheDocument();

      await tick(6_000);

      expect(
        calls.filter((c) => c.path === "/state").length
      ).toBeGreaterThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("returning from the authorization server", () => {
  it("posts the callback and clears the marker", async () => {
    const calls = mockApi({
      "/authorize/complete": () => ({
        requestId: "scr_1",
        status: "validating",
      }),
      "/state": () => stateBody({ status: "validating" }),
    });
    rememberPendingAuthorization("scr_1");
    goTo("/oauth/callback", "?code=auth-code&state=st&iss=https://as.example");

    render(<ServerConnectionHandoff />);

    await waitFor(() =>
      expect(
        calls.find((call) => call.path === "/authorize/complete")
      ).toBeDefined()
    );
    expect(calls.find((c) => c.path === "/authorize/complete")?.body).toEqual({
      state: "st",
      code: "auth-code",
      iss: "https://as.example",
      errorDescription: undefined,
      error: undefined,
    });
    // A marker that survived would claim the next unrelated `/oauth/callback`
    // in this tab — including one belonging to the Inspector's own OAuth flow.
    expect(readPendingAuthorization()).toBeNull();
    await waitFor(() =>
      expect(window.location.pathname).toBe("/connect/server/request/scr_1")
    );
  });

  it("carries a denial through as an ordinary answer", async () => {
    const calls = mockApi({
      "/authorize/complete": () => ({
        requestId: "scr_1",
        status: "awaiting_authorization",
      }),
      "/state": () => stateBody({ status: "awaiting_authorization" }),
    });
    rememberPendingAuthorization("scr_1");
    goTo(
      "/oauth/callback",
      "?error=access_denied&error_description=User+declined&state=st"
    );

    render(<ServerConnectionHandoff />);

    // Declining consent leaves the request alive with attempts remaining, so
    // the page comes back offering the button rather than an error.
    expect(await screen.findByText("Authorize")).toBeInTheDocument();
    expect(calls.find((c) => c.path === "/authorize/complete")?.body).toEqual({
      state: "st",
      code: undefined,
      iss: undefined,
      error: "access_denied",
      errorDescription: "User declined",
    });
  });
});
