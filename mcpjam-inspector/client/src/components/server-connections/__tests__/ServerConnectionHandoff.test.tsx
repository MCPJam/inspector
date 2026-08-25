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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const authkit = vi.hoisted(() => ({
  isLoading: false,
  getAccessToken: vi.fn(async (): Promise<string | undefined> => undefined),
  signIn: vi.fn(async () => undefined),
  signOut: vi.fn(async () => undefined),
  user: null as { email?: string } | null,
}));

// The page is mounted inside <AuthKitProvider> by `main.tsx`; the hook is the
// only part of it this component touches.
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    isLoading: authkit.isLoading,
    getAccessToken: authkit.getAccessToken,
    signIn: authkit.signIn,
    signOut: authkit.signOut,
    user: authkit.user,
  }),
}));

import { ServerConnectionHandoff } from "../ServerConnectionHandoff";
import {
  clearPendingAuthorization,
  readPendingAuthorization,
  rememberPendingAuthorization,
  takeHandoffSignInReturn,
} from "@/lib/server-connection-handoff";

const ORIGIN = "https://app.mcpjam.test";
// Carries the `state` the marker binds to; the callbacks below return it.
const AUTH_URL = "https://auth.example.com/authorize?client_id=c&state=st";

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
    },
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

    // Located by path, not by index: the claim is now preceded by a
    // best-effort token exchange that proves who the visitor is, and which
    // call lands first is not the property this test is about.
    expect(calls.find((call) => call.path === "/claim")).toEqual({
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
          }),
      ),
    );
    goTo("/connect/server/dead-token");

    render(<ServerConnectionHandoff />);

    expect(
      await screen.findByText("That link has expired."),
    ).toBeInTheDocument();
  });
});

describe("what the page shows", () => {
  it("renders only the redacted url, never an operational one", async () => {
    // `serverUrl` is NOT part of the handoff payload — the backend deliberately
    // sends `displayUrl` instead, because a keyed endpoint's query IS the
    // credential. Feeding one in anyway is the regression this guards: if
    // someone widens the state interface and renders it, the secret appears on
    // screen and nothing else would notice.
    mockApi({
      "/state": () =>
        stateBody({
          serverUrl: "https://target.example.com/mcp?key=sk-live-99",
        }),
    });
    goTo("/connect/server/request/scr_1");

    const { container } = render(<ServerConnectionHandoff />);
    await screen.findByText("Personal");

    expect(
      screen.getByText("https://target.example.com/mcp?key=REDACTED"),
    ).toBeInTheDocument();
    expect(container.textContent).toContain("query parameters");
    expect(container.textContent).not.toContain("sk-live-99");
  });

  it("offers a retry when the backend says the failure may clear", async () => {
    mockApi({
      "/state": () =>
        stateBody({
          status: "failed",
          errorMessage: "That server was unreachable.",
          errorRetryable: true,
        }),
    });
    goTo("/connect/server/request/scr_1");

    const { container } = render(<ServerConnectionHandoff />);
    await screen.findByText("That server was unreachable.");

    expect(container.textContent).toContain("may work");
  });

  it("withholds it when the backend says the failure will not", async () => {
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

    // `errorRetryable` is the backend's judgement, and both directions have to
    // be pinned: a page that always shows the hint, or never does, passes a
    // one-sided test either way.
    expect(container.textContent).not.toContain("may work");
  });

  it("shows the cancelled state without a call it cannot authenticate", async () => {
    const calls = mockApi({
      "/state": () => stateBody(),
      "/cancel": () => ({ status: "cancelled" }),
    });
    goTo("/connect/server/request/scr_1");

    render(<ServerConnectionHandoff />);
    fireEvent.click(await screen.findByText("Cancel this request"));

    await waitFor(() =>
      expect(screen.queryByText("Cancel this request")).not.toBeInTheDocument(),
    );
    // `/cancel` clears the continuation cookie — that is the point. A follow-up
    // `/state` would have nothing to authenticate with, come back 401, and show
    // an error for an action that worked.
    expect(calls.filter((c) => c.path === "/state")).toHaveLength(1);
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
        calls.filter((c) => c.path === "/state").length,
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
    rememberPendingAuthorization("scr_1", AUTH_URL);
    goTo("/oauth/callback", "?code=auth-code&state=st&iss=https://as.example");

    render(<ServerConnectionHandoff />);

    await waitFor(() =>
      expect(
        calls.find((call) => call.path === "/authorize/complete"),
      ).toBeDefined(),
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
      expect(window.location.pathname).toBe("/connect/server/request/scr_1"),
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
    rememberPendingAuthorization("scr_1", AUTH_URL);
    goTo(
      "/oauth/callback",
      "?error=access_denied&error_description=User+declined&state=st",
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

describe("proving who the visitor is", () => {
  /**
   * The claim is the ONLY call that carries identity, and it has to: the
   * backend refuses an account-owned link to anyone but its owner, and this
   * page used to send no credential at all. The check therefore compared
   * "nobody" against an owner and refused every account-owned link, which made
   * the whole OAuth path unusable for signed-in users.
   */
  function mockWithHeaders() {
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(
          (init?.headers ?? undefined) as HeadersInit | undefined,
        );
        seen.push({ url, auth: headers.get("authorization") });
        const path = url.replace("/api/web/server-connections", "");
        if (path === "/claim") {
          return new Response(
            JSON.stringify({ requestId: "scr_1", status: "awaiting_project" }),
            { status: 200 },
          );
        }
        if (path === "/state") {
          return new Response(JSON.stringify(stateBody()), { status: 200 });
        }
        return new Response(JSON.stringify({ message: "unhandled" }), {
          status: 500,
        });
      }),
    );
    return seen;
  }

  it("sends the signed-in visitor's token, so the owner can claim their own link", async () => {
    authkit.getAccessToken.mockResolvedValueOnce("access-token-value");
    const seen = mockWithHeaders();
    goTo("/connect/server/handoff-token-abc");

    render(<ServerConnectionHandoff />);
    await screen.findByText("Personal");

    const claim = seen.find((entry) => entry.url.endsWith("/claim"));
    expect(claim?.auth).toBe("Bearer access-token-value");
  });

  it("WAITS for AuthKit before claiming, so a signed-in owner is not told to sign in", async () => {
    // The bug this pins, and it looped rather than merely failing.
    //
    // `AuthKitProvider` swaps `getAccessToken` when its client finishes
    // initializing; before that it is `() => Promise.reject(LoginRequiredError)`.
    // Claiming during that window sent no bearer, so the backend saw an
    // anonymous caller and refused SIGN_IN_REQUIRED — and signing in returns
    // instantly for someone who already has a session, landing back on the same
    // URL to lose the same race again. Every cold load of a handoff link is the
    // case that loses it.
    authkit.isLoading = true;
    authkit.getAccessToken.mockRejectedValue(new Error("Login required"));
    const seen = mockWithHeaders();
    goTo("/connect/server/handoff-token-abc");

    const view = render(<ServerConnectionHandoff />);
    // Nothing claimed yet: the page has no identity to claim WITH.
    await act(async () => {
      await Promise.resolve();
    });
    expect(seen.some((entry) => entry.url.endsWith("/claim"))).toBe(false);

    // AuthKit finishes; now the token is real and the claim carries it.
    authkit.isLoading = false;
    authkit.getAccessToken.mockReset();
    authkit.getAccessToken.mockResolvedValue("access-token-value");
    view.rerender(<ServerConnectionHandoff />);
    await screen.findByText("Personal");

    const claim = seen.find((entry) => entry.url.endsWith("/claim"));
    expect(claim?.auth).toBe("Bearer access-token-value");
  });

  it("still claims when the session refresh throws, so guests keep working", async () => {
    // Possession of the single-use token remains the capability for a
    // guest-owned request; a failed exchange must never block that.
    authkit.getAccessToken.mockRejectedValueOnce(new Error("no session"));
    const seen = mockWithHeaders();
    goTo("/connect/server/handoff-token-abc");

    render(<ServerConnectionHandoff />);
    await screen.findByText("Personal");

    const claim = seen.find((entry) => entry.url.endsWith("/claim"));
    expect(claim).toBeDefined();
    expect(claim?.auth).toBeNull();
  });

  it("still claims when there is no session at all", async () => {
    authkit.getAccessToken.mockResolvedValueOnce(undefined);
    const seen = mockWithHeaders();
    goTo("/connect/server/handoff-token-abc");

    render(<ServerConnectionHandoff />);
    await screen.findByText("Personal");

    expect(seen.find((entry) => entry.url.endsWith("/claim"))?.auth).toBeNull();
  });
});

/**
 * A claim refused because of WHO is asking.
 *
 * This is the one failure on this page the user can act on, and it used to
 * render as a dead end reading "This authorization link belongs to a different
 * account" — for signed-out visitors too, for whom it was simply false. What
 * is pinned here is that each reason gets the action that resolves IT, and
 * that both screens say the link survives, because it does.
 */
function refuseClaim(details: unknown, message = "Refused.") {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ message, details }), { status: 403 }),
    ),
  );
}

describe("a refused claim", () => {
  afterEach(() => {
    authkit.user = null;
  });

  it("asks a signed-out visitor to sign in, and says the link survives", async () => {
    refuseClaim({ reason: "sign-in-required" });
    goTo("/connect/server/handoff-token-abc");

    render(<ServerConnectionHandoff />);
    await screen.findByText("Sign in to finish connecting");

    // NOT "belongs to a different account" — that was the false half of the
    // old single message, and it is what sent people looking for a problem
    // they did not have.
    expect(screen.queryByText(/different account/i)).toBeNull();
    expect(screen.getByText(/still valid/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("names both accounts on a real mismatch", async () => {
    authkit.user = { email: "someone@gmail.com" };
    refuseClaim({ reason: "account-mismatch", ownerHint: "m•••@mcpjam.com" });
    goTo("/connect/server/handoff-token-abc");

    render(<ServerConnectionHandoff />);
    await screen.findByText("This link belongs to a different account");

    // Which account you ARE and which one you NEED. Neither was on screen
    // before, which is what made this unactionable.
    expect(screen.getByText("someone@gmail.com")).toBeTruthy();
    expect(screen.getByText(/m•••@mcpjam\.com/)).toBeTruthy();
    // The CLI is where these links come from, and an agent driving it cannot
    // see which account it is acting as.
    expect(screen.getByText(/mcpjam whoami/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch account" })).toBeTruthy();
  });

  it("still reads without an owner hint", async () => {
    refuseClaim({ reason: "account-mismatch" });
    goTo("/connect/server/handoff-token-abc");

    render(<ServerConnectionHandoff />);
    await screen.findByText("This link belongs to a different account");

    // A guest-owned request, or an account with no address on file. The
    // sentence has to survive the missing half rather than print `undefined`.
    expect(screen.queryByText(/undefined/)).toBeNull();
    expect(screen.getByText(/a different MCPJam account/)).toBeTruthy();
  });

  it("sends the sign-in back to this link, carrying only a nonce", async () => {
    refuseClaim({ reason: "sign-in-required" });
    goTo("/connect/server/handoff-token-abc");

    render(<ServerConnectionHandoff />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(authkit.signIn).toHaveBeenCalled());
    const state = authkit.signIn.mock.calls[0]?.[0]?.state as
      | Record<string, unknown>
      | undefined;
    const nonce = state?.mcpjamHandoffReturn;
    expect(typeof nonce).toBe("string");
    // AuthKit round-trips `state` through WorkOS, into a redirect URL and this
    // browser's history. The handoff token must be in none of those.
    expect(JSON.stringify(state)).not.toContain("handoff-token-abc");
    // The path itself stayed in same-origin storage.
    expect(takeHandoffSignInReturn(nonce, window.location.origin)).toBe(
      "/connect/server/handoff-token-abc",
    );
  });

  it("falls back to plain prose when the backend sent no reason", async () => {
    // A backend that predates the split answers a wrong-account claim with a
    // bare FORBIDDEN. Guessing a reason would offer a signed-out visitor the
    // switch-accounts flow.
    refuseClaim(undefined, "This link cannot be used right now.");
    goTo("/connect/server/handoff-token-abc");

    render(<ServerConnectionHandoff />);
    await screen.findByText("This link cannot be used");

    expect(
      screen.getByText("This link cannot be used right now."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
});
