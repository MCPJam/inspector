/**
 * Shared helpers for the client spec-rule tests in this folder.
 *
 * Every test here is named after one rule in `rules.ts` and marked with the
 * rule's spec level (see `levels.ts`), as `C003 [MUST] <what it proves>`.
 * Each test checks exactly what its rule says, no more and no less. A rule is
 * accounted for in one of four ways:
 *
 * - `ruleTest`: a test that proves our client follows the rule. When the setup
 *   did not make the client do the thing the rule is about, the test skips
 *   with "not exercised" (see `exercised`) instead of passing or failing.
 * - `ruleTest.knownBreak`: the client breaks the rule today. The body asserts
 *   the broken behavior exactly, so the test turns red the day someone fixes
 *   it, and also if it starts failing for any other reason.
 * - `coveredBy`: a test elsewhere proves exactly this rule and nothing more;
 *   this only checks that the test still exists.
 * - `mayRule`: a MAY only permits something, so there is nothing a client can
 *   break. Reported as skipped, with what MCPJam does.
 *
 * Rules checked across many conformance checks use a "wire corpus" instead:
 * every mapped check runs once against a fake server, each request the client
 * sends is recorded and tagged with the check that sent it, and the test
 * asserts that the checks breaking the rule are EXACTLY the known ones. A fix
 * and a new break both turn the test red.
 *
 * `rules-coverage.unit.test.ts` reads these files and fails if a rule in the
 * catalog is not accounted for, or has no spec level.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, type TestContext } from "vitest";
import {
  MCPConformanceTest,
  type MCPCheckId,
  type MCPCheckResult,
  type MCPConformanceConfig,
  type MCPConformanceResult,
} from "../../src/mcp-conformance/index.js";
import {
  startConformanceMockServer,
  type ConformanceMockRequest,
} from "../mock-servers/conformance-mcp-server.js";
import { levelOf } from "./levels.js";
import type { ClientRuleId } from "./rules.js";

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------------------
// Naming tests after rules
// ---------------------------------------------------------------------------

export function ruleName(id: ClientRuleId, label: string): string {
  return `${id} [${levelOf(id)}] ${label}`;
}

type TestBody = (context: TestContext) => unknown;

function ruleTestImpl(
  id: ClientRuleId,
  label: string,
  fn: TestBody,
  timeout?: number,
): void {
  it(ruleName(id, label), fn, timeout);
}

export const ruleTest = Object.assign(ruleTestImpl, {
  /**
   * The client breaks the rule today. `reason` says where and why. The body
   * asserts the broken behavior exactly (not the rule), so a fix and any other
   * failure both turn the test red.
   */
  knownBreak(
    id: ClientRuleId,
    label: string,
    reason: string,
    fn: TestBody,
    timeout?: number,
  ): void {
    it(`${ruleName(id, label)} (KNOWN BREAK: ${reason})`, fn, timeout);
  },
});

/**
 * Skip the running test with "not exercised" when the setup did not make the
 * client do the thing the rule is about. No verdict either way: the rule was
 * not observed.
 */
export function exercised(
  context: TestContext,
  happened: boolean,
  what: string,
): void {
  context.skip(!happened, `not exercised: ${what}`);
}

/** `file` is relative to the sdk folder; `testName` must appear in it verbatim. */
export function coveredBy(
  id: ClientRuleId,
  file: string,
  testName: string,
): void {
  it(`${ruleName(id, "is proven by an existing test")}: ${file} › ${testName}`, () => {
    const source = readFileSync(resolve(SDK_ROOT, file), "utf8");
    expect(
      source.includes(testName),
      `${file} no longer contains the test "${testName}"`,
    ).toBe(true);
  });
}

/** A MAY: nothing a client can break. `note` says what MCPJam does. */
export function mayRule(id: ClientRuleId, note: string): void {
  if (levelOf(id) !== "MAY") {
    throw new Error(`${id} is ${levelOf(id)}, not MAY`);
  }
  it.skip(`${ruleName(id, "nothing to break: a MAY only permits")}. ${note}`, () => {});
}

// ---------------------------------------------------------------------------
// The wire corpus
// ---------------------------------------------------------------------------

/** One HTTP request the client sent, tagged with the check that sent it. */
export interface WireRequest {
  check: string;
  httpMethod: string;
  /** Path only. */
  path: string;
  /** Lowercase names; a repeated header is joined with ", ". */
  headers: Record<string, string>;
  /** The parsed JSON-RPC message, when the request carried one. */
  body?: unknown;
  startedAt: number;
  /**
   * When the exchange ended. Server-side records: when the response finished
   * or the connection closed. Fetch-side records: when the response headers
   * arrived (a streamed body may run on).
   */
  endedAt?: number;
  /** For an `initialize` that opened a session: the id the server minted. */
  mintedSessionId?: string;
  responseContentType?: string;
  /** Fetch-side only: the parsed body of a JSON (not streamed) response. */
  responseJson?: unknown;
  /** Fetch-side only: when the client aborted the request (closed the stream). */
  abortedAt?: number;
}

export interface JsonRpcView {
  method?: string;
  hasId: boolean;
  id?: unknown;
  params?: Record<string, unknown>;
}

/** The JSON-RPC message a request carried, or undefined for none (or a batch). */
export function rpcOf(request: WireRequest): JsonRpcView | undefined {
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const message = body as Record<string, unknown>;
  return {
    method: typeof message.method === "string" ? message.method : undefined,
    hasId: Object.prototype.hasOwnProperty.call(message, "id"),
    id: message.id,
    params:
      message.params && typeof message.params === "object"
        ? (message.params as Record<string, unknown>)
        : undefined,
  };
}

export function rpcMethodOf(request: WireRequest): string | undefined {
  return rpcOf(request)?.method;
}

/** A JSON-RPC request (it has an id), as opposed to a notification or a response. */
export function isRpcRequest(request: WireRequest): boolean {
  const rpc = rpcOf(request);
  return rpc?.method !== undefined && rpc.hasId;
}

/**
 * For each check, the first request (or session) that breaks a rule.
 * `judge` returns a short description of the break, or undefined.
 */
export function violationsByCheck<T extends { check: string }>(
  items: readonly T[],
  judge: (item: T) => string | undefined,
): Map<string, string> {
  const found = new Map<string, string>();
  for (const item of items) {
    if (found.has(item.check)) continue;
    const problem = judge(item);
    if (problem) found.set(item.check, problem);
  }
  return found;
}

/**
 * The checks that break the rule must be exactly `known`. On a mismatch the
 * message shows one example per breaking check.
 */
export function expectKnownViolations(
  found: Map<string, string>,
  known: readonly string[] = [],
): void {
  expect(
    [...found.keys()].sort(),
    `breaking checks, one example each:\n${JSON.stringify(Object.fromEntries(found), null, 2)}`,
  ).toEqual([...known].sort());
}

function headersToRecord(
  headers: Headers | ConformanceMockRequest["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, name) => {
      out[name.toLowerCase()] = value;
    });
    return out;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A legacy session as the server saw it: the opening initialize and what followed on it. */
export interface WireSession {
  id: string;
  check: string;
  initialize: WireRequest;
  /** Later requests carrying the session id, in arrival order. */
  requests: WireRequest[];
}

export function sessionsOf(requests: readonly WireRequest[]): WireSession[] {
  const sessions = new Map<string, WireSession>();
  for (const request of requests) {
    if (request.mintedSessionId) {
      sessions.set(request.mintedSessionId, {
        id: request.mintedSessionId,
        check: request.check,
        initialize: request,
        requests: [],
      });
    }
  }
  for (const request of requests) {
    const id = request.headers["mcp-session-id"];
    if (id) sessions.get(id)?.requests.push(request);
  }
  return [...sessions.values()];
}

export interface CheckRun {
  result: MCPConformanceResult;
  check: MCPCheckResult | undefined;
}

/** Run one check through the real conformance runner. */
export async function runOneCheck(
  checkId: string,
  config: Omit<MCPConformanceConfig, "checkIds">,
): Promise<CheckRun> {
  const result = await new MCPConformanceTest({
    readinessIds: [],
    checkTimeout: 5_000,
    __suppressTelemetry: true,
    ...config,
    checkIds: [checkId as MCPCheckId],
  }).run();
  return {
    result,
    check: result.checks.find((check) => check.id === checkId),
  };
}

export interface LegacyCorpus {
  requests: WireRequest[];
  sessions: WireSession[];
  runs: Map<string, CheckRun>;
}

/**
 * Run each check once, one after another, against a fresh legacy mock server
 * (stateful sessions, real localhost port) and record every request the server
 * received. Recording on the server side sees the localhost security checks
 * too, which use `node:http` and skip any `fetch` the runner is given.
 *
 * A request carrying a session id is tagged with the check that opened that
 * session; anything else with the check running when it arrived.
 */
export async function buildLegacyCorpus(
  checks: readonly string[],
  options: {
    protocolVersion?: MCPConformanceConfig["protocolVersion"];
    server?: Omit<Parameters<typeof startConformanceMockServer>[0] & object, "onRequest">;
    config?: Omit<MCPConformanceConfig, "checkIds" | "serverUrl" | "protocolVersion">;
  } = {},
): Promise<LegacyCorpus> {
  const received: Array<{ check: string; record: ConformanceMockRequest }> = [];
  let current = "";
  const server = await startConformanceMockServer({
    ...options.server,
    onRequest: (record) => received.push({ check: current, record }),
  });
  const runs = new Map<string, CheckRun>();
  try {
    for (const check of checks) {
      current = check;
      runs.set(
        check,
        await runOneCheck(check, {
          serverUrl: server.url,
          ...(options.protocolVersion
            ? { protocolVersion: options.protocolVersion }
            : {}),
          ...options.config,
        }),
      );
    }
    current = "";
    // Let the closes a run fires and forgets (a DELETE, a stream abort) land
    // before the records are read. Read BEFORE stopping the server: stopping
    // closes every socket, which would hide whether the client closed them.
    await new Promise((settle) => setTimeout(settle, 150));
    const owner = new Map<string, string>();
    for (const { check, record } of received) {
      if (record.mintedSessionId) owner.set(record.mintedSessionId, check);
    }
    const requests = received.map(({ check, record }): WireRequest => {
      const headers = headersToRecord(record.headers);
      const session = headers["mcp-session-id"];
      return {
        check: (session && owner.get(session)) || check,
        httpMethod: record.method,
        path: new URL(record.url, "http://server.invalid").pathname,
        headers,
        body: record.body,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        mintedSessionId: record.mintedSessionId,
        responseContentType: record.responseContentType,
      };
    });
    return { requests, sessions: sessionsOf(requests), runs };
  } finally {
    await server.stop();
  }
}

/**
 * A `fetch` that records each request it sends (tagged with `check()`) before
 * handing it to `inner`. For socket-free fixtures such as `createFixtureHandler`.
 */
export function recordingFetch(
  inner: (request: Request) => Promise<Response>,
  sink: WireRequest[],
  check: () => string,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const text = request.body ? await request.clone().text() : "";
    const entry: WireRequest = {
      check: check(),
      httpMethod: request.method,
      path: new URL(request.url).pathname,
      headers: headersToRecord(request.headers),
      body: parseJson(text),
      startedAt: performance.now(),
    };
    sink.push(entry);
    request.signal.addEventListener(
      "abort",
      () => {
        entry.abortedAt = performance.now();
      },
      { once: true },
    );
    try {
      const response = await inner(request);
      entry.responseContentType =
        response.headers.get("content-type") ?? undefined;
      if (entry.responseContentType?.includes("application/json")) {
        entry.responseJson = await response
          .clone()
          .json()
          .catch(() => undefined);
      }
      return response;
    } finally {
      entry.endedAt = performance.now();
    }
  };
}

export interface FetchCorpus {
  requests: WireRequest[];
  runs: Map<string, CheckRun>;
}

/** Run each check once against an in-process handler, recording at the fetch seam. */
export async function buildFetchCorpus(
  checks: readonly string[],
  handler: { fetch: (request: Request) => Promise<Response> },
  config: Omit<MCPConformanceConfig, "checkIds" | "serverUrl" | "fetchFn">,
): Promise<FetchCorpus> {
  const requests: WireRequest[] = [];
  const runs = new Map<string, CheckRun>();
  for (const check of checks) {
    runs.set(
      check,
      await runOneCheck(check, {
        serverUrl: "http://localhost/mcp",
        fetchFn: recordingFetch((request) => handler.fetch(request), requests, () => check),
        ...config,
      }),
    );
  }
  return { requests, runs };
}

/** Two requests overlap in time (both outstanding at once). */
export function overlaps(a: WireRequest, b: WireRequest): boolean {
  const aEnd = a.endedAt ?? Number.POSITIVE_INFINITY;
  const bEnd = b.endedAt ?? Number.POSITIVE_INFINITY;
  return a.startedAt < bEnd && b.startedAt < aEnd;
}
