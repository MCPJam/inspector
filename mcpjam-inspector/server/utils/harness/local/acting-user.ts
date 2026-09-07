/**
 * WHO a local-native turn and its consent grant belong to.
 *
 * ── Why this is one module and not two route-local helpers ───────────────
 * Consent is minted on `/api/mcp/local-harness/consent/grant` and spent on
 * `/api/mcp/chat-v2`. The grant binds to a user id; the turn is verified
 * against that binding. If the two routes derive that id differently — one
 * from whatever context field its middleware happened to populate, the other
 * from a body field or from nothing at all — then either the binding check is
 * comparing two different things, or it is comparing a value the caller chose.
 * Both are the same bug wearing different clothes, and the second is the one
 * that was actually shipped: the chat route called the parser with no acting
 * user at all.
 *
 * So the accepted credential class and the canonical id are DEFINED here, once,
 * and both routes ask this module rather than each reading the context.
 *
 * ── The accepted actor ───────────────────────────────────────────────────
 * Exactly one class: a verified WorkOS AuthKit session token. Its `sub` — after
 * signature, issuer, audience and expiry verification — is the identity, and
 * `authkit:<sub>` is the canonical form that gets bound.
 *
 * Every other credential `bearerAuthMiddleware` can establish is refused for
 * local execution, deliberately and on both routes:
 *
 *   - a GUEST token is not an attended member;
 *   - an `sk_` WorkOS API key is a headless automation credential, and
 *     "start a vendor agent on the operator's filesystem" is not something a
 *     script should be able to do because it holds a key;
 *   - a Slack/Discord service token acts FOR somebody, not AS them.
 *
 * Refusing them here rather than only on the chat route is what makes the two
 * agree. Accepting one on the consent route alone would mint a capability that
 * no turn could ever spend — a grant that looks like authorization and is not.
 * This does not widen who may run locally; it names the one class that always
 * could, and closes the classes that could mint but never run.
 *
 * ── Why the chat route verifies rather than trusts a context var ─────────
 * `/api/mcp/chat-v2` does not mount `requireVerifiedAuth`, and must not start
 * doing so: it serves anonymous desktop turns, guest turns and BYOK turns that
 * would break. So for a `local-native` body — and ONLY for one — it verifies
 * the bearer itself, right here, with the same verifier and the same rules the
 * consent route used. Unrelated turns never reach this code and their
 * authentication behaviour is untouched.
 */
import {
  AuthKitConfigError,
  AuthKitVerificationError,
  verifyAuthKitToken,
} from "../../../services/authkit-jwt.js";

/**
 * The one accepted actor, in the one canonical form.
 *
 * `userId` is what a grant binds to and what a turn is verified against.
 * `subject` is the raw AuthKit `sub`, kept for logging and for the instance
 * registration that talks to the backend in the backend's own vocabulary.
 */
export interface LocalHarnessActor {
  /** Always `"authkit"` today. Present so the id below can never be ambiguous. */
  credential: "authkit";
  /** Canonical, namespaced. The value bound into a grant. */
  userId: string;
  /** The verified AuthKit `sub`, un-namespaced. */
  subject: string;
  /** The `org_id` claim when the session carries one. Never a gate here. */
  orgId?: string;
}

export type LocalHarnessActorRefusalReason =
  /** No bearer at all. */
  | "unauthenticated"
  /** A bearer that is not a valid AuthKit session token. */
  | "unverified"
  /** A credential class local execution does not accept (guest, key, service). */
  | "unsupported-credential"
  /** This deployment has no AuthKit, so it cannot establish a member identity. */
  | "auth-unconfigured";

export interface LocalHarnessActorRefusal {
  ok: false;
  reason: LocalHarnessActorRefusalReason;
  /** User-facing, actionable, and free of anything from the credential. */
  message: string;
  /** What the route should answer. 401 re-authenticates; 503 is the operator's. */
  status: 401 | 403 | 503;
}

export type LocalHarnessActorResolution =
  | { ok: true; actor: LocalHarnessActor }
  | LocalHarnessActorRefusal;

/**
 * The canonical id for a verified subject.
 *
 * Namespaced by credential class so that adding a second accepted class later
 * cannot make two different principals share an id — the id says which kind of
 * thing it identifies. Change this and every existing grant stops matching,
 * which is the correct outcome: a binding whose meaning changed is not the
 * binding the user approved.
 */
export function canonicalLocalHarnessUserId(subject: string): string {
  return `authkit:${subject}`;
}

/** Injectable for tests; production uses the env-derived AuthKit issuer set. */
export interface LocalHarnessActorDeps {
  verify: typeof verifyAuthKitToken;
}

const defaultDeps: LocalHarnessActorDeps = { verify: verifyAuthKitToken };

/** Pull the bearer out of an Authorization header, or `null`. */
export function bearerFromAuthorizationHeader(
  header: string | undefined | null,
): string | null {
  if (typeof header !== "string") return null;
  if (!/^Bearer\s+/i.test(header)) return null;
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token.length === 0 ? null : token;
}

/**
 * Resolve the acting user for a local-harness consent grant or a local-native
 * turn, from the request's own Authorization header.
 *
 * `contextCredential` lets a caller say what its middleware ALREADY established,
 * purely so the refusal can be accurate: a request that authenticated as an
 * `sk_` key gets "this credential class cannot authorize local execution"
 * rather than the misleading "sign in again".
 */
export async function resolveLocalHarnessActor(args: {
  authorizationHeader: string | undefined | null;
  /**
   * A non-AuthKit identity the route's middleware already established, if any.
   * Never used AS the identity — only to explain a refusal.
   */
  contextCredential?: "guest" | "api-key" | "service" | null;
  deps?: LocalHarnessActorDeps;
}): Promise<LocalHarnessActorResolution> {
  const deps = args.deps ?? defaultDeps;

  if (args.contextCredential === "guest") {
    return {
      ok: false,
      reason: "unsupported-credential",
      status: 403,
      message:
        "Running Claude Code on this machine requires a signed-in member. " +
        "Guest sessions run hosted.",
    };
  }

  const token = bearerFromAuthorizationHeader(args.authorizationHeader);
  if (token === null) {
    return {
      ok: false,
      reason: "unauthenticated",
      status: 401,
      message:
        "Sign in to authorize Claude Code to run on this machine. This " +
        "request carries no session.",
    };
  }

  try {
    const session = await deps.verify(token);
    // `verifyAuthKitToken` already refuses a token with no `sub`. Checked again
    // because this is the value a filesystem grant binds to: an empty subject
    // would canonicalize to the bare namespace `authkit:`, which is not an
    // identity but WOULD be a non-empty string every later check accepted.
    if (typeof session.sub !== "string" || session.sub.length === 0) {
      return {
        ok: false,
        reason: "unverified",
        status: 401,
        message:
          "Your session verified but names no member, so there is no identity " +
          "to bind local execution to. Sign in again.",
      };
    }
    return {
      ok: true,
      actor: {
        credential: "authkit",
        userId: canonicalLocalHarnessUserId(session.sub),
        subject: session.sub,
        ...(session.orgId ? { orgId: session.orgId } : {}),
      },
    };
  } catch (error) {
    if (error instanceof AuthKitConfigError) {
      // Not the user's problem and not fixable by signing in again: this
      // deployment has no identity provider, so there is no member identity to
      // bind a filesystem grant to. Say that, rather than sending an OSS user
      // round a sign-in loop that cannot terminate.
      return {
        ok: false,
        reason: "auth-unconfigured",
        status: 503,
        message:
          "This Inspector has no sign-in configured (WORKOS_CLIENT_ID), so it " +
          "cannot establish the member identity that authorizing Claude Code " +
          "on this machine is bound to. Configure AuthKit, or run this turn " +
          "hosted.",
      };
    }
    if (args.contextCredential === "api-key") {
      return {
        ok: false,
        reason: "unsupported-credential",
        status: 403,
        message:
          "An API key cannot authorize Claude Code to run on this machine. " +
          "Sign in in the Inspector and authorize it there.",
      };
    }
    if (args.contextCredential === "service") {
      return {
        ok: false,
        reason: "unsupported-credential",
        status: 403,
        message:
          "A service credential acts for a user rather than as one, so it " +
          "cannot authorize Claude Code to run on this machine.",
      };
    }
    if (!(error instanceof AuthKitVerificationError)) throw error;
    return {
      ok: false,
      reason: "unverified",
      status: 401,
      message:
        "Your session could not be verified. Sign in again to authorize " +
        "Claude Code on this machine.",
    };
  }
}

/**
 * Which non-AuthKit credential class a Hono context already established.
 *
 * Read from the context vars `bearerAuthMiddleware` sets, and used ONLY to
 * shape the refusal message — never as an identity. `authMethod` labels the
 * class; `guestId` is the reliable guest signal (it predates the label).
 *
 * An unrecognized label answers `null`, which lands on the generic "could not
 * be verified" refusal. That is the safe direction: a class this function does
 * not know is a class local execution has not agreed to accept.
 */
export function contextCredentialClass(c: {
  get: (key: string) => unknown;
}): "guest" | "api-key" | "service" | null {
  if (typeof c.get("guestId") === "string" && c.get("guestId")) return "guest";
  const method = c.get("authMethod");
  if (typeof method !== "string") return null;
  // The labels `bearer-auth.ts`, `slack-service-auth.ts` and
  // `surface-service-auth.ts` set. `*_service` is a family, not one value:
  // `surfaceKind` names the surface (`discord_service`, and whatever is added
  // next), so it is matched by suffix rather than enumerated.
  if (method === "guest") return "guest";
  if (method === "workos_api_key") return "api-key";
  if (method.endsWith("_service")) return "service";
  return null;
}
