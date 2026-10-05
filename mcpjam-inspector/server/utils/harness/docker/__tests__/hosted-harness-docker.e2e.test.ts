/**
 * The HOSTED harness path, end to end, against a real box — in CI.
 *
 * `runHarnessTurn` drives the real `HarnessAgent`, the real registry adapters
 * (the hosted Claude Code adapter; Codex on the app-server transport), the
 * real bridges and the real vendor CLIs, inside a container built from the
 * computer template's own bake context (`docker/test-image.Dockerfile`),
 * reached through the Docker provider behind the same factory production uses.
 * The only stand-ins:
 *   - the MODEL: `local/conformance/mock-anthropic.mjs` (Claude Code) and
 *     `mock-responses.mjs` (Codex), the conformance suite's deterministic
 *     upstreams, reached directly at their loopback URL;
 *   - the E2B-ONLY and control-plane pieces, mocked at their module boundary:
 *     the model-broker lease and its egress transform (`harness-model-broker`),
 *     the box reservation, the continuity sidecar (`harness-session-state`),
 *     runtime skills, and the MCP proxy-token mint + public proxy URL (the
 *     box is pointed straight at a local MCP endpoint). NONE of those are
 *     covered here, and nothing here says anything about the E2B path.
 *
 * What is pinned:
 *   - GOLDENS: the mapped UI stream parts and the tool evidence (the engine's
 *     `onToolCall`/`onToolResult` events, the persisted history), ids and
 *     timestamps normalized, under `goldens/`. Regenerate with
 *     `UPDATE_HARNESS_GOLDENS=1`.
 *   - LIFECYCLE: a fresh baked start (no install), a stream failure after
 *     partial output reported once, cancellation, stream termination,
 *     evidence attribution, and at most one terminal part per turn — plus no
 *     runtime process left in the box and exactly one broker revoke after each.
 *
 * Skipped unless `HARNESS_DOCKER_IMAGE` names a built test image (the
 * `hosted-harness-docker` workflow builds one and sets it). That and
 * `UPDATE_HARNESS_GOLDENS=1` (rewrite the goldens) are test inputs read only by
 * this file, not settings of the application. One harness at a time is
 * `-t claude-code` / `-t codex` (the CI matrix). Locally, from
 * `mcpjam-inspector/` on a Linux Docker host (`--network host`):
 *
 *   node scripts/harness-bake-context.mjs --out /tmp/hh/harness-bake
 *   docker build -f server/utils/harness/docker/test-image.Dockerfile \
 *     -t mcpjam-harness-test /tmp/hh
 *   HARNESS_DOCKER_IMAGE=mcpjam-harness-test npx vitest run --maxWorkers=1 \
 *     server/utils/harness/docker/__tests__/hosted-harness-docker.e2e.test.ts
 *
 * The goldens are not recipe-identity-sensitive; a stream-mapping change or a
 * runtime bump that changes what the vendor CLI emits is what moves them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { jsonSchema, tool } from "ai";

const IMAGE = process.env.HARNESS_DOCKER_IMAGE?.trim() ?? "";
const ENABLED = IMAGE.length > 0;
const UPDATE = process.env.UPDATE_HARNESS_GOLDENS === "1";
const HERE = __dirname;
const GOLDENS = join(HERE, "goldens");
const CONFORMANCE = resolve(HERE, "../../local/conformance");
const TURN_TIMEOUT_MS = 240_000;

const mocks = vi.hoisted(() => ({
  upstreamBaseUrl: "",
  mcpUrl: "",
  revoke: vi.fn(async () => {}),
  start: vi.fn(),
}));

vi.mock("../../harness-model-broker.js", () => ({
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  renewHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: mocks.revoke,
  // The lease would be installed into E2B's egress transform; here the box
  // reaches the mock upstream directly, so the "proxy" IS the upstream.
  startHarnessModelBroker: vi.fn(async (args: { harnessId: string }) => {
    mocks.start(args);
    return {
      ok: true,
      runId: `broker-${randomUUID()}`,
      expiresAt: Date.now() + 10 * 60_000,
      protocol: args.harnessId === "codex" ? "openai" : "anthropic",
      proxyBaseUrl:
        args.harnessId === "codex"
          ? `${mocks.upstreamBaseUrl}/v1`
          : mocks.upstreamBaseUrl,
      delivery: "e2b-network-transform",
    };
  }),
}));

vi.mock("../../harness-session-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../harness-session-state.js")>()),
  claimHarnessSessionState: vi.fn(async () => ({
    ok: true,
    leaseId: "lease-e2e",
    stateVersion: 1,
    state: null,
    fingerprintChanged: false,
  })),
  commitHarnessSessionState: vi.fn(async () => true),
  heartbeatHarnessSessionState: vi.fn(async () => "ok"),
  releaseHarnessSessionState: vi.fn(async () => {}),
}));

vi.mock("../../runtime-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime-skills.js")>()),
  fetchRuntimeSkills: vi.fn(async () => ({ ok: true, skills: [] })),
  fetchRuntimeSkillFiles: vi.fn(async () => ({ ok: true, files: [] })),
}));

vi.mock("../../harness-proxy-token-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../harness-proxy-token-client.js")
  >()),
  fetchHarnessProxyTokens: vi.fn(
    async ({ serverIds }: { serverIds: string[] }) => ({
      ok: true,
      tokens: Object.fromEntries(
        serverIds.map((id) => [id, "e2e-proxy-token"]),
      ),
    }),
  ),
}));

vi.mock("../../harness-proxy-strategy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../harness-proxy-strategy.js")>()),
  // The public MCP proxy route is the inspector's HTTP server, which this
  // test does not run; the box is pointed at the MCP endpoint directly.
  resolveHarnessProxyUrl: vi.fn(async () => mocks.mcpUrl),
}));

vi.mock("../../resolve-sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../resolve-sandbox.js")>()),
  resolveHarnessSandbox: vi.fn(async () => {
    throw new Error("the e2e turn must run on its bound container");
  }),
}));

import { runHarnessTurn } from "../../run-harness-turn.js";
import { HARNESS_PINNED_VERSIONS } from "@/shared/harness-model-support";

type Chunk = Record<string, unknown> & { type: string };
type HarnessId = "claude-code" | "codex";

const HARNESSES: Record<
  HarnessId,
  {
    modelId: string;
    provider: string;
    mock: string;
    shell: (cmd: string) => string;
    mcpServerId: string;
    mcpToolName: string;
    vendorProcess: string;
    cancelOrphansToolCommand: boolean;
  }
> = {
  "claude-code": {
    modelId: "anthropic/claude-haiku-4.5",
    provider: "anthropic",
    mock: "mock-anthropic.mjs",
    shell: (cmd) => `BASH ${cmd}`,
    // NATIVE delivery: the box's own MCP client calls the server.
    mcpServerId: "delivery_probe",
    mcpToolName: "ping",
    // The SDK's own platform binary — the process the bridge drives.
    vendorProcess: "claude-agent-sdk-linux",
    cancelOrphansToolCommand: false,
  },
  codex: {
    modelId: "openai/gpt-5.5",
    provider: "openai",
    mock: "mock-responses.mjs",
    shell: (cmd) => `SHELL ${cmd}`,
    // HOST-EXECUTED delivery: the relay calls back into this process.
    mcpServerId: "probe",
    mcpToolName: "echo",
    vendorProcess: "bin/codex app-server",
    // KNOWN GAP, found by this test: cancelling a Codex app-server turn tears
    // down the bridge and the app-server, but the exec command it had started
    // runs in its own session and is orphaned until it ends — here as on E2B.
    // Tolerated (not required): a fix makes this a no-op, not a failure.
    cancelOrphansToolCommand: true,
  },
};

function docker(args: string[], options: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (options.allowFail) return "";
    throw error;
  }
}

async function startMockUpstream(
  script: string,
): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(process.execPath, [join(CONFORMANCE, script)], {
    env: {
      ...process.env,
      MOCK_PORT: "0",
      MOCK_LATENCY_MS: process.env.MOCK_LATENCY_MS ?? "50",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const line = await new Promise<string>((resolveLine, reject) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", resolveLine);
    child.once("exit", (code) => reject(new Error(`${script} exited ${code}`)));
  });
  const { port } = JSON.parse(line) as { port: number };
  return { url: `http://127.0.0.1:${port}`, child };
}

/** A host-side MCP manager exposing ONE deterministic tool, for host-executed delivery. */
function probeManager(
  serverId: string,
  toolName: string,
  calls: { n: number },
) {
  return {
    getServerConfig: (id: string) =>
      id === serverId
        ? { url: new URL("http://probe.invalid/mcp") }
        : undefined,
    getToolsForAiSdk: async (ids: string[]) => {
      if (!ids.includes(serverId)) return {};
      const probe = tool({
        description: "Echo a message back (hosted e2e probe).",
        inputSchema: jsonSchema<{ message?: string }>({
          type: "object",
          properties: { message: { type: "string" } },
          additionalProperties: false,
        }),
        execute: async (input) => {
          calls.n += 1;
          return {
            content: [
              { type: "text", text: `PROBE_ECHO ${input.message ?? ""}` },
            ],
          };
        },
      });
      // The manager tags every tool with its server, as the real one does.
      return { [toolName]: Object.assign(probe, { _serverId: serverId }) };
    },
  };
}

/**
 * The NATIVE-delivery MCP endpoint the box's own MCP client calls (what the
 * inspector's public `/api/web/harness-mcp/<id>` proxy route would be). The
 * same minimal Streamable-HTTP server as the conformance suite's
 * `delivery-mcp.ts`, except it accepts the correlation query the hosted
 * `.mcp.json` appends, and records what each call carried.
 */
async function startProbeMcp(toolName: string) {
  const received: Array<{ proxyToken?: string; correlated: boolean }> = [];
  let calls = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://probe");
    if (url.pathname !== "/mcp") return void response.writeHead(404).end();
    if (request.method !== "POST") return void response.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.id === undefined) return void response.writeHead(202).end();
    let result: unknown = {};
    if (message.method === "initialize") {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "hosted-e2e-probe", version: "1" },
      };
    } else if (message.method === "tools/list") {
      result = {
        tools: [
          {
            name: toolName,
            description: "Hosted e2e probe",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: true },
          },
        ],
      };
    } else if (message.method === "tools/call") {
      calls += 1;
      received.push({
        proxyToken: request.headers["x-mcpjam-proxy-token"] as
          string | undefined,
        correlated: url.searchParams.size > 0,
      });
      result = { content: [{ type: "text", text: "PROBE_MCP_OK" }] };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls: () => calls,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Parse the UI message stream's SSE body into chunks. */
async function readChunks(
  response: Response,
  onChunk: (chunk: Chunk) => void,
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    let index: number;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        const chunk = JSON.parse(data) as Chunk;
        chunks.push(chunk);
        onChunk(chunk);
      }
    }
  }
  return chunks;
}

// ── Normalization ────────────────────────────────────────────────────────────

const VOLATILE_KEYS = /(^|_)(id|ids)$|Id$|^id$/;
const TIME_KEYS = /(At|Ms|Time|timestamp|time|duration|elapsed|latency)$/i;

function normalizer() {
  const ids = new Map<string, string>();
  const idFor = (value: string) => {
    if (!ids.has(value)) ids.set(value, `<id-${ids.size + 1}>`);
    return ids.get(value)!;
  };
  const scrubString = (value: string) =>
    value
      .replace(
        /\/home\/user\/(claude-code|codex)-[A-Za-z0-9_-]+/g,
        "/home/user/<session-dir>",
      )
      .replace(/\.agent-runs\/[A-Za-z0-9_-]+/g, ".agent-runs/<session>")
      .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
      // Claude Code's own context-budget reminder, echoed back by the mock.
      .replace(
        /<total_tokens>\d+ tokens left<\/total_tokens>/g,
        "<total_tokens>N tokens left</total_tokens>",
      )
      .replace(
        /shell-snapshots\/snapshot-[A-Za-z0-9-]+\.sh/g,
        "shell-snapshots/<snapshot>.sh",
      )
      // Codex's exec-output envelope, echoed back by the mock.
      .replace(/Chunk ID: [0-9a-f]+/g, "Chunk ID: <id>")
      .replace(/Wall time: [0-9.]+ seconds/g, "Wall time: <time> seconds")
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        (m) => idFor(m),
      )
      .replace(
        /\b(toolu|call_mock|msg|resp_mock|msg_mock|fc_mock)_[A-Za-z0-9_]+/g,
        (m) => idFor(m),
      );
  const walk = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, walk(v, k)]),
      );
    }
    if (typeof value === "number" && TIME_KEYS.test(key)) return "<time>";
    if (typeof value === "string") {
      if (TIME_KEYS.test(key)) return "<time>";
      if (VOLATILE_KEYS.test(key) && key !== "serverId" && key !== "harnessId")
        return idFor(value);
      return scrubString(value);
    }
    return value;
  };
  return walk;
}

function assertGolden(name: string, actual: unknown) {
  mkdirSync(GOLDENS, { recursive: true });
  const path = join(GOLDENS, `${name}.json`);
  const text = `${JSON.stringify(actual, null, 2)}\n`;
  if (UPDATE) {
    writeFileSync(path, text);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(
      `no golden at ${path}; run with UPDATE_HARNESS_GOLDENS=1 to create it and review the diff`,
    );
  }
  expect(JSON.parse(text)).toEqual(JSON.parse(readFileSync(path, "utf8")));
}

const TERMINAL = new Set(["finish", "error", "abort"]);

describe.skipIf(!ENABLED)("hosted harness on a baked Docker box", () => {
  for (const harness of Object.keys(HARNESSES) as HarnessId[]) {
    const spec = HARNESSES[harness];
    describe(harness, () => {
      let upstream: { url: string; child: ChildProcess };
      let mcp: Awaited<ReturnType<typeof startProbeMcp>> | undefined;
      const probeCalls = { n: 0 };
      const container = `mcpjam-harness-e2e-${harness}-${process.pid}`;

      beforeAll(async () => {
        vi.stubEnv("HARNESS_SANDBOX_PROVIDER", "docker");
        upstream = await startMockUpstream(spec.mock);
        mocks.upstreamBaseUrl = upstream.url;
        if (harness === "claude-code") {
          mcp = await startProbeMcp(spec.mcpToolName);
          mocks.mcpUrl = mcp.url;
        }
        docker(["rm", "-f", container], { allowFail: true });
        // `--network host`: the box reaches the mock upstream and the MCP
        // endpoint on loopback, and this process reaches the bridge the same way.
        // `--init` reaps orphans the way the box's own init does on E2B, so a
        // zombie is never mistaken for (or hides) a leaked process.
        docker([
          "run",
          "-d",
          "--rm",
          "--init",
          "--network",
          "host",
          "--name",
          container,
          IMAGE,
        ]);
      }, 120_000);

      afterAll(async () => {
        docker(["rm", "-f", container], { allowFail: true });
        upstream?.child.kill();
        await mcp?.close();
        vi.unstubAllEnvs();
      });

      /**
       * Processes left in the box besides its idle init. `allowOrphanedTools`
       * tolerates a TOOL command whose runtime crashed under it: the vendor CLI
       * starts tool shells in their own session, so when the CLI is killed
       * they are orphaned outside the bridge's process group and run to
       * completion — on E2B as here. The bridge and the vendor CLI themselves
       * must still be gone.
       */
      async function leftovers(
        options: { allowOrphanedTools?: string } = {},
      ): Promise<string[]> {
        const deadline = Date.now() + 20_000;
        let left: string[] = [];
        while (Date.now() < deadline) {
          left = docker(["exec", container, "ps", "-eo", "args="])
            .split("\n")
            .map((l) => l.trim())
            .filter(
              (l) =>
                l &&
                !/^sleep infinity$/.test(l) &&
                !/^\/sbin\/docker-init\b/.test(l) &&
                !/^ps -eo/.test(l) &&
                !(
                  options.allowOrphanedTools &&
                  l.includes(options.allowOrphanedTools)
                ),
            );
          if (left.length === 0) return left;
          await new Promise((r) => setTimeout(r, 500));
        }
        return left;
      }

      async function turn(
        prompt: string,
        control: {
          onChunk?: (chunk: Chunk, all: Chunk[], abort: () => void) => void;
        } = {},
      ) {
        const controller = new AbortController();
        const toolCalls: unknown[] = [];
        const toolResults: unknown[] = [];
        const engineErrors: Array<{ phase?: string; message?: string }> = [];
        let history: ModelMessage[] | undefined;
        mocks.revoke.mockClear();
        mocks.start.mockClear();
        const messages = [
          { role: "user", content: [{ type: "text", text: prompt }] },
        ] as unknown as ModelMessage[];
        const result = await runHarnessTurn(
          {
            messages,
            modelId: spec.modelId,
            provider: spec.provider,
            systemPrompt: "You are running the hosted harness e2e check.",
            authHeader: "Bearer e2e",
            projectId: "project-e2e",
            mcpClientManager:
              harness === "codex"
                ? probeManager(spec.mcpServerId, spec.mcpToolName, probeCalls)
                : {
                    getServerConfig: (id: string) =>
                      id === spec.mcpServerId
                        ? { url: mocks.mcpUrl }
                        : undefined,
                  },
            selectedServers: [spec.mcpServerId],
            requireToolApproval: false,
            sourceType: "eval",
            harness,
            harnessSandboxBinding: {
              sandboxRowId: "sbxrow-e2e",
              sandboxId: container,
              workdir: "/home/user",
            },
            harnessMcpProxy: {
              plane: "web-authorized",
              mode: "direct",
              publicBaseUrl: "https://inspector.e2e.invalid",
            },
            abortSignal: controller.signal,
            onToolCall: (event: unknown) => toolCalls.push(event),
            onToolResult: (event: unknown) => {
              toolResults.push(event);
            },
            onEngineError: (event: { phase?: string; message?: string }) =>
              engineErrors.push(event),
            onConversationComplete: (full: ModelMessage[]) => {
              history = full;
            },
          } as never,
          "ui",
        );
        const all: Chunk[] = [];
        const chunks = await readChunks(
          (result as { response: Response }).response,
          (chunk) => {
            all.push(chunk);
            control.onChunk?.(chunk, all, () => controller.abort());
          },
        );
        return { chunks, toolCalls, toolResults, engineErrors, history };
      }

      function terminalParts(chunks: Chunk[]) {
        return chunks.filter((c) => TERMINAL.has(c.type));
      }

      it(
        "starts on the baked runtime without installing it",
        async () => {
          const before = docker([
            "exec",
            container,
            "sh",
            "-c",
            "ls -a /home/user/.harness-bootstrap/*/ | grep -c '^.bootstrap-.*\\.ok$'",
          ]).trim();
          const { chunks } = await turn("COUNT");
          expect(terminalParts(chunks)).toEqual([
            expect.objectContaining({ type: "finish" }),
          ]);
          // The framework found the template's marker and wrote none of its own.
          const markers = docker([
            "exec",
            container,
            "sh",
            "-c",
            'for f in /home/user/.harness-bootstrap/*/.bootstrap-*.ok; do head -c 200 "$f"; echo; done',
          ]);
          expect(markers).toContain('"bakedBy":"mcpjam-harness-bake"');
          expect(
            docker([
              "exec",
              container,
              "sh",
              "-c",
              "ls -a /home/user/.harness-bootstrap/*/ | grep -c '^.bootstrap-.*\\.ok$'",
            ]).trim(),
          ).toBe(before);
          // And it is the version the inspector pins.
          expect(markers).toContain(
            `"${harness}":"${HARNESS_PINNED_VERSIONS[harness]}"`,
          );
        },
        TURN_TIMEOUT_MS,
      );

      it(
        "maps a native tool turn to the golden stream and evidence",
        async () => {
          const result = await turn(spec.shell("echo golden-$((6*7))"));
          const terminals = terminalParts(result.chunks);
          expect(terminals).toHaveLength(1);
          expect(terminals[0]!.type).toBe("finish");
          expect(result.engineErrors).toEqual([]);
          expect(mocks.revoke).toHaveBeenCalledTimes(1);
          expect(await leftovers()).toEqual([]);
          const normalize = normalizer();
          assertGolden(`${harness}.native-tool`, {
            stream: normalize(result.chunks),
            evidence: normalize({
              toolCalls: result.toolCalls,
              toolResults: result.toolResults,
              history: result.history,
            }),
          });
        },
        TURN_TIMEOUT_MS,
      );

      it(
        "attributes an MCP call to its server, in the golden stream and evidence",
        async () => {
          const callsBefore =
            harness === "codex" ? probeCalls.n : (mcp?.calls() ?? 0);
          const result = await turn("MCPPROBE");
          expect(terminalParts(result.chunks)).toEqual([
            expect.objectContaining({ type: "finish" }),
          ]);
          // Exactly one real call reached the server.
          const callsAfter =
            harness === "codex" ? probeCalls.n : (mcp?.calls() ?? 0);
          expect(
            callsAfter - callsBefore,
            JSON.stringify(result.chunks).slice(0, 4000),
          ).toBe(1);
          if (mcp) {
            // The proxy token and the correlation the hosted `.mcp.json`
            // carries reached the server with the call.
            expect(mcp.received.at(-1)).toEqual({
              proxyToken: "e2e-proxy-token",
              correlated: true,
            });
          }
          // Evidence attribution: the MCP call names its server; nothing else does.
          const attributed = (
            result.toolCalls as Array<{ serverId?: string; toolName: string }>
          ).filter((c) => c.serverId !== undefined);
          expect(attributed).toEqual([
            expect.objectContaining({ serverId: spec.mcpServerId }),
          ]);
          expect(mocks.revoke).toHaveBeenCalledTimes(1);
          expect(await leftovers()).toEqual([]);
          const normalize = normalizer();
          assertGolden(`${harness}.mcp-tool`, {
            stream: normalize(result.chunks),
            evidence: normalize({
              toolCalls: result.toolCalls,
              toolResults: result.toolResults,
              history: result.history,
            }),
          });
        },
        TURN_TIMEOUT_MS,
      );

      it(
        "ends a cancelled turn once, and leaves nothing running in the box",
        async () => {
          let aborted = false;
          const result = await turn(spec.shell("sleep 45; echo never"), {
            onChunk: (chunk, _all, abort) => {
              if (!aborted && chunk.type === "tool-input-available") {
                aborted = true;
                // Let the command actually start in the box first.
                setTimeout(abort, 1_500);
              }
            },
          });
          expect(aborted).toBe(true);
          // The stream TERMINATED (we are here), with at most one terminal
          // part and never a successful finish for a cancelled turn.
          const terminals = terminalParts(result.chunks);
          expect(terminals.length).toBeLessThanOrEqual(1);
          expect(
            result.chunks.some(
              (c) =>
                c.type === "tool-output-available" &&
                JSON.stringify(c).includes("never"),
            ),
          ).toBe(false);
          expect(mocks.revoke).toHaveBeenCalledTimes(1);
          expect(
            await leftovers(
              spec.cancelOrphansToolCommand
                ? { allowOrphanedTools: "sleep 45" }
                : {},
            ),
          ).toEqual([]);
        },
        TURN_TIMEOUT_MS,
      );

      it(
        "surfaces a runtime that dies after partial output as ONE typed stream failure",
        async () => {
          let killed = false;
          const result = await turn(spec.shell("sleep 45; echo never"), {
            onChunk: (chunk) => {
              if (!killed && chunk.type === "tool-input-available") {
                killed = true;
                setTimeout(() => {
                  // The vendor runtime dies under the turn, mid tool call. (A
                  // dead BRIDGE is the adapter's reconnect window — minutes —
                  // and is not exercised here.)
                  docker(
                    [
                      "exec",
                      "-u",
                      "user",
                      container,
                      "pkill",
                      "-KILL",
                      "-f",
                      spec.vendorProcess,
                    ],
                    { allowFail: true },
                  );
                }, 1_500);
              }
            },
          });
          expect(killed).toBe(true);
          // Partial output reached the client BEFORE the failure…
          if (result.chunks.findIndex((c) => c.type === "error") < 0) {
            throw new Error(
              `no error part: ${JSON.stringify(result.chunks).slice(-3000)}`,
            );
          }
          const firstError = result.chunks.findIndex((c) => c.type === "error");
          const firstToolInput = result.chunks.findIndex(
            (c) => c.type === "tool-input-available",
          );
          expect(firstToolInput).toBeGreaterThanOrEqual(0);
          expect(firstError).toBeGreaterThan(firstToolInput);
          // …and the failure is reported exactly once: one error part, no
          // finish after it, one engine error typed as a STREAM failure.
          const terminals = terminalParts(result.chunks);
          expect(terminals.filter((c) => c.type === "error")).toHaveLength(1);
          expect(terminals.filter((c) => c.type === "finish")).toHaveLength(0);
          expect(result.engineErrors).toHaveLength(1);
          expect(result.engineErrors[0]!.phase).toBe("stream");
          expect(mocks.revoke).toHaveBeenCalledTimes(1);
          expect(await leftovers({ allowOrphanedTools: "sleep 45" })).toEqual(
            [],
          );
        },
        TURN_TIMEOUT_MS,
      );
    });
  }
});
