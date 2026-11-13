/**
 * A hosted run that grades a stored plugin version.
 *
 * The worker asks the backend for a link to the version's ZIP on its lease,
 * downloads it, checks it parses to the version's hash, grades the package
 * lane beside the saved server, and records the version on the report. What
 * is pinned here is each backend answer's exit: a lost lease writes nothing,
 * every other refusal fails the run with its reason before anything dials,
 * and a tampered byte never reaches the grader.
 *
 * The backend client is mocked as in `worker.test.ts`. The bundle route and
 * the download link are `run-package.ts`'s own two fetches, answered here, on
 * S4a's sample ChatGPT package.
 */

import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createZipPluginFileSource } from "@mcpjam/sdk";
import { parsePluginBundle } from "@mcpjam/sdk/plugin-bundle";
import {
  SAMPLE_SERVER_URL,
  samplePackageFiles,
} from "../../../../../sdk/tests/plugin-bundle/chatgpt-package-fixtures.js";

const claimReadinessRun = vi.fn();
const heartbeatReadinessRun = vi.fn();
const finalizeReadinessRun = vi.fn();
const failReadinessRun = vi.fn();
const getReadinessRunSubmission = vi.fn();

const { ReadinessLeaseLostError } = await import("../runner.js");
const { ReadinessSubmissionUnreadableError } = await vi.importActual<
  typeof import("../backend-client.js")
>("../backend-client.js");

vi.mock("../backend-client.js", () => ({
  claimReadinessRun: (...args: unknown[]) => claimReadinessRun(...args),
  heartbeatReadinessRun: (...args: unknown[]) => heartbeatReadinessRun(...args),
  finalizeReadinessRun: (...args: unknown[]) => finalizeReadinessRun(...args),
  failReadinessRun: (...args: unknown[]) => failReadinessRun(...args),
  requestManagedObservations: vi.fn(),
  getReadinessRunSubmission: (...args: unknown[]) =>
    getReadinessRunSubmission(...args),
  ReadinessLeaseLostError,
  ReadinessSubmissionUnreadableError,
}));

// Dynamic for the reason `worker.test.ts` gives: the mock factory closes over
// the error class imported above.
const { executeHostedReadinessRun } = await import("../worker.js");

const LEASE = { runId: "run_1", jobId: "job_1" };
const BUNDLE_ROUTE = "/internal/v1/claude-readiness/runs/plugin-bundle";
const LINK = "https://site.example.com/web/artifact?t=signed";
const VERSION = {
  pluginVersionId: "pv_1",
  pluginId: "plugin_1",
  declaredVersion: "1.0.0",
};

/** The saved server: an MCP endpoint with one read-only tool. */
function wireFetch(): typeof fetch {
  const answers: Record<string, unknown> = {
    initialize: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      serverInfo: { name: "sample-notes", version: "1" },
    },
    "tools/list": {
      tools: [
        {
          name: "search_notes",
          description: "Search the workspace's notes for a phrase.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
      ],
    },
    "resources/list": { resources: [] },
  };
  return (async (_url: unknown, init?: RequestInit) => {
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "HEAD") return new Response(null, { status: 200 });
    if (method === "GET") return new Response("", { status: 404 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    const result = answers[String(body.method)];
    return Response.json(
      result === undefined
        ? {
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "unknown method" },
          }
        : { jsonrpc: "2.0", id: body.id, result },
    );
  }) as typeof fetch;
}

/** Stored, not deflated, so a test can find a file's bytes in the archive. */
async function storedZip(): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(samplePackageFiles())) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}

/** The hash the backend pinned at import: the parser's, under its profile. */
async function bundleHashOf(bytes: Uint8Array): Promise<string> {
  const source = await createZipPluginFileSource(bytes);
  return (await parsePluginBundle(source, { profile: "openai-compatible" }))
    .bundleHash;
}

/** One byte of `text`'s first occurrence changed, the archive's length kept. */
function tamper(bytes: Uint8Array, text: string): Uint8Array {
  const needle = new TextEncoder().encode(text);
  const at = Buffer.from(bytes).indexOf(Buffer.from(needle));
  if (at < 0) throw new Error(`"${text}" is not in the archive`);
  const copy = Uint8Array.from(bytes);
  copy[at] = copy[at]! ^ 0x01;
  return copy;
}

type Answer = { status: number; body: unknown };

/** The bundle route's answer and what the link serves. Records each fetch. */
function stubBackend(link: Answer, download?: () => Response) {
  const calls: Array<{ url: URL; token: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const token = new Headers(init?.headers).get("x-inspector-service-token");
      calls.push({ url, token });
      if (url.pathname === BUNDLE_ROUTE) {
        return Response.json(link.body, { status: link.status });
      }
      if (url.href === LINK && download) return download();
      throw new Error(`unexpected fetch ${url.href}`);
    }),
  );
  return calls;
}

function linkTo(
  bytes: Uint8Array,
  bundleHash: string,
  size = bytes.byteLength,
) {
  return {
    status: 200,
    body: { ok: true, ...VERSION, bundleHash, size, url: LINK, expiresAt: 1 },
  };
}

function run(fetchFn: typeof fetch = wireFetch()) {
  return executeHostedReadinessRun({
    lease: LEASE,
    publisher: "openai",
    submissionMode: "mcp-uploaded-skills",
    target: SAMPLE_SERVER_URL,
    fetchFn,
    includeLlmObservations: false,
    submissionId: "sub_1",
  });
}

function laneOf(lane: string) {
  const summary = finalizeReadinessRun.mock.calls[0]![1] as {
    lanes: Array<{ lane: string; status: string; evaluated: number }>;
  };
  return summary.lanes.find((entry) => entry.lane === lane);
}

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  claimReadinessRun.mockResolvedValue({ status: "claimed" });
  heartbeatReadinessRun.mockResolvedValue({ alive: true });
  finalizeReadinessRun.mockResolvedValue({ applied: true });
  failReadinessRun.mockResolvedValue({ applied: true });
  getReadinessRunSubmission.mockResolvedValue({
    submissionId: "sub_1",
    submissionRevision: 2,
    flowId: "chatgpt-plugin",
    flowVersion: "2026-11-13",
    answers: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("a run that grades a stored plugin version", () => {
  it("grades its package beside the saved server, and records the version", async () => {
    const bytes = await storedZip();
    const bundleHash = await bundleHashOf(bytes);
    const calls = stubBackend(
      linkTo(bytes, bundleHash),
      () => new Response(bytes),
    );
    const wire = vi.fn(wireFetch());
    await run(wire as typeof fetch);

    expect(failReadinessRun).not.toHaveBeenCalled();
    expect(laneOf("plugin-package")).toMatchObject({
      status: "ready",
      notEvaluated: 0,
      missingInputs: [],
    });
    // The server lane dialled the run's saved server.
    expect(wire).toHaveBeenCalled();
    expect(laneOf("runtime-compatibility")!.evaluated).toBeGreaterThan(0);
    const report = finalizeReadinessRun.mock.calls[0]![2] as Record<
      string,
      unknown
    >;
    expect(report.gradedPluginVersion).toEqual({ ...VERSION, bundleHash });

    // The lease route carries the lease and the service token; the link
    // authorizes itself and never sees the token.
    expect(calls.map(({ url }) => url.pathname)).toEqual([
      BUNDLE_ROUTE,
      "/web/artifact",
    ]);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual(LEASE);
    expect(calls.map(({ token }) => token)).toEqual(["service-token", null]);
  });

  it("fails the run, and grades nothing, when one byte was tampered with", async () => {
    const bytes = await storedZip();
    const bundleHash = await bundleHashOf(bytes);
    const tampered = tamper(bytes, "Initial release.");
    stubBackend(linkTo(bytes, bundleHash), () => new Response(tampered));
    const wire = vi.fn(wireFetch());
    await run(wire as typeof fetch);

    expect(wire).not.toHaveBeenCalled();
    expect(finalizeReadinessRun).not.toHaveBeenCalled();
    expect(failReadinessRun).toHaveBeenCalledWith(
      LEASE,
      "plugin_bundle_mismatch",
      expect.stringMatching(/do not match this run's plugin version/),
    );
  });

  it("writes nothing when the lease is lost before the link", async () => {
    const calls = stubBackend({
      status: 409,
      body: { ok: false, error: "lease_lost" },
    });
    const wire = vi.fn(wireFetch());
    await run(wire as typeof fetch);

    expect(calls).toHaveLength(1);
    expect(wire).not.toHaveBeenCalled();
    expect(finalizeReadinessRun).not.toHaveBeenCalled();
    expect(failReadinessRun).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a version whose files are gone",
      { status: 404, body: { ok: false, error: "bundle_unavailable" } },
      "plugin_bundle_unavailable",
      /files of this run's plugin version are missing/,
    ],
    [
      "a run that froze no version",
      { status: 404, body: { ok: false, error: "no_plugin_version" } },
      "plugin_bundle_unavailable",
      /names no plugin version/,
    ],
    [
      "a ZIP over the download ceiling",
      {
        status: 413,
        body: {
          ok: false,
          error: "bundle_too_large",
          size: 25_000_000,
          maxBytes: 20_905_984,
        },
      },
      "plugin_bundle_too_large",
      /larger than the 20 MB a hosted run can download/,
    ],
    [
      "a backend that cannot answer",
      { status: 500, body: { ok: false, error: "Internal" } },
      "plugin_bundle_unavailable",
      /could not be downloaded/,
    ],
    [
      "a link with no address",
      {
        status: 200,
        body: { ok: true, ...VERSION, bundleHash: "h", size: 10 },
      },
      "plugin_bundle_unavailable",
      /could not be downloaded/,
    ],
  ])(
    "fails the run on %s, before dialling the server",
    async (_label, link, reason, message) => {
      stubBackend(link);
      const wire = vi.fn(wireFetch());
      await run(wire as typeof fetch);

      expect(wire).not.toHaveBeenCalled();
      expect(finalizeReadinessRun).not.toHaveBeenCalled();
      const [lease, terminalReason, errorMessage] =
        failReadinessRun.mock.calls[0]!;
      expect(lease).toEqual(LEASE);
      expect(terminalReason).toBe(reason);
      expect(String(errorMessage)).toMatch(message);
    },
  );

  function expectNotDownloaded() {
    expect(finalizeReadinessRun).not.toHaveBeenCalled();
    expect(failReadinessRun).toHaveBeenCalledWith(
      LEASE,
      "plugin_bundle_unavailable",
      expect.stringMatching(/could not be downloaded/),
    );
  }

  it("fails the run when the link no longer serves the ZIP", async () => {
    const bytes = await storedZip();
    stubBackend(linkTo(bytes, "h"), () => new Response("", { status: 403 }));
    await run();
    expectNotDownloaded();
  });

  it("fails the run when the link serves more bytes than the version has", async () => {
    const bytes = await storedZip();
    stubBackend(
      linkTo(bytes, "h", bytes.byteLength - 1),
      () => new Response(bytes),
    );
    await run();
    expectNotDownloaded();
  });

  it("never downloads a version the ceiling already rules out", async () => {
    const calls = stubBackend(linkTo(new Uint8Array(), "h", 25_000_000));
    await run();

    expect(calls).toHaveLength(1);
    expect(failReadinessRun).toHaveBeenCalledWith(
      LEASE,
      "plugin_bundle_too_large",
      expect.stringMatching(/MCPJam CLI/),
    );
  });

  it("asks for no package when the run's shape has none", async () => {
    const calls = stubBackend({ status: 500, body: {} });
    await executeHostedReadinessRun({
      lease: LEASE,
      publisher: "openai",
      submissionMode: "mcp-only",
      target: SAMPLE_SERVER_URL,
      fetchFn: wireFetch(),
      includeLlmObservations: false,
    });

    expect(calls).toEqual([]);
    expect(failReadinessRun).not.toHaveBeenCalled();
    const report = finalizeReadinessRun.mock.calls[0]![2] as Record<
      string,
      unknown
    >;
    expect(report).not.toHaveProperty("gradedPluginVersion");
  });
});
