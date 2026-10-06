import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ACCOUNT_CREDENTIALS,
  ExternalCredentialMissingError,
  bindingDeliversCredential,
  externalAccountCredentialFor,
  externalCredentialSecretSelection,
  type ExternalCredentialSecret,
} from "../external-credential-selection";

const BINDING = EXTERNAL_ACCOUNT_CREDENTIALS.cursor.binding;

function secret(
  overrides: Partial<ExternalCredentialSecret> = {},
): ExternalCredentialSecret {
  return {
    secretId: "s1",
    name: "CURSOR_API_KEY",
    delivery: "brokered",
    sharing: "user",
    brokerHosts: [...BINDING.hosts],
    brokerHeader: BINDING.header,
    brokerTemplate: BINDING.template,
    ...overrides,
  };
}

const cursor = { harness: "cursor" };

function missing(fn: () => unknown): ExternalCredentialMissingError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalCredentialMissingError);
    return error as ExternalCredentialMissingError;
  }
  throw new Error("expected a throw");
}

describe("externalAccountCredentialFor", () => {
  it("knows Cursor's credential and nobody else's", () => {
    expect(externalAccountCredentialFor("cursor")?.env).toBe("CURSOR_API_KEY");
    for (const id of [
      "claude-code",
      "codex",
      "",
      undefined,
      null,
      "toString",
    ]) {
      expect(externalAccountCredentialFor(id as never)).toBeUndefined();
    }
  });
});

describe("externalCredentialSecretSelection", () => {
  it("needs nothing for a client that does not sign in with its own account", () => {
    for (const harness of ["claude-code", "codex", undefined, null]) {
      expect(
        externalCredentialSecretSelection({ harness }, []),
      ).toBeUndefined();
    }
    // …and does not even need the secrets read.
    expect(
      externalCredentialSecretSelection({ harness: "codex" }, undefined),
    ).toBeUndefined();
  });

  it("selects the composer's own brokered key", () => {
    expect(
      externalCredentialSecretSelection(cursor, [secret()]),
    ).toEqual({ mode: "explicit", secretIds: ["s1"] });
  });

  it("never selects a project-shared key, even alongside a personal one", () => {
    expect(
      externalCredentialSecretSelection(cursor, [
        secret({ secretId: "mine", sharing: "user" }),
        secret({ secretId: "shared", sharing: "project" }),
      ]),
    ).toEqual({ mode: "explicit", secretIds: ["mine"] });
  });

  it("refuses a project-shared key when it is the only one", () => {
    const error = missing(() =>
      externalCredentialSecretSelection(cursor, [
        secret({ sharing: "project" }),
      ]),
    );
    expect(error.code).toBe("not_shared");
    expect(error.message).toMatch(/shared with the project/);
    expect(error.message).toMatch(/your own/);
  });

  it("cannot be carried by a surface whose participants are not the composer", () => {
    for (const sharing of ["user", "project"] as const) {
      const error = missing(() =>
        externalCredentialSecretSelection(cursor, [secret({ sharing })], {
          requireShared: true,
        }),
      );
      expect(error.code).toBe("not_shared");
    }
  });

  it("throws when there is no key, naming the secret to add", () => {
    const error = missing(() => externalCredentialSecretSelection(cursor, []));
    expect(error.code).toBe("absent");
    expect(error.credentialName).toBe("CURSOR_API_KEY");
    expect(error.harnessId).toBe("cursor");
    expect(error.message).toMatch(/CURSOR_API_KEY/);
  });

  it("ignores a materialized key: a hosted box cannot be handed one", () => {
    expect(
      missing(() =>
        externalCredentialSecretSelection(cursor, [
          secret({
            delivery: "materialized",
            brokerHosts: undefined,
            brokerHeader: undefined,
            brokerTemplate: undefined,
          }),
        ]),
      ).code,
    ).toBe("absent");
  });

  it("says a key bound to the wrong place is mis-bound, with the binding it needs", () => {
    const error = missing(() =>
      externalCredentialSecretSelection(cursor, [
        secret({ brokerHosts: ["example.com"] }),
      ]),
    );
    expect(error.code).toBe("misbound");
    expect(error.message).toMatch(/api2\.cursor\.sh/);
    expect(error.message).toMatch(/authorization/);
  });

  it("uses a correctly bound sibling over a mis-bound one", () => {
    expect(
      externalCredentialSecretSelection(cursor, [
        secret({ secretId: "bad", brokerHosts: ["example.com"] }),
        secret({ secretId: "good" }),
      ]),
    ).toEqual({ mode: "explicit", secretIds: ["good"] });
  });

  it("ignores secrets of other names", () => {
    expect(
      missing(() =>
        externalCredentialSecretSelection(cursor, [
          secret({ name: "GITHUB_TOKEN" }),
        ]),
      ).code,
    ).toBe("absent");
  });

  it("cannot establish anything while the secrets are unread — and says so", () => {
    expect(
      missing(() => externalCredentialSecretSelection(cursor, undefined)).code,
    ).toBe("unavailable");
  });
});

describe("bindingDeliversCredential", () => {
  const spec = EXTERNAL_ACCOUNT_CREDENTIALS.cursor;
  it("compares the header and hosts case-insensitively, and needs `{}` in the template", () => {
    expect(
      bindingDeliversCredential(
        {
          brokerHosts: ["API2.cursor.sh"],
          brokerHeader: "Authorization",
          brokerTemplate: "bearer {}",
        },
        spec,
      ),
    ).toBe(true);
    expect(
      bindingDeliversCredential(
        { ...secret(), brokerTemplate: "Bearer token" },
        spec,
      ),
    ).toBe(false);
    expect(
      bindingDeliversCredential(
        { ...secret(), brokerHeader: "x-api-key" },
        spec,
      ),
    ).toBe(false);
    expect(bindingDeliversCredential({}, spec)).toBe(false);
  });

  it("accepts a binding that covers MORE hosts than the credential needs", () => {
    expect(
      bindingDeliversCredential(
        { ...secret(), brokerHosts: ["api2.cursor.sh", "other.example"] },
        spec,
      ),
    ).toBe(true);
  });
});
