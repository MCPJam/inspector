import { describe, expect, it } from "vitest";
import type { EvalRunAccount } from "@/components/evals/types";
import {
  runAccountCredentialFacts,
  runAccountIdentityText,
} from "../run-account-credentials";

const at = (timestamp: number) => `t${timestamp}`;

const uploaded: EvalRunAccount = {
  serverId: "srv-linear",
  kind: "shared",
  connectionId: "conn-1",
  name: "test-automation-1",
  tokenStoredBy: "Ana Ruiz",
  tokenStoredAt: 1_000,
  tokenUploaded: true,
  tokenExpiresAt: 2_000,
  identity: {
    source: "token",
    name: "test-automation-1",
    subject: "svc-automation",
    issuer: "https://login.example.test/oauth2/default",
  },
};

describe("runAccountCredentialFacts", () => {
  it("says who uploaded the token and when, when it expires, and whose it is", () => {
    expect(runAccountCredentialFacts(uploaded, at)).toEqual([
      "Uploaded t1000 by Ana Ruiz",
      "Expires t2000",
      "Identity: test-automation-1 (svc-automation), from the token",
    ]);
  });

  it("says signed in for a token from a sign-in, and leaves out what was not recorded", () => {
    expect(
      runAccountCredentialFacts(
        {
          ...uploaded,
          tokenUploaded: undefined,
          tokenStoredAt: undefined,
          tokenExpiresAt: undefined,
          identity: undefined,
        },
        at,
      ),
    ).toEqual(["Signed in by Ana Ruiz"]);
  });

  it("is empty for an account recorded before these facts existed", () => {
    expect(
      runAccountCredentialFacts({
        serverId: "srv",
        kind: "account",
        name: "Dummy",
      }),
    ).toEqual([]);
  });
});

describe("runAccountIdentityText", () => {
  it("labels where the identity came from", () => {
    expect(
      runAccountIdentityText({
        source: "profile",
        name: "Automation",
        subject: "user-7",
      }),
    ).toBe("Identity: Automation (user-7), from the server's profile tool");
    expect(runAccountIdentityText({ source: "token", subject: "svc-ci" })).toBe(
      "Identity: svc-ci, from the token",
    );
    expect(
      runAccountIdentityText({ source: "token", name: "ci", subject: "ci" }),
    ).toBe("Identity: ci, from the token");
  });

  it("falls back to the issuer, and to nothing", () => {
    expect(
      runAccountIdentityText({
        source: "token",
        issuer: "https://login.example.test/oauth2/default",
      }),
    ).toBe("Issuer: login.example.test, from the token");
    expect(runAccountIdentityText({ source: "token", issuer: "not a url" })).toBe(
      "Issuer: not a url, from the token",
    );
    expect(runAccountIdentityText({ source: "token" })).toBeUndefined();
    expect(runAccountIdentityText(undefined)).toBeUndefined();
  });
});
