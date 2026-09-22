import { describe, expect, it, vi } from "vitest";
import {
  AuthKitConfigError,
  AuthKitVerificationError,
} from "../../../../services/authkit-jwt.js";
import {
  bearerFromAuthorizationHeader,
  canonicalLocalHarnessUserId,
  contextCredentialClass,
  resolveLocalHarnessActor,
} from "../acting-user.js";

/**
 * The identity a local grant binds to, and a local turn is verified against.
 *
 * The property under test is not "does it verify a JWT" — `authkit-jwt.ts`
 * owns that — but "do the consent route and the chat route end up with the
 * SAME id, or refuse together". Everything here is about that agreement.
 */

const verified = { sub: "user_01ABC", orgId: "org_1" };

function deps(verify: (token: string) => Promise<typeof verified>) {
  return { verify: verify as never };
}

describe("the accepted actor", () => {
  it("is a verified AuthKit session, canonicalized by class", async () => {
    const result = await resolveLocalHarnessActor({
      authorizationHeader: "Bearer good-token",
      deps: deps(async () => verified),
    });
    expect(result).toEqual({
      ok: true,
      actor: {
        credential: "authkit",
        userId: "authkit:user_01ABC",
        subject: "user_01ABC",
        orgId: "org_1",
      },
    });
  });

  it("namespaces the id so a second credential class could never collide", () => {
    expect(canonicalLocalHarnessUserId("user_01ABC")).toBe(
      "authkit:user_01ABC",
    );
  });

  it("verifies the token it was handed, not one from anywhere else", async () => {
    const verify = vi.fn(async () => verified);
    await resolveLocalHarnessActor({
      authorizationHeader: "bearer   good-token  ",
      deps: deps(verify),
    });
    expect(verify).toHaveBeenCalledWith("good-token");
  });
});

describe("a credential class that can never authorize is refused first", () => {
  // These are decided BEFORE verification, so the answer no longer depends on
  // whether this deployment has an identity provider configured. Deciding them
  // afterwards meant an API key on an Inspector with no AuthKit hit
  // `AuthKitConfigError` and came back 503 "configure AuthKit" — an operator
  // instruction, for a credential that would still be refused once followed.
  it.each([
    ["an API key", "api-key" as const],
    ["a service credential", "service" as const],
    ["a guest session", "guest" as const],
  ])("403s %s even when AuthKit is unconfigured", async (_label, credential) => {
    const verify = vi.fn(async () => {
      throw new AuthKitConfigError("WORKOS_CLIENT_ID is not set");
    });
    const result = await resolveLocalHarnessActor({
      authorizationHeader: "Bearer whatever",
      contextCredential: credential,
      deps: deps(verify),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "unsupported-credential",
      status: 403,
    });
    // Refused without ever asking the verifier: there is nothing it could say
    // that would make one of these authorize local execution.
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("refusals carry the status the caller can act on", () => {
  it("401s a request with no bearer", async () => {
    const result = await resolveLocalHarnessActor({
      authorizationHeader: undefined,
      deps: deps(async () => verified),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "unauthenticated",
      status: 401,
    });
  });

  it("401s a bearer that does not verify", async () => {
    const result = await resolveLocalHarnessActor({
      authorizationHeader: "Bearer forged",
      deps: deps(async () => {
        throw new AuthKitVerificationError("bad signature");
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "unverified",
      status: 401,
    });
  });

  it("503s a deployment with no AuthKit, instead of a sign-in loop", async () => {
    // The OSS story. A self-hosted Inspector with no WorkOS has no member
    // identity to bind a filesystem grant to, and telling that user to sign in
    // sends them somewhere that does not exist.
    const result = await resolveLocalHarnessActor({
      authorizationHeader: "Bearer anything",
      deps: deps(async () => {
        throw new AuthKitConfigError("WORKOS_CLIENT_ID is not configured");
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "auth-unconfigured",
      status: 503,
    });
    expect((result as { message: string }).message).toMatch(/WORKOS_CLIENT_ID/);
  });

  it.each([
    ["a guest", "guest" as const],
    ["an API key", "api-key" as const],
    ["a service token", "service" as const],
  ])("403s %s with a class-specific explanation", async (_label, kind) => {
    const result = await resolveLocalHarnessActor({
      authorizationHeader: "Bearer sk_or_service",
      contextCredential: kind,
      deps: deps(async () => {
        throw new AuthKitVerificationError("not an AuthKit token");
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "unsupported-credential",
      status: 403,
    });
  });

  it("refuses a guest before it ever looks at the bearer", async () => {
    // A guest bearer can be perfectly valid AS a guest bearer. The refusal is
    // about the class, so it must not depend on the verifier's opinion.
    const verify = vi.fn(async () => verified);
    const result = await resolveLocalHarnessActor({
      authorizationHeader: "Bearer guest-token",
      contextCredential: "guest",
      deps: deps(verify),
    });
    expect(result).toMatchObject({ ok: false, reason: "unsupported-credential" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected error rather than calling it 'unverified'", async () => {
    // A JWKS fetch that blew up is not "your session is invalid". Turning it
    // into a 401 would tell a signed-in user to sign in, forever.
    await expect(
      resolveLocalHarnessActor({
        authorizationHeader: "Bearer good",
        deps: deps(async () => {
          throw new TypeError("fetch failed");
        }),
      }),
    ).rejects.toThrow(/fetch failed/);
  });
});

describe("bearerFromAuthorizationHeader", () => {
  it.each([
    ["a well-formed header", "Bearer abc", "abc"],
    ["lowercase scheme", "bearer abc", "abc"],
    ["surrounding whitespace", "Bearer   abc  ", "abc"],
    ["no scheme", "abc", null],
    ["another scheme", "Basic abc", null],
    ["an empty token", "Bearer   ", null],
    ["nothing", undefined, null],
  ])("reads %s", (_label, header, expected) => {
    expect(bearerFromAuthorizationHeader(header)).toBe(expected);
  });
});

describe("contextCredentialClass", () => {
  const ctx = (vars: Record<string, unknown>) => ({
    get: (key: string) => vars[key],
  });

  it.each([
    ["a guest id", { guestId: "guest_1" }, "guest"],
    ["the guest label", { authMethod: "guest" }, "guest"],
    ["a WorkOS API key", { authMethod: "workos_api_key" }, "api-key"],
    ["the Slack service token", { authMethod: "slack_service" }, "service"],
    ["another surface's token", { authMethod: "discord_service" }, "service"],
  ])("labels %s", (_label, vars, expected) => {
    expect(contextCredentialClass(ctx(vars))).toBe(expected);
  });

  it.each([
    ["an unverified passthrough", { authMethod: "unverified_passthrough" }],
    ["a label nobody has taught it", { authMethod: "something_new" }],
    ["nothing at all", {}],
  ])("answers null for %s", (_label, vars) => {
    // Null lands on the generic refusal, which is the safe direction: a class
    // this function does not recognize is a class local execution has not
    // agreed to accept.
    expect(contextCredentialClass(ctx(vars))).toBeNull();
  });
});

describe("a verified session that names no member", () => {
  it("is refused rather than canonicalized into a bare namespace", async () => {
    // `authkit:` is a non-empty string, so every later check would accept it
    // as an identity. It is not one, and this is the value a filesystem grant
    // binds to.
    const result = await resolveLocalHarnessActor({
      authorizationHeader: "Bearer good",
      deps: deps(async () => ({ sub: "" }) as never),
    });
    expect(result).toMatchObject({ ok: false, reason: "unverified", status: 401 });
  });
});
