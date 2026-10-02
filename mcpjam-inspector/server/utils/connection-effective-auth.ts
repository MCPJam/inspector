/**
 * Each live connection's effective auth method, and the server-side stamp
 * that puts it on a sign-in challenge.
 *
 * WHY THE SERVER STAMPS IT. Whether a mid-session sign-in challenge may start
 * OAuth depends on how the server is configured to authenticate: a tokenless
 * Auto server may, a `none`, `bearer` or `xaa` server may not. The browser
 * cannot compute that: Auto resolves to XAA under an organization policy the
 * browser never sees. So the server that ran the call records the method at
 * connect time and stamps it onto every challenge it returns, and the client
 * gates on that stamp alone, never on its own parse of a result.
 */

import {
  extractAuthChallenge,
  parseToolResultAuthChallenge,
  type AuthChallengeEffectiveAuth,
  type AuthChallengeSignal,
  type ToolSecuritySchemeResolution,
} from "@mcpjam/sdk";

const byManager = new WeakMap<object, Map<string, AuthChallengeEffectiveAuth>>();

/** Record the method a connection was established with. */
export function recordConnectionEffectiveAuth(
  manager: object,
  serverKey: string,
  effectiveAuth: AuthChallengeEffectiveAuth,
): void {
  let entries = byManager.get(manager);
  if (!entries) {
    entries = new Map();
    byManager.set(manager, entries);
  }
  entries.set(serverKey, effectiveAuth);
}

/** The recorded method, or `undefined` when this connection never recorded one. */
export function connectionEffectiveAuth(
  manager: object | undefined,
  serverKey: string | undefined,
): AuthChallengeEffectiveAuth | undefined {
  if (!manager || !serverKey) return undefined;
  return byManager.get(manager)?.get(serverKey);
}

export function stampAuthChallenge(
  challenge: AuthChallengeSignal,
  effectiveAuth: AuthChallengeEffectiveAuth | undefined,
): AuthChallengeSignal {
  const { effectiveAuth: _ignored, ...rest } = challenge;
  return effectiveAuth ? { ...rest, effectiveAuth } : rest;
}

const STAMPED = Symbol.for("mcpjam.stampedAuthChallenge");

/**
 * Put the stamped challenge on a failed call's error, so the route's error
 * mapping (which has no server context) can report it. No-op when the error
 * carries no challenge.
 */
export function stampErrorAuthChallenge(
  error: unknown,
  effectiveAuth: AuthChallengeEffectiveAuth | undefined,
): void {
  if (!error || typeof error !== "object") return;
  const challenge = extractAuthChallenge(error);
  if (!challenge) return;
  try {
    Object.defineProperty(error, STAMPED, {
      value: stampAuthChallenge(challenge, effectiveAuth),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // A frozen error keeps its unstamped challenge.
  }
}

/** The challenge a failed call carries, stamped when the route stamped it. */
export function readAuthChallenge(
  error: unknown,
): AuthChallengeSignal | undefined {
  if (error && typeof error === "object") {
    const stamped = (error as Record<symbol, unknown>)[STAMPED];
    if (stamped) return stamped as AuthChallengeSignal;
  }
  return extractAuthChallenge(error);
}

/**
 * The server-owned envelope for a COMPLETED tool call: the parsed `_meta`
 * challenge, stamped, or `undefined`. Returned beside the result, which is
 * left unchanged.
 */
export function toolResultAuthChallengeEnvelope(
  result: unknown,
  effectiveAuth: AuthChallengeEffectiveAuth | undefined,
): AuthChallengeSignal | undefined {
  const challenge = parseToolResultAuthChallenge(result);
  return challenge ? stampAuthChallenge(challenge, effectiveAuth) : undefined;
}

type SchemeSource = {
  getToolSecuritySchemes?: (
    serverId: string,
    toolName: string,
  ) => ToolSecuritySchemeResolution;
  listTools?: (serverId: string) => Promise<unknown>;
};

/**
 * The challenged tool's `securitySchemes`, which the `_meta` trigger rule
 * reads (a host may act only on a tool that declares `oauth2`). The upstream
 * client strips the field, so the browser cannot see it; the declaration
 * capture can.
 *
 * A per-request manager may not have listed tools yet. Only then, and only
 * for a challenged result, the tools are listed once so the capture sees the
 * declaration. Never throws: an unknown resolution is `unresolved`, which
 * never prompts.
 */
export async function challengedToolSecuritySchemes(
  manager: object,
  serverId: string,
  toolName: string,
): Promise<ToolSecuritySchemeResolution> {
  const source = manager as SchemeSource;
  const read = (): ToolSecuritySchemeResolution => {
    try {
      return (
        source.getToolSecuritySchemes?.(serverId, toolName) ?? {
          schemes: [],
          source: "unresolved",
        }
      );
    } catch {
      return { schemes: [], source: "unresolved" };
    }
  };
  const first = read();
  if (first.source !== "unresolved" || !source.listTools) return first;
  try {
    await source.listTools(serverId);
  } catch {
    return first;
  }
  return read();
}

/**
 * The completed-result fields a challenged result adds: the stamped challenge
 * and, for a `_meta` challenge, the tool's resolved schemes. Empty for an
 * ordinary result.
 */
export async function toolResultAuthChallengeFields(
  manager: object,
  serverId: string,
  toolName: string,
  result: unknown,
): Promise<{
  authChallenge?: AuthChallengeSignal;
  toolSecuritySchemes?: ToolSecuritySchemeResolution;
}> {
  const authChallenge = toolResultAuthChallengeEnvelope(
    result,
    connectionEffectiveAuth(manager, serverId),
  );
  if (!authChallenge) return {};
  return {
    authChallenge,
    toolSecuritySchemes: await challengedToolSecuritySchemes(
      manager,
      serverId,
      toolName,
    ),
  };
}

/**
 * Run a call against one server and stamp any challenge its failure carries.
 */
export async function withStampedAuthChallenge<T>(
  manager: object,
  serverKey: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    stampErrorAuthChallenge(error, connectionEffectiveAuth(manager, serverKey));
    throw error;
  }
}
