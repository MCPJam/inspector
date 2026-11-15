/**
 * Fixtures (RP5): each resource the instructions or cases name is looked up
 * with its read-only tool on the reviewer account, once the account is shown
 * to be the intended reviewer. A missing one is named, with the cases it
 * blocks. Gathering never dials an account the run does not have.
 */

import { describe, expect, it } from "vitest";

import {
  gatherDirectoryReviewerPath,
  lookupDirectoryReviewerFixtures,
} from "../../src/directory-readiness/reviewer/gather.js";
import type {
  DirectoryReviewerFixture,
  DirectoryReviewerSpec,
} from "../../src/directory-readiness/reviewer/evidence.js";
import {
  fakeReviewerClient,
  readTool,
  structured,
  text,
} from "../support/reviewer-client.js";

const PROJECTS = readTool("list_projects");
const fixture = (name: string, args = {}): DirectoryReviewerFixture => ({
  name,
  tool: "list_projects",
  arguments: args,
});
const CASES = [
  { label: "Test cases 1", text: "Open Sample Project and list its servers." },
  { label: "Test cases 2", text: "Rename the server in Missing Project." },
  {
    label: "Test setup instructions",
    text: "Sign in, then open Missing Project.",
  },
];

describe("the fixture lookup", () => {
  it("finds what the result names, and names what it does not, with the cases it blocks", async () => {
    const client = fakeReviewerClient([PROJECTS], {
      list_projects: structured({ projects: [{ name: "Sample Project" }] }),
    });
    const evidence = await lookupDirectoryReviewerFixtures(
      client,
      [fixture("Sample Project"), fixture("Missing Project")],
      CASES
    );
    expect(evidence).toEqual({
      fixtures: [
        { name: "Sample Project", tool: "list_projects", status: "found" },
        {
          name: "Missing Project",
          tool: "list_projects",
          status: "missing",
          reason: "list_projects did not return it",
        },
      ],
      blockedCases: [
        { case: "Test cases 2", fixtures: ["Missing Project"] },
        { case: "Test setup instructions", fixtures: ["Missing Project"] },
      ],
    });
    expect(client.calls).toHaveLength(2);
  });

  it("reads a tool error as missing, and a protocol failure as not looked up", async () => {
    const client = fakeReviewerClient([PROJECTS, readTool("get_project")], {
      list_projects: text("Project Sample Project not found", true),
      get_project: { error: "Invalid params" },
    });
    const evidence = await lookupDirectoryReviewerFixtures(
      client,
      [fixture("Sample Project"), { ...fixture("Other"), tool: "get_project" }],
      []
    );
    expect(evidence.fixtures.map((entry) => entry.status)).toEqual([
      "missing",
      "unchecked",
    ]);
  });

  it("never calls a lookup that is not read-only, or a row it cannot use", async () => {
    const client = fakeReviewerClient(
      [readTool("delete_project", undefined, { readOnlyHint: false })],
      {}
    );
    const evidence = await lookupDirectoryReviewerFixtures(
      client,
      [
        { ...fixture("Sample Project"), tool: "delete_project" },
        { ...fixture("Broken"), problem: "its lookup names no tool" },
      ],
      CASES
    );
    expect(evidence.fixtures).toEqual([
      expect.objectContaining({
        status: "unchecked",
        reason: expect.stringMatching(/not marked read-only/),
      }),
      expect.objectContaining({
        status: "unchecked",
        reason: "its lookup names no tool",
      }),
    ]);
    expect(evidence.blockedCases).toEqual([]);
    expect(client.calls).toEqual([]);
  });
});

describe("gathering the reviewer path", () => {
  const SPEC: DirectoryReviewerSpec = {
    identity: {
      tool: "whoami",
      arguments: {},
      identityPath: "$.email",
      expectedIdentity: "review@example.com",
    },
    fixtures: [fixture("Missing Project")],
    cases: CASES,
  };

  /** The reviewer account's server: initialize, the tool list, then calls. */
  function reviewerServer(whoami: unknown) {
    const requests: Array<{ method: string; authorization?: string }> = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const headers = new Headers(init?.headers);
      requests.push({
        method: body.method,
        authorization: headers.get("authorization") ?? undefined,
      });
      const results: Record<string, unknown> = {
        initialize: { protocolVersion: "2025-06-18", capabilities: {} },
        "tools/list": { tools: [readTool("whoami"), PROJECTS] },
        "tools/call":
          body.params?.name === "whoami"
            ? { structuredContent: whoami, content: [] }
            : { structuredContent: { projects: [] }, content: [] },
      };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: results[body.method] ?? {},
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    const dial = {
      enteredUrl: "https://connector.example.com/mcp",
      fetchFn,
      mcpHeaders: { authorization: "Bearer reviewer-token" },
    };
    return { requests, dial };
  }

  it("looks the fixtures up once the reviewer is verified, as the reviewer only", async () => {
    const server = reviewerServer({ email: "review@example.com" });
    const evidence = await gatherDirectoryReviewerPath({
      account: { id: "acct_reviewer", dial: server.dial },
      spec: SPEC,
    });
    expect(evidence.account).toEqual({ id: "acct_reviewer" });
    expect(evidence.identity?.outcome).toBe("verified");
    expect(evidence.fixtures?.blockedCases.map((entry) => entry.case)).toEqual([
      "Test cases 2",
      "Test setup instructions",
    ]);
    const calls = server.requests.filter(
      (entry) => entry.method === "tools/call"
    );
    expect(calls).toHaveLength(2);
    expect(
      server.requests.every(
        (entry) => entry.authorization === "Bearer reviewer-token"
      )
    ).toBe(true);
  });

  it("does not look the fixtures up for an account that is not the reviewer", async () => {
    const server = reviewerServer({ email: "staff@example.com" });
    const evidence = await gatherDirectoryReviewerPath({
      account: { id: "acct_reviewer", dial: server.dial },
      spec: SPEC,
    });
    expect(evidence.identity?.outcome).toBe("wrong-account");
    expect(evidence.fixtures).toEqual({
      fixtures: [],
      blockedCases: [],
      blocked:
        "the reviewer's identity is not the one the submission names, so the fixtures were not looked up",
    });
    const calls = server.requests.filter(
      (entry) => entry.method === "tools/call"
    );
    expect(calls).toHaveLength(1);
  });

  it("does not dial an account with nothing to check", async () => {
    const server = reviewerServer({});
    const evidence = await gatherDirectoryReviewerPath({
      account: { id: "acct_reviewer", dial: server.dial },
      spec: { fixtures: SPEC.fixtures, cases: [] },
    });
    expect(evidence.identity).toEqual({
      outcome: "unverified",
      reason: "the submission names no identity tool",
    });
    expect(evidence.fixtures?.blocked).toMatch(/identity is unverified/);
    expect(server.requests).toEqual([]);
  });

  it("reports a refused session as unverified", async () => {
    const dial = {
      enteredUrl: "https://connector.example.com/mcp",
      fetchFn: (async () => new Response("", { status: 401 })) as typeof fetch,
      mcpHeaders: { authorization: "Bearer expired" },
    };
    const evidence = await gatherDirectoryReviewerPath({
      account: { id: "acct_reviewer", dial },
      spec: SPEC,
    });
    expect(evidence.identity?.reason).toMatch(
      /the reviewer account's session failed/
    );
  });

  it("keeps a run without a reviewer account to the reason, dialling nothing", async () => {
    expect(
      await gatherDirectoryReviewerPath({
        account: { missing: "No reviewer account is connected." },
        spec: SPEC,
      })
    ).toEqual({ account: { missing: "No reviewer account is connected." } });
  });
});
