/**
 * The identity check (E18, R7): one read-only tool, called on the reviewer
 * account with fixed arguments, its result compared by JSON path. A tool the
 * listing does not mark read-only, or whose required arguments the
 * submission does not fix, is never called.
 */

import { describe, expect, it } from "vitest";

import {
  checkDirectoryReviewerIdentity,
  directoryReviewerReadRefusal,
  readDirectoryJsonPath,
} from "../../src/directory-readiness/reviewer/gather.js";
import type { DirectoryReviewerIdentitySpec } from "../../src/directory-readiness/reviewer/evidence.js";
import {
  fakeReviewerClient,
  readTool,
  structured,
  text,
} from "../support/reviewer-client.js";

const WHOAMI = readTool("whoami");
const SPEC: DirectoryReviewerIdentitySpec = {
  tool: "whoami",
  arguments: {},
  identityPath: "$.user.email",
  expectedIdentity: "review@example.com",
  organizationPath: "$.organization.name",
  expectedOrganization: "Sample Org",
};
const SIGNED_IN = {
  user: { email: "Review@Example.com" },
  organization: { name: "Sample Org" },
};

describe("the identity check", () => {
  it("verifies the reviewer and the organization, and records the call", async () => {
    const client = fakeReviewerClient([WHOAMI], {
      whoami: structured(SIGNED_IN),
    });
    expect(await checkDirectoryReviewerIdentity(client, SPEC)).toEqual({
      outcome: "verified",
      call: { tool: "whoami", arguments: {} },
      observed: { identity: "Review@Example.com", organization: "Sample Org" },
      expected: { identity: "review@example.com", organization: "Sample Org" },
    });
    expect(client.calls).toEqual([{ name: "whoami", args: {} }]);
  });

  it("reads a result answered as JSON text", async () => {
    const client = fakeReviewerClient([WHOAMI], {
      whoami: text(JSON.stringify(SIGNED_IN)),
    });
    expect((await checkDirectoryReviewerIdentity(client, SPEC)).outcome).toBe(
      "verified"
    );
  });

  it("names another organization as the wrong tenant", async () => {
    const client = fakeReviewerClient([WHOAMI], {
      whoami: structured({ ...SIGNED_IN, organization: { name: "Other Org" } }),
    });
    expect(await checkDirectoryReviewerIdentity(client, SPEC)).toMatchObject({
      outcome: "wrong-tenant",
      observed: { organization: "Other Org" },
    });
  });

  it("flags an account in more than one organization", async () => {
    const client = fakeReviewerClient([WHOAMI], {
      whoami: structured({
        user: SIGNED_IN.user,
        organizations: ["Sample Org", "Other Org"],
      }),
    });
    const evidence = await checkDirectoryReviewerIdentity(client, {
      ...SPEC,
      organizationPath: "organizations",
    });
    expect(evidence).toMatchObject({
      outcome: "wrong-tenant",
      observed: { organization: "Sample Org, Other Org" },
    });
  });

  it("names another account as the wrong account", async () => {
    const client = fakeReviewerClient([WHOAMI], {
      whoami: structured({
        ...SIGNED_IN,
        user: { email: "staff@example.com" },
      }),
    });
    expect(await checkDirectoryReviewerIdentity(client, SPEC)).toMatchObject({
      outcome: "wrong-account",
      observed: { identity: "staff@example.com" },
    });
  });

  it("calls a tool with required arguments when the stored ones satisfy them", async () => {
    const tool = readTool("get_member", {
      type: "object",
      properties: { project: { type: "string" } },
      required: ["project"],
    });
    const client = fakeReviewerClient([tool], {
      get_member: structured(SIGNED_IN),
    });
    const evidence = await checkDirectoryReviewerIdentity(client, {
      ...SPEC,
      tool: "get_member",
      arguments: { project: "sample-project" },
    });
    expect(evidence.outcome).toBe("verified");
    expect(client.calls).toEqual([
      { name: "get_member", args: { project: "sample-project" } },
    ]);
  });

  it.each([
    ["the tool is not listed", [], /lists no tool named whoami/],
    [
      "the listing does not mark it read-only",
      [readTool("whoami", undefined, { destructiveHint: false })],
      /not marked read-only/,
    ],
    [
      "it says it is destructive",
      [
        readTool("whoami", undefined, {
          readOnlyHint: true,
          destructiveHint: true,
        }),
      ],
      /marked destructive/,
    ],
    [
      "it has a required argument the submission does not fix",
      [
        readTool("whoami", {
          type: "object",
          properties: { project: { type: "string" } },
          required: ["project"],
        }),
      ],
      /do not satisfy whoami's input schema/,
    ],
  ])(
    "is unverified, and never called, when %s",
    async (_case, tools, reason) => {
      const client = fakeReviewerClient(tools, {
        whoami: structured(SIGNED_IN),
      });
      const evidence = await checkDirectoryReviewerIdentity(client, SPEC);
      expect(evidence.outcome).toBe("unverified");
      expect(evidence.reason).toMatch(reason);
      expect(client.calls).toEqual([]);
    }
  );

  it("says a missing tool may be past the part of the listing it read", () => {
    const client = fakeReviewerClient([], {}, false);
    expect(directoryReviewerReadRefusal(client, "whoami", {})).toMatch(
      /not in the part of the tool list MCPJam could read/
    );
  });

  it("falls back to the required keys when the schema cannot be checked", () => {
    const tool = readTool("whoami", {
      $schema: "https://example.com/unknown-dialect",
      required: ["project"],
    });
    const client = fakeReviewerClient([tool], {});
    expect(directoryReviewerReadRefusal(client, "whoami", {})).toMatch(
      /requires arguments the submission does not fix: project/
    );
    expect(
      directoryReviewerReadRefusal(client, "whoami", { project: "p" })
    ).toBeUndefined();
  });

  it.each([
    [
      "the call fails",
      { error: "upstream timeout" },
      /whoami failed: upstream timeout/,
    ],
    [
      "the tool reports an error",
      text("no session", true),
      /answered with an error/,
    ],
    [
      "the result has nothing at the path",
      structured({ user: {} }),
      /no value at \$\.user\.email/,
    ],
  ])(
    "is unverified when %s, keeping the call",
    async (_case, answer, reason) => {
      const client = fakeReviewerClient([WHOAMI], { whoami: answer });
      const evidence = await checkDirectoryReviewerIdentity(client, SPEC);
      expect(evidence).toMatchObject({
        outcome: "unverified",
        call: { tool: "whoami" },
      });
      expect(evidence.reason).toMatch(reason);
    }
  );

  it("is unverified without an expectation, or without a path to one", async () => {
    const client = fakeReviewerClient([WHOAMI], {
      whoami: structured(SIGNED_IN),
    });
    const bare = { tool: "whoami", arguments: {} };
    expect((await checkDirectoryReviewerIdentity(client, bare)).reason).toMatch(
      /names no expected identity or organization/
    );
    expect(
      (
        await checkDirectoryReviewerIdentity(client, {
          ...bare,
          expectedOrganization: "Sample Org",
        })
      ).reason
    ).toMatch(/no path to the organization/);
    expect(client.calls).toEqual([]);
  });
});

describe("JSON paths", () => {
  const value = {
    orgs: [{ id: "org_1" }, { id: "org_2" }],
    user: { email: "review@example.com", admin: false },
  };

  it.each([
    ["$.user.email", ["review@example.com"]],
    ["user.admin", ["false"]],
    ["$.orgs[1].id", ["org_2"]],
    ["orgs.0.id", ["org_1"]],
    ["$.user", undefined],
    ["$.missing.key", undefined],
    ["$.user.constructor", undefined],
  ])("reads %s", (path, expected) => {
    expect(readDirectoryJsonPath(value, path)).toEqual(expected);
  });
});
