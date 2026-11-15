/**
 * The reviewer path, gathered on the reviewer account: who it is, then the
 * fixtures the cases name. Every call goes through the client the caller
 * hands in, which holds the reviewer account's credential and no other, and
 * every tool must say it is read-only before it is called (R7).
 *
 * Fixtures are looked up only once the account is shown to be the intended
 * reviewer: read on the wrong account, a found fixture proves nothing.
 *
 * Root entry only: argument checks compile the tool's input schema.
 */

import { checkToolArgs } from "../../conformance-tool-args.js";
import {
  asRecord,
  asString,
  callJsonRpc,
  dialInitialize,
  dialToolListing,
  type DirectoryDialOptions,
  type DirectoryToolEvidence,
} from "../mcp-dial.js";
import type {
  DirectoryReviewerCase,
  DirectoryReviewerFixture,
  DirectoryReviewerFixtureEvidence,
  DirectoryReviewerFixtureResult,
  DirectoryReviewerIdentityEvidence,
  DirectoryReviewerIdentitySpec,
  DirectoryReviewerPathEvidence,
  DirectoryReviewerSpec,
} from "./evidence.js";

/** The reviewer account's connection, as the reviewer path uses it. */
export interface DirectoryReviewerClient {
  tools: readonly DirectoryToolEvidence[];
  /** Whether `tools` is the whole listing. */
  complete: boolean;
  /** One `tools/call`: its JSON-RPC result, or why there is none. */
  callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ result: Record<string, unknown> } | { error: string }>;
}

/** Open a session as the reviewer account, whose credential is in `options.mcpHeaders`. */
export async function connectDirectoryReviewer(
  options: DirectoryDialOptions
): Promise<DirectoryReviewerClient | { error: string }> {
  const session = await dialInitialize(options);
  if (!session.ok) return { error: session.error ?? "the session was refused" };
  const sessionHeader = session.sessionId
    ? { "mcp-session-id": session.sessionId }
    : undefined;
  const listing = await dialToolListing(options, session.sessionId);
  let id = 1000;
  return {
    tools: listing.entries,
    complete: listing.complete,
    async callTool(name, args) {
      id += 1;
      const call = await callJsonRpc(
        options,
        id,
        "tools/call",
        { name, arguments: args },
        sessionHeader
      );
      const result = asRecord(call.document?.result);
      if (result) return { result };
      const message = asString(asRecord(call.document?.error)?.message);
      return {
        error:
          message ??
          call.transportError ??
          `tools/call answered ${call.status ?? 0}`,
      };
    },
  };
}

/** Why `name` may not be called as the reviewer, or `undefined` when it may (R7). */
export function directoryReviewerReadRefusal(
  client: Pick<DirectoryReviewerClient, "tools" | "complete">,
  name: string,
  args: Record<string, unknown>
): string | undefined {
  const tool = client.tools.find((entry) => entry.name === name);
  if (!tool) {
    return client.complete
      ? `the reviewer account lists no tool named ${name}`
      : `${name} is not in the part of the tool list MCPJam could read`;
  }
  if (tool.annotations?.readOnlyHint !== true) {
    return `${name} is not marked read-only (readOnlyHint: true), so MCPJam does not call it`;
  }
  if (tool.annotations.destructiveHint === true) {
    return `${name} is marked destructive, so MCPJam does not call it`;
  }
  const check = checkToolArgs(tool.inputSchema, args);
  if (check.verdict === "invalid") {
    return `the fixed arguments do not satisfy ${name}'s input schema (${check.message})`;
  }
  const required = asRecord(tool.inputSchema)?.required;
  const unfixed = (Array.isArray(required) ? required : []).filter(
    (key) => typeof key === "string" && !Object.hasOwn(args, key)
  );
  return check.verdict === "unknown" && unfixed.length > 0
    ? `${name} requires arguments the submission does not fix: ${unfixed.join(", ")}`
    : undefined;
}

/** The structured result, else the first text block read as JSON. */
function resultValue(result: Record<string, unknown>): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (Array.isArray(result.content) ? result.content : [])
    .map((block) => asString(asRecord(block)?.text))
    .find((entry) => entry !== undefined);
  try {
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    // Prose, not JSON: no path can be read from it.
    return undefined;
  }
}

/** The values at a JSON path such as `$.user.email` or `orgs[0].id`. */
export function readDirectoryJsonPath(
  value: unknown,
  path: string
): string[] | undefined {
  let current = value;
  for (const segment of path.replace(/^\$\.?/, "").match(/[^.[\]]+/g) ?? []) {
    const record = asRecord(current);
    if (Array.isArray(current) && /^\d+$/.test(segment))
      current = current[Number(segment)];
    else if (record && Object.hasOwn(record, segment))
      current = record[segment];
    else return undefined;
  }
  const values = (Array.isArray(current) ? current : [current]).filter(
    (entry) => ["string", "number", "boolean"].includes(typeof entry)
  );
  return values.length > 0 ? values.map(String) : undefined;
}

/** Call the identity tool as the reviewer and compare what it names (E18). */
export async function checkDirectoryReviewerIdentity(
  client: DirectoryReviewerClient,
  spec: DirectoryReviewerIdentitySpec
): Promise<DirectoryReviewerIdentityEvidence> {
  const expected = {
    identity: spec.expectedIdentity,
    organization: spec.expectedOrganization,
  };
  const unverified = (reason: string, more = {}) => ({
    outcome: "unverified" as const,
    reason,
    expected,
    ...more,
  });
  const paths = {
    identity: spec.identityPath,
    organization: spec.organizationPath,
  };
  const wants = (["identity", "organization"] as const).filter(
    (key) => expected[key] !== undefined
  );
  const pathless = wants.find((key) => !paths[key]);
  const refusal =
    wants.length === 0
      ? "the submission names no expected identity or organization"
      : pathless
        ? `the submission names no path to the ${pathless} in the result`
        : directoryReviewerReadRefusal(client, spec.tool, spec.arguments);
  if (refusal) return unverified(refusal);

  const answer = await client.callTool(spec.tool, spec.arguments);
  const failure =
    "error" in answer
      ? answer.error
      : answer.result.isError === true
        ? "the tool answered with an error"
        : undefined;
  const call = {
    tool: spec.tool,
    arguments: spec.arguments,
    ...(failure ? { error: failure.slice(0, 300) } : {}),
  };
  if (failure || !("result" in answer))
    return unverified(`${spec.tool} failed: ${call.error}`, { call });
  const value = resultValue(answer.result);
  const observed: { identity?: string; organization?: string } = {};
  for (const key of wants) {
    const found = readDirectoryJsonPath(value, paths[key] ?? "");
    if (!found) {
      const reason = `${spec.tool}'s result has no value at ${paths[key]}`;
      return unverified(reason, { call, observed });
    }
    observed[key] = found.join(", ");
    // Several organizations is a flag of its own: a reviewer may land in any.
    if (found.length !== 1 || !same(found[0], expected[key])) {
      const outcome = key === "identity" ? "wrong-account" : "wrong-tenant";
      return { outcome, call, observed, expected };
    }
  }
  return { outcome: "verified", call, observed, expected };
}

function same(a: string | undefined, b: string | undefined): boolean {
  return a?.trim().toLowerCase() === b?.trim().toLowerCase();
}

/**
 * Look each fixture up with its read-only tool, one call at a time. Found
 * means the call succeeded and its result names the fixture; a server that
 * answers a miss with a success naming it reads as found.
 */
export async function lookupDirectoryReviewerFixtures(
  client: DirectoryReviewerClient,
  fixtures: readonly DirectoryReviewerFixture[],
  cases: readonly DirectoryReviewerCase[]
): Promise<DirectoryReviewerFixtureEvidence> {
  const results: DirectoryReviewerFixtureResult[] = [];
  for (const { name, tool, arguments: args, problem } of fixtures) {
    const refusal = problem ?? directoryReviewerReadRefusal(client, tool, args);
    const answer = refusal
      ? { error: refusal }
      : await client.callTool(tool, args);
    if ("error" in answer) {
      const reason = answer.error.slice(0, 300);
      results.push({ name, tool, status: "unchecked", reason });
      continue;
    }
    const text = JSON.stringify([
      answer.result.structuredContent,
      answer.result.content,
    ]);
    const found =
      answer.result.isError !== true &&
      text.toLowerCase().includes(name.toLowerCase());
    results.push(
      found
        ? { name, tool, status: "found" }
        : { name, tool, status: "missing", reason: `${tool} did not return it` }
    );
  }
  const missing = results
    .filter((entry) => entry.status === "missing")
    .map((entry) => entry.name);
  return {
    fixtures: results,
    blockedCases: cases.flatMap((entry) => {
      const named = missing.filter((name) =>
        entry.text.toLowerCase().includes(name.toLowerCase())
      );
      return named.length > 0 ? [{ case: entry.label, fixtures: named }] : [];
    }),
  };
}

/**
 * Gather the reviewer path. An account with nothing to check is not dialled,
 * and an account the run does not have is never stood in for by another.
 */
export async function gatherDirectoryReviewerPath(input: {
  account: { id: string; dial: DirectoryDialOptions } | { missing: string };
  spec: DirectoryReviewerSpec;
}): Promise<DirectoryReviewerPathEvidence> {
  const { account, spec } = input;
  if ("missing" in account) return { account };
  const client =
    typeof spec.identity === "object"
      ? await connectDirectoryReviewer(account.dial)
      : undefined;
  const identity: DirectoryReviewerIdentityEvidence =
    typeof spec.identity !== "object"
      ? {
          outcome: "unverified",
          reason: spec.identity ?? "the submission names no identity tool",
        }
      : !client || "error" in client
        ? {
            outcome: "unverified",
            reason: `the reviewer account's session failed: ${client?.error}`,
          }
        : await checkDirectoryReviewerIdentity(client, spec.identity);
  const verified =
    identity.outcome === "verified" && client && !("error" in client)
      ? client
      : undefined;
  const fixtures: DirectoryReviewerFixtureEvidence =
    spec.fixtures.length > 0 && verified
      ? await lookupDirectoryReviewerFixtures(
          verified,
          spec.fixtures,
          spec.cases
        )
      : {
          fixtures: [],
          blockedCases: [],
          ...(spec.fixtures.length > 0
            ? {
                blocked: `the reviewer's identity is ${identity.outcome === "unverified" ? "unverified" : "not the one the submission names"}, so the fixtures were not looked up`,
              }
            : {}),
        };
  return { account: { id: account.id }, identity, fixtures };
}
