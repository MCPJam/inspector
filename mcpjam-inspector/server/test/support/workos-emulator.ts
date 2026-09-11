/**
 * Boots `@workos/emulate` in-process so a suite can drive the server's real
 * WorkOS paths — the AuthKit proxy, `sk_` key validation, key management —
 * against an API instead of a `vi.stubGlobal("fetch", ...)` matcher.
 *
 * The existing suites stub fetch by pathname and mock `verifyAuthKitToken`, so
 * they assert our own beliefs: that WorkOS 409s a duplicate, that a reused
 * refresh token is refused, that a JWT signed by the right key verifies. The
 * emulator settles those by answering, and it signs real RS256 tokens against
 * a JWKS endpoint our verifier can actually fetch.
 *
 * Lifecycle: one emulator per test FILE, port 0, `beforeAll`/`afterAll`.
 * Vitest's forks pool gives each file its own process, which keeps ports from
 * colliding across the six CI shards and contains the global `Request`/
 * `Response` objects that `@hono/node-server` replaces when imported — a
 * mutation this repo already warns about in
 * `server/routes/web/__tests__/fixtures/xaa-node-adapter.ts`.
 */
import {
  createEmulator,
  type Emulator,
  type EmulatorSeedConfig,
} from "@workos/emulate";
import { createHash, randomBytes } from "node:crypto";
import { vi } from "vitest";
import { resetAuthKitJwksCacheForTests } from "../../services/authkit-jwt.js";
import { resetWorkOSClientForTests } from "../../services/workos-client.js";

const MINIMUM_NODE = { major: 22, minor: 11 };

export const EMULATOR_CLIENT_ID = "client_01EMULATOR0000000000000000";

/**
 * Fixed ids so assertions can name them.
 *
 * `SEED.user.id` doubles as the WorkOS `sub`, which the bearer middleware
 * stores as `workosUserId` and the key routes interpolate into
 * `/user_management/users/{id}/api_keys`.
 */
export const SEED = {
  user: {
    id: "user_01EMULATORUSER00000000000000",
    email: "dev@emulator.test",
    password: "test123",
  },
  org: {
    id: "org_01EMULATORORG000000000000000",
    name: "Emulator Org",
  },
} as const;

export function emulatorSeed(): EmulatorSeedConfig {
  return {
    users: [
      {
        id: SEED.user.id,
        email: SEED.user.email,
        first_name: "Dev",
        password: SEED.user.password,
        email_verified: true,
      },
    ],
    organizations: [
      {
        id: SEED.org.id,
        name: SEED.org.name,
        memberships: [{ email: SEED.user.email }],
      },
    ],
  };
}

export interface WorkosEmulatorHandle {
  emulator: Emulator;
  url: string;
  apiKey: string;
  clientId: string;
  close: () => Promise<void>;
}

function assertNodeVersion(): void {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (
    major < MINIMUM_NODE.major ||
    (major === MINIMUM_NODE.major && minor < MINIMUM_NODE.minor)
  ) {
    throw new Error(
      `@workos/emulate requires Node >= ${MINIMUM_NODE.major}.${MINIMUM_NODE.minor} ` +
        `(running ${process.versions.node}). CI runs 24.x; upgrade your local Node to run these suites.`,
    );
  }
}

export async function startWorkosEmulator(opts?: {
  seed?: EmulatorSeedConfig;
  clientId?: string;
}): Promise<WorkosEmulatorHandle> {
  assertNodeVersion();
  const clientId = opts?.clientId ?? EMULATOR_CLIENT_ID;

  const emulator = await createEmulator({
    port: 0,
    hostname: "127.0.0.1",
    seed: opts?.seed ?? emulatorSeed(),
    // Tokens then carry `iss = https://api.workos.com/user_management/<id>`,
    // which is already an entry in `authkitIssuerJwks`'s trusted map. Only the
    // JWKS URL follows the base — so this exercises the real issuer allow-list
    // rather than widening it for the test.
    issuer: "https://api.workos.com",
    allowedRedirectHosts: ["localhost", "127.0.0.1"],
  });

  vi.stubEnv("WORKOS_API_KEY", emulator.apiKey);
  vi.stubEnv("WORKOS_API_BASE_URL", emulator.url);
  vi.stubEnv("WORKOS_CLIENT_ID", clientId);
  vi.stubEnv("MCPJAM_WORKOS_SESSION_SECRET", "test-workos-session-secret");
  // Both are module-level singletons that would otherwise hold a client (and a
  // JWKS) pointed at whatever the previous file configured.
  resetWorkOSClientForTests();
  resetAuthKitJwksCacheForTests();

  return {
    emulator,
    url: emulator.url,
    apiKey: emulator.apiKey,
    clientId,
    close: async () => {
      await emulator.close();
      vi.unstubAllEnvs();
      resetWorkOSClientForTests();
      resetAuthKitJwksCacheForTests();
    },
  };
}

/** Admin-key request straight at the emulator, for arrange/assert steps. */
export async function emulatorRest(
  h: WorkosEmulatorHandle,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${h.url}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${h.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await response.json();
  } catch {
    // 204s carry no body.
  }
  return { status: response.status, body: parsed };
}

export async function mintUserApiKey(
  h: WorkosEmulatorHandle,
  args: { userId: string; organizationId: string; name?: string },
): Promise<{ id: string; value: string }> {
  const { status, body } = await emulatorRest(
    h,
    "POST",
    `/user_management/users/${encodeURIComponent(args.userId)}/api_keys`,
    { name: args.name ?? "test key", organization_id: args.organizationId },
  );
  if (status >= 300) {
    throw new Error(
      `Could not mint an API key (${status}): ${JSON.stringify(body)}`,
    );
  }
  return { id: body.id, value: body.value };
}

export async function listUserApiKeys(
  h: WorkosEmulatorHandle,
  userId: string,
): Promise<Array<{ id: string }>> {
  const { body } = await emulatorRest(
    h,
    "GET",
    `/user_management/users/${encodeURIComponent(userId)}/api_keys?limit=100`,
  );
  return Array.isArray(body?.data) ? body.data : [];
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * The real front-channel: authorize with PKCE, follow the redirect for the
 * code, exchange it. Returns a genuinely signed access token, so a route that
 * verifies one is exercised rather than mocked.
 */
export async function loginWithPkce(
  h: WorkosEmulatorHandle,
  args: { email: string; redirectUri?: string; state?: string },
): Promise<{
  accessToken: string;
  refreshToken: string;
  code: string;
  user: any;
}> {
  const redirectUri = args.redirectUri ?? "http://localhost:6274/callback";
  const { verifier, challenge } = createPkcePair();
  const query = new URLSearchParams({
    client_id: h.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    provider: "authkit",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: args.state ?? "test-state",
    login_hint: args.email,
  });

  const authorize = await fetch(
    `${h.url}/user_management/authorize?${query.toString()}`,
    { redirect: "manual" },
  );
  const location = authorize.headers.get("location");
  if (!location) {
    throw new Error(
      `authorize did not redirect (${authorize.status}): ${await authorize.text()}`,
    );
  }
  const code = new URL(location).searchParams.get("code");
  if (!code) throw new Error(`authorize redirect carried no code: ${location}`);

  const exchange = await fetch(`${h.url}/user_management/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: h.clientId,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    }),
  });
  const body = await exchange.json();
  if (!exchange.ok) {
    throw new Error(
      `code exchange failed (${exchange.status}): ${JSON.stringify(body)}`,
    );
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    code,
    user: body.user,
  };
}

/**
 * The ONE `Set-Cookie` header carrying `name`, with its own attributes.
 *
 * `headers.get("set-cookie")` joins every cookie into one string, so asserting
 * `HttpOnly` against that says only that SOME cookie in the response has it.
 * Mirrors the helper in server/routes/__tests__/workos-authkit.test.ts.
 */
export function setCookieFor(response: Response, name: string): string {
  const entry = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`));
  if (!entry) throw new Error(`Missing Set-Cookie for ${name}`);
  return entry;
}

/** `name=value` pairs joined for a `Cookie` request header. */
export function cookieHeaderFrom(response: Response, names: string[]): string {
  return names
    .map((name) => {
      const entry = response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith(`${name}=`));
      return entry ? entry.split(";")[0] : null;
    })
    .filter((pair): pair is string => Boolean(pair))
    .join("; ");
}
