import { describe, expect, it } from "vitest";
import { toRunAccountsProjection } from "../eval-run-accounts.js";

// Fake values only: example.com addresses and made-up ids.
const PERSONAL = {
  serverId: "srv_linear",
  kind: "account",
  connectionId: "conn_personal_1",
  name: "test-automation-1",
  profileId: "profile-123",
  tokenStoredBy: "Ana Ruiz",
  tokenStoredAt: 1763372820000,
  tokenUploaded: true,
  tokenExpiresAt: 1763376420000,
  identity: {
    source: "profile",
    name: "Test Automation",
    subject: "profile-123",
    email: "test-automation-1@example.com",
    emailSource: "profile",
  },
};

const SHARED_DEFAULT = {
  serverId: "srv_asana",
  kind: "shared",
  name: "Shared with the project",
};

describe("toRunAccountsProjection", () => {
  it("projects each account onto the public names, field by field", () => {
    expect(toRunAccountsProjection([PERSONAL, SHARED_DEFAULT])).toEqual({
      accounts: [
        {
          serverId: "srv_linear",
          accountId: "conn_personal_1",
          name: "test-automation-1",
          kind: "personal",
          tokenUploaded: true,
          tokenStoredBy: "Ana Ruiz",
          tokenStoredAt: 1763372820000,
          tokenExpiresAt: 1763376420000,
          identity: {
            source: "profile",
            name: "Test Automation",
            subject: "profile-123",
            email: "test-automation-1@example.com",
            emailSource: "profile",
          },
        },
        {
          serverId: "srv_asana",
          name: "Shared with the project",
          kind: "project",
        },
      ],
    });
  });

  it("omits the field when the run recorded no accounts", () => {
    expect(toRunAccountsProjection(undefined)).toEqual({});
    expect(toRunAccountsProjection(null)).toEqual({});
  });

  it("keeps a recorded empty list, which says the run used none", () => {
    expect(toRunAccountsProjection([])).toEqual({ accounts: [] });
  });

  it("passes an email on only when the backend returned it", () => {
    // The backend removed it for this caller: no email, and no emailSource.
    const { email: _email, emailSource: _source, ...withoutEmail } =
      PERSONAL.identity;
    const [account] =
      toRunAccountsProjection([{ ...PERSONAL, identity: withoutEmail }])
        .accounts ?? [];
    expect(account?.identity).toEqual({
      source: "profile",
      name: "Test Automation",
      subject: "profile-123",
    });
    expect(JSON.stringify(account)).not.toContain("@");
  });

  it("keeps an identity that is only an email", () => {
    const [account] =
      toRunAccountsProjection([
        {
          ...PERSONAL,
          identity: {
            source: "token",
            email: "test-automation-1@example.com",
            emailSource: "token",
          },
        },
      ]).accounts ?? [];
    expect(account?.identity).toEqual({
      source: "token",
      email: "test-automation-1@example.com",
      emailSource: "token",
    });
  });

  it("marks a readiness reviewer login and an XAA identity", () => {
    const { accounts } = toRunAccountsProjection([
      { ...SHARED_DEFAULT, kind: "account", reviewer: true, name: "Reviewer" },
      {
        serverId: "srv_xaa",
        kind: "xaa",
        name: "alice",
        xaaSubject: "alice",
      },
    ]);
    expect(accounts).toEqual([
      {
        serverId: "srv_asana",
        name: "Reviewer",
        kind: "personal",
        reviewer: true,
      },
      { serverId: "srv_xaa", name: "alice", kind: "xaa" },
    ]);
  });

  it("drops the whole list when one entry has a kind it does not know", () => {
    expect(
      toRunAccountsProjection([PERSONAL, { ...SHARED_DEFAULT, kind: "team" }]),
    ).toEqual({});
  });

  it("drops an identity whose source it does not know", () => {
    const [account] =
      toRunAccountsProjection([
        { ...PERSONAL, identity: { ...PERSONAL.identity, source: "guess" } },
      ]).accounts ?? [];
    expect(account).not.toHaveProperty("identity");
  });
});
