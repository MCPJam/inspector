import { act, renderHook, waitFor } from "@testing-library/react";
import { AuthKitProvider } from "@workos-inc/authkit-react";
import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useUnifiedConvexAuth } from "../unified-convex-auth";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

/**
 * Drives the real `@workos-inc/authkit-react` provider against a `fetch` that
 * answers as WorkOS, instead of mocking `useAuth`.
 *
 * `fetchTokenWithRetry` tells a dead session from a transient failure by the
 * error authkit throws, and `isLoginRequiredError` recognizes that error by
 * its message alone. Every other suite on this path mocks the library, so an
 * authkit release that reworded the message or stopped throwing it from
 * `getAccessToken` would leave them green while every dead session burned
 * the full retry ladder and raised the wrong banner (INSPECTOR-CLIENT-27D).
 * This suite fails instead.
 *
 * The server's `*.emulator.test.ts` suites play the same role with
 * `@workos/emulate`. There is no browser build of that emulator, and the
 * contract under test here is the SDK's, so a scripted
 * `/user_management/authenticate` is the whole of WorkOS this needs.
 */

const mockState = vi.hoisted(() => ({ reportCaught: vi.fn() }));

vi.mock("@/lib/error-reporting", () => ({
  reportCaught: mockState.reportCaught,
}));

// Inert. A signed-in WorkOS user never reaches the guest branch, and while
// the provider is still loading the guest effect returns before calling any
// of these.
vi.mock("@/lib/guest-session", () => ({
  getCachedGuestSession: () => null,
  getOrCreateGuestSessionOrThrow: vi.fn(),
  forceRefreshGuestSessionOrThrow: vi.fn(),
  markGuestActivated: vi.fn(),
  getGuestSessionRefusal: () => null,
}));

const CLIENT_ID = "client_01CONTRACT0000000000000000";
const AUTH_HOST = "auth.contract.test";
const USER_ID = "user_01CONTRACT00000000000000000";

function base64url(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Unsigned on purpose: authkit decodes the payload and never verifies it.
 * `exp - iat` is what it stores as the session's lifetime.
 */
function accessToken(sid: string, lifetimeSeconds: number): string {
  const iat = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: "RS256", typ: "JWT" }),
    base64url({ sub: USER_ID, sid, iat, exp: iat + lifetimeSeconds }),
    "signature",
  ].join(".");
}

/**
 * Shorter than authkit's default 10 s refresh buffer, so the very next
 * `getAccessToken()` has to refresh, while the token itself is still valid.
 */
const DUE_FOR_REFRESH_SECONDS = 5;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authenticated(token: string): Response {
  return json({
    user: {
      object: "user",
      id: USER_ID,
      email: "dev@contract.test",
      email_verified: true,
      first_name: "Dev",
      last_name: "Contract",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    access_token: token,
    refresh_token: "rt_contract",
    organization_id: null,
    authentication_method: "Password",
  });
}

function refused(): Response {
  return json(
    {
      error: "invalid_grant",
      error_description: "The refresh token has been revoked.",
    },
    400,
  );
}

type Answer = () => Response | Promise<Response>;
let answers: Answer[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    url.host !== AUTH_HOST ||
    url.pathname !== "/user_management/authenticate"
  ) {
    throw new Error(`Unexpected request: ${url.href}`);
  }
  const answer = answers.shift();
  if (!answer) throw new Error("No WorkOS answer scripted for this refresh");
  return answer();
});

function wrapper({ children }: { children: ReactNode }) {
  // Cookie mode and an explicit API host, as `app-bootstrap.tsx` configures it.
  return (
    <AuthKitProvider
      clientId={CLIENT_ID}
      apiHostname={AUTH_HOST}
      devMode={false}
      redirectUri="http://localhost:3000/callback"
    >
      {children}
    </AuthKitProvider>
  );
}

/** Boots the provider through one successful refresh, as a returning tab does. */
async function mountSignedIn(token: string) {
  answers.push(() => authenticated(token));
  const rendered = renderHook(() => useUnifiedConvexAuth(), { wrapper });
  // The boot refresh takes a vendor-lock round trip; allow for a slow shard.
  await waitFor(
    () => {
      expect(rendered.result.current.user).toMatchObject({ id: USER_ID });
    },
    { timeout: 5_000 },
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  return rendered;
}

describe("useUnifiedConvexAuth against the real authkit provider", () => {
  beforeAll(() => {
    // authkit refreshes on its own every second while the document is
    // visible. That would consume a scripted answer mid-test, so the suite
    // runs as a background tab would.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(document, "hidden");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    answers = [];
    vi.stubGlobal("fetch", fetchMock);
    // authkit logs every failed refresh at debug level. These are scripted.
    vi.spyOn(console, "debug").mockImplementation(() => {});
    // `initialize()` makes no request at all without this cookie.
    document.cookie = "workos-has-session=1";
    useSessionRefreshStore.setState({
      status: "idle",
      kind: null,
      retryNonce: 0,
      queriesPaused: false,
    });
  });

  afterEach(() => {
    // Every scripted answer must have been asked for, or the scenario that ran
    // is not the one the test describes.
    expect(answers).toEqual([]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.cookie =
      "workos-has-session=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });

  it("ends the session on a refused refresh without running the retry ladder", async () => {
    const { result } = await mountSignedIn(
      accessToken("sid_1", DUE_FOR_REFRESH_SECONDS),
    );
    answers.push(refused);

    let token: string | null = "unset";
    await act(async () => {
      token = await result.current.getAccessToken();
    });

    expect(token).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // These two carry the claim in the title. A ladder that ran would report
    // its exhaustion and label the failure transient; authkit answers every
    // attempt after the refusal from memory, so the request count alone
    // cannot tell the two apart.
    expect(mockState.reportCaught).not.toHaveBeenCalled();
    expect(useSessionRefreshStore.getState()).toMatchObject({
      status: "failed",
      kind: "signed_out",
    });

    // authkit has wiped the session and latched: the next ask throws without
    // a request, and that still reads as the same sign-out, not a fault.
    await act(async () => {
      token = await result.current.getAccessToken();
    });
    expect(token).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockState.reportCaught).not.toHaveBeenCalled();
  });

  it("retries a refresh the network dropped and returns the renewed token", async () => {
    const { result } = await mountSignedIn(
      accessToken("sid_1", DUE_FOR_REFRESH_SECONDS),
    );
    const renewed = accessToken("sid_2", 3600);
    answers.push(
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => authenticated(renewed),
    );

    let token: string | null = null;
    await act(async () => {
      token = await result.current.getAccessToken();
    });

    expect(token).toBe(renewed);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mockState.reportCaught).not.toHaveBeenCalled();
    expect(useSessionRefreshStore.getState()).toMatchObject({
      status: "idle",
      kind: null,
    });
  });

  it("gets the still-valid token back when WorkOS answers a refresh with 503", async () => {
    // authkit absorbs a retryable status while the current token is unexpired,
    // so the ladder never sees this one. Pinned so that a change here shows up
    // as a failed test rather than as an unexplained shift in retry counts.
    const current = accessToken("sid_1", DUE_FOR_REFRESH_SECONDS);
    const { result } = await mountSignedIn(current);
    answers.push(() =>
      json({ error: "server_error", error_description: "Try again." }, 503),
    );

    let token: string | null = null;
    await act(async () => {
      token = await result.current.getAccessToken();
    });

    expect(token).toBe(current);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockState.reportCaught).not.toHaveBeenCalled();
    expect(useSessionRefreshStore.getState()).toMatchObject({
      status: "idle",
      kind: null,
    });
  });
});
