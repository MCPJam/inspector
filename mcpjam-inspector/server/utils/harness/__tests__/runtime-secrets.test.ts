/**
 * Materialized secret delivery: the tri-state, and the rotation fork.
 *
 * Both properties are the kind that only fail in production, so they are pinned
 * here rather than trusted to the shape of the code:
 *
 *   - a FETCH FAILURE must not be indistinguishable from "no secrets". If it
 *     were, a Convex blip would strip a working session's credentials and the
 *     user would see a `stripe` command start failing with nothing changed on
 *     their side.
 *   - a ROTATION must change the fingerprint. A resumed harness session
 *     reattaches to a bridge process holding the environment it was created
 *     with, so a rotation that did not fork would land everywhere except the
 *     conversation the user is sitting in.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const listSecrets = vi.fn();
vi.mock("../../computers/convex-secrets-client.js", () => ({
  convexListSecretsForRuntimeExecution: (...args: unknown[]) =>
    listSecrets(...args),
}));

const { fetchRuntimeSecrets, deliveredSecretsFingerprint, toSecretEnv } =
  await import("../runtime-secrets.js");

afterEach(() => {
  vi.clearAllMocks();
});

describe("fetchRuntimeSecrets", () => {
  it("returns an empty SUCCESS when there is no environment to grant from", async () => {
    // The environment IS the grant boundary. No environment is not a failure —
    // there is simply nothing granted — so callers must not treat it as one.
    await expect(
      fetchRuntimeSecrets("Bearer t", { projectId: "p1" }),
    ).resolves.toEqual({ ok: true, secrets: [] });
    expect(listSecrets).not.toHaveBeenCalled();
  });

  it("returns an empty SUCCESS with no bearer, without calling the backend", async () => {
    await expect(
      fetchRuntimeSecrets(undefined, { projectId: "p1", environmentId: "e1" }),
    ).resolves.toEqual({ ok: true, secrets: [] });
    expect(listSecrets).not.toHaveBeenCalled();
  });

  it("passes the bearer and the ids through, and returns what the backend gave", async () => {
    listSecrets.mockResolvedValueOnce([
      { name: "STRIPE_API_KEY", value: "sk" },
    ]);
    await expect(
      fetchRuntimeSecrets("Bearer t", {
        projectId: "p1",
        environmentId: "e1",
        chatSessionId: "cs1",
      }),
    ).resolves.toEqual({
      ok: true,
      secrets: [{ name: "STRIPE_API_KEY", value: "sk" }],
    });
    expect(listSecrets).toHaveBeenCalledWith("Bearer t", {
      projectId: "p1",
      environmentId: "e1",
      chatSessionId: "cs1",
    });
  });

  it("reports a failure as { ok: false }, NEVER as an empty list", async () => {
    listSecrets.mockRejectedValueOnce(new Error("convex down"));
    await expect(
      fetchRuntimeSecrets("Bearer t", {
        projectId: "p1",
        environmentId: "e1",
      }),
    ).resolves.toEqual({ ok: false });
  });
});

describe("deliveredSecretsFingerprint", () => {
  it("is empty for no secrets, so a secretless turn keeps resuming", () => {
    // Byte-identical to a world where this dimension does not exist.
    expect(deliveredSecretsFingerprint([])).toBe("");
  });

  it("changes when a VALUE rotates under the same name", () => {
    const before = deliveredSecretsFingerprint([
      { name: "STRIPE_API_KEY", value: "sk_live_old" },
    ]);
    const after = deliveredSecretsFingerprint([
      { name: "STRIPE_API_KEY", value: "sk_live_new" },
    ]);
    expect(after).not.toBe(before);
  });

  it("changes when a secret is added or removed", () => {
    const one = deliveredSecretsFingerprint([{ name: "A_KEY", value: "v1" }]);
    const two = deliveredSecretsFingerprint([
      { name: "A_KEY", value: "v1" },
      { name: "B_KEY", value: "v2" },
    ]);
    expect(two).not.toBe(one);
  });

  it("is order-independent", () => {
    const forward = deliveredSecretsFingerprint([
      { name: "A_KEY", value: "v1" },
      { name: "B_KEY", value: "v2" },
    ]);
    const reversed = deliveredSecretsFingerprint([
      { name: "B_KEY", value: "v2" },
      { name: "A_KEY", value: "v1" },
    ]);
    expect(forward).toBe(reversed);
  });

  it("does not contain the value it fingerprints", () => {
    // The digest is folded into another hash before anything is stored, but the
    // first hop must not be the credential itself either.
    const fp = deliveredSecretsFingerprint([
      { name: "STRIPE_API_KEY", value: "sk_live_51H8xQ2abcdef" },
    ]);
    expect(fp).not.toContain("sk_live");
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  it("distinguishes two secrets whose values were swapped between names", () => {
    // A digest keyed only on the value set would collide here, and the two are
    // materially different environments.
    const a = deliveredSecretsFingerprint([
      { name: "A_KEY", value: "one" },
      { name: "B_KEY", value: "two" },
    ]);
    const b = deliveredSecretsFingerprint([
      { name: "A_KEY", value: "two" },
      { name: "B_KEY", value: "one" },
    ]);
    expect(a).not.toBe(b);
  });
});

describe("toSecretEnv", () => {
  it("maps names to values", () => {
    expect(
      toSecretEnv([
        { name: "A_KEY", value: "1" },
        { name: "B_KEY", value: "2" },
      ]),
    ).toEqual({ A_KEY: "1", B_KEY: "2" });
  });

  it("is empty for an empty list, so no call site has to special-case it", () => {
    expect(toSecretEnv([])).toEqual({});
  });
});
