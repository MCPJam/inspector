/**
 * The harness MCP proxy token contract, against the fixture BOTH hand-mirrored
 * verifiers run.
 *
 * Convex mints these tokens; THIS verifier is the one that actually decides
 * whether a proxied `tools/call` proceeds. The two implementations cannot
 * import each other, so "they agree" is only checkable by running each against
 * the same bytes — which is what the shared fixture is (byte-identical copy in
 * the backend, pinned in its `mirrors.json`).
 *
 * The expiry boundary is here because the two sides really did disagree: this
 * verifier rejected at `exp` while the backend's accepted for that whole
 * second, so a freshly-minted-looking token could be refused by the data plane.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { verifyHarnessProxyToken } from "../harness-proxy-token";

type Vector = {
  name: string;
  token: string;
  expect: {
    valid: boolean;
    claims: Record<string, string>;
    evalScope: { runId: string; iterationId: string } | null;
  };
};

const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures/harness-proxy-token-parity-fixtures.json"),
    "utf8",
  ),
) as {
  secret: string;
  nowSeconds: number;
  expSeconds: number;
  serverId: string;
  vectors: Vector[];
  expiryBoundary: Record<string, { nowSeconds: number; valid: boolean }>;
  wrongServerId: string;
};

let originalSecret: string | undefined;
beforeEach(() => {
  originalSecret = process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
  process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = fixtures.secret;
});
afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
  } else {
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = originalSecret;
  }
});

const atSeconds = (seconds: number) => ({ nowMs: seconds * 1000 });

describe("shared parity vectors", () => {
  for (const vector of fixtures.vectors) {
    test(`verifies ${vector.name} exactly as the fixture describes`, () => {
      const claims = verifyHarnessProxyToken(
        vector.token,
        fixtures.serverId,
        atSeconds(fixtures.nowSeconds),
      );
      expect(claims).not.toBeNull();
      expect(claims).toMatchObject(vector.expect.claims);

      if (vector.expect.evalScope) {
        expect(claims?.runId).toBe(vector.expect.evalScope.runId);
        expect(claims?.iterationId).toBe(vector.expect.evalScope.iterationId);
      } else {
        // Absent, not empty-string: the proxy branches on presence to decide
        // whether to record anything at all, and a "" iteration claim would
        // read as present.
        expect(claims?.runId).toBeUndefined();
        expect(claims?.iterationId).toBeUndefined();
      }
    });

    test(`rejects ${vector.name} minted for a different server`, () => {
      expect(
        verifyHarnessProxyToken(
          vector.token,
          fixtures.wrongServerId,
          atSeconds(fixtures.nowSeconds),
        ),
      ).toBeNull();
    });

    for (const [label, boundary] of Object.entries(fixtures.expiryBoundary)) {
      if (label.startsWith("__")) continue;
      test(`${vector.name}: ${label} is ${boundary.valid ? "accepted" : "rejected"}`, () => {
        const claims = verifyHarnessProxyToken(
          vector.token,
          fixtures.serverId,
          atSeconds(boundary.nowSeconds),
        );
        expect(claims === null).toBe(!boundary.valid);
      });
    }
  }
});

describe("a token that is not this one", () => {
  test("is refused when tampered, truncated, or signed with another secret", () => {
    const [header, payload, signature] = fixtures.vectors[1].token.split(".");
    const now = atSeconds(fixtures.nowSeconds);

    // Payload swapped for the claimless one, signature kept: the whole point
    // of signing is that an attacker cannot move an eval claim onto a token.
    const forged = `${header}.${fixtures.vectors[0].token.split(".")[1]}.${signature}`;
    expect(verifyHarnessProxyToken(forged, fixtures.serverId, now)).toBeNull();

    expect(
      verifyHarnessProxyToken(`${header}.${payload}`, fixtures.serverId, now),
    ).toBeNull();
    expect(verifyHarnessProxyToken("", fixtures.serverId, now)).toBeNull();
    expect(
      verifyHarnessProxyToken(undefined, fixtures.serverId, now),
    ).toBeNull();

    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "a-different-secret-entirely";
    expect(
      verifyHarnessProxyToken(
        fixtures.vectors[1].token,
        fixtures.serverId,
        now,
      ),
    ).toBeNull();
  });

  test("is refused when the deployment has no usable secret", () => {
    const now = atSeconds(fixtures.nowSeconds);
    delete process.env.COMPUTERS_TERMINAL_TOKEN_SECRET;
    expect(
      verifyHarnessProxyToken(
        fixtures.vectors[1].token,
        fixtures.serverId,
        now,
      ),
    ).toBeNull();

    // Too short to be a secret. Fail closed rather than verify against it.
    process.env.COMPUTERS_TERMINAL_TOKEN_SECRET = "short";
    expect(
      verifyHarnessProxyToken(
        fixtures.vectors[1].token,
        fixtures.serverId,
        now,
      ),
    ).toBeNull();
  });
});
