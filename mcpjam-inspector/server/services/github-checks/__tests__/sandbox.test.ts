import { describe, expect, it, vi } from "vitest";
import {
  buildAndStart,
  CHECK_SANDBOX_TIMEOUT_MS,
  CheckStepError,
  clampOutput,
  cloneAndCheckout,
  lockDownEgress,
  OUTPUT_CLAMP_CHARS,
  PROBE_MAX_RESPONSE_BYTES,
  waitForMcpInitialize,
  type CheckSandbox,
} from "../sandbox";
import { listRecipeRepos, resolveCheckRecipe } from "../recipes";

// Everything this module runs is untrusted PR code, so the tests are written
// around the two properties that make that safe rather than around happy-path
// plumbing:
//
//   1. egress is revoked BEFORE the PR's server process starts, and a failed
//      revoke aborts instead of degrading to "start it anyway";
//   2. failures are attributed correctly — a broken build is the PR's
//      (`build_failed`), an unreachable E2B is ours (`infra_error`) — because
//      the attribution is what decides whether someone gets a red X.

const RECIPE = {
  build: "npm ci && npm run build",
  start: "npm start",
  port: 3001,
  mcpPath: "/mcp",
};

type Call = { command: string; opts?: Record<string, unknown> };

/**
 * Fake sandbox recording an ordered log of everything that happened, so
 * ordering assertions are about the real sequence and not a mocked promise.
 */
function fakeSandbox(options?: {
  exitCodes?: Record<string, number>;
  stdout?: Record<string, string>;
  stderr?: Record<string, string>;
  throwOn?: (command: string) => unknown;
  networkFails?: boolean;
  /** Emitted on the background command's stderr the moment it is spawned. */
  stderrOnSpawn?: string[];
}) {
  const events: string[] = [];
  const calls: Call[] = [];
  let stderrSink: ((data: string) => void) | undefined;

  const matchKey = (command: string, table?: Record<string, unknown>) => {
    if (!table) return undefined;
    return Object.keys(table).find((key) => command.includes(key));
  };

  const sandbox: CheckSandbox = {
    sandboxId: "sb_test",
    getHost: (port: number) => `${port}-sb_test.e2b.app`,
    commands: {
      run: async (command, opts) => {
        calls.push({ command, opts });
        events.push(opts?.background ? `spawn:${command}` : `run:${command}`);

        const thrown = options?.throwOn?.(command);
        if (thrown) throw thrown;

        if (opts?.background) {
          stderrSink = opts.onStderr;
          for (const chunk of options?.stderrOnSpawn ?? []) {
            stderrSink?.(chunk);
          }
          return { pid: 1234 };
        }

        const exitKey = matchKey(command, options?.exitCodes);
        const exitCode = exitKey ? options!.exitCodes![exitKey] : 0;
        const outKey = matchKey(command, options?.stdout);
        const errKey = matchKey(command, options?.stderr);
        const result = {
          exitCode,
          stdout: outKey ? options!.stdout![outKey] : "",
          stderr: errKey ? options!.stderr![errKey] : "",
        };
        if (exitCode !== 0) {
          // E2B throws on non-zero exit, carrying the streams on the error.
          throw Object.assign(new Error("command exited non-zero"), result);
        }
        return result;
      },
    },
    updateNetwork: async (network) => {
      events.push(`network:${JSON.stringify(network)}`);
      if (options?.networkFails) throw new Error("e2b network 502");
    },
    kill: async () => {
      events.push("kill");
    },
  };

  return {
    sandbox,
    events,
    calls,
    emitStderr: (chunk: string) => stderrSink?.(chunk),
  } as const;
}

/**
 * A COMPLETE initialize result. The probe mirrors the real client, which
 * validates the JSON-RPC envelope and `InitializeResultSchema` — so a fixture
 * missing `capabilities` or `serverInfo` is not a server the eval run could
 * have used either.
 */
const INITIALIZE_RESULT = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  serverInfo: { name: "fixture", version: "1.0.0" },
} as const;

const SSE_INITIALIZE_FRAME = `event: message\ndata: ${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: INITIALIZE_RESULT,
})}\n\n`;

function okInitialize(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: INITIALIZE_RESULT,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/**
 * A server that has no `initialize` and answers `server/discover` with the given
 * capabilities — the modern arm in isolation, so a capability-shape verdict is not
 * masked by the legacy arm accepting the same server.
 */
function discoverCapabilitiesFetch(
  capabilities: unknown,
  instructions?: unknown
): typeof fetch {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const parsed = JSON.parse(String(init.body)) as { method: string };
    if (parsed.method === "initialize") {
      return new Response("{}", {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: {
          supportedVersions: ["2026-07-28"],
          capabilities,
          ...(instructions === undefined ? {} : { instructions }),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as unknown as typeof fetch;
}

describe("buildAndStart", () => {
  it("locks down egress AFTER the build and BEFORE the server starts", async () => {
    const box = fakeSandbox();
    const fetchImpl = vi.fn(async () =>
      okInitialize()
    ) as unknown as typeof fetch;

    const started = await buildAndStart(box.sandbox, RECIPE, { fetchImpl });

    const buildIndex = box.events.findIndex((e) => e.includes("npm run build"));
    const networkIndex = box.events.findIndex((e) => e.startsWith("network:"));
    const spawnIndex = box.events.findIndex((e) => e.startsWith("spawn:"));

    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(networkIndex).toBeGreaterThan(buildIndex);
    expect(spawnIndex).toBeGreaterThan(networkIndex);
    // Egress off, inbound untouched.
    expect(box.events[networkIndex]).toBe(
      'network:{"allowInternetAccess":false}'
    );
    expect(started.url).toBe("https://3001-sb_test.e2b.app/mcp");
  });

  it("never starts the PR’s server if the egress lockdown fails", async () => {
    const box = fakeSandbox({ networkFails: true });
    const fetchImpl = vi.fn(async () =>
      okInitialize()
    ) as unknown as typeof fetch;

    await expect(
      buildAndStart(box.sandbox, RECIPE, { fetchImpl })
    ).rejects.toMatchObject({
      name: "CheckStepError",
      outcome: "infra_error",
    });

    // The load-bearing assertion: no background process was ever spawned.
    expect(box.events.some((e) => e.startsWith("spawn:"))).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("attributes a non-zero build to the PR, with a clamped log tail", async () => {
    const box = fakeSandbox({
      exitCodes: { "npm run build": 1 },
      stderr: { "npm run build": "npm ERR! missing script: build" },
    });

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    }).catch((e) => e as CheckStepError);

    expect(error).toBeInstanceOf(CheckStepError);
    expect((error as CheckStepError).outcome).toBe("build_failed");
    expect((error as CheckStepError).detailsMarkdown).toContain(
      "missing script: build"
    );
    // A failed build means no server and no egress change to make.
    expect(box.events.some((e) => e.startsWith("spawn:"))).toBe(false);
    expect(box.events.some((e) => e.startsWith("network:"))).toBe(false);
  });

  it("reports server_unhealthy with the server’s log tail when initialize never lands", async () => {
    // The started process complains in its log while the probe keeps failing.
    const box = fakeSandbox({
      stdout: { "tail -c": "Error: listen EADDRINUSE 127.0.0.1:3001" },
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl,
      healthTimeoutMs: 30,
      healthIntervalMs: 1,
    }).catch((e) => e as CheckStepError);
    expect((error as CheckStepError).outcome).toBe("server_unhealthy");
    expect((error as CheckStepError).detailsMarkdown).toContain("EADDRINUSE");
  });

  it("attributes a build that runs out its deadline to the PR, not to us", async () => {
    // E2B reports a command deadline as a TimeoutError with no exit code, which
    // lands in the transport branch and concludes `neutral` — letting a hanging
    // (or deliberately hanging) build dodge a red check.
    const box = fakeSandbox({
      throwOn: (command) =>
        command.includes("npm run build")
          ? Object.assign(new Error("deadline exceeded"), {
              name: "TimeoutError",
            })
          : undefined,
    });

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
      // Zero deadline: whatever happens, the elapsed time has reached it.
      buildTimeoutMs: 0,
    }).catch((e) => e as CheckStepError);

    expect((error as CheckStepError).outcome).toBe("build_failed");
    // And still no server, and no egress change.
    expect(box.events.some((e) => e.startsWith("spawn:"))).toBe(false);
  });

  it("keeps an E2B failure that merely looks like a timeout as infra_error", async () => {
    // E2B raises `TimeoutError` for Unavailable and Canceled RPCs too, not only
    // for a command deadline. Trusting the error's name would report an E2B
    // outage during `npm ci` as the PR's broken build — a red X on a good PR.
    const box = fakeSandbox({
      throwOn: (command) =>
        command.includes("npm run build")
          ? Object.assign(
              new Error(
                "sandbox is unavailable: This error is likely due to sandbox timeout."
              ),
              { name: "TimeoutError" }
            )
          : undefined,
    });

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
      // A deadline the failure cannot plausibly have reached.
      buildTimeoutMs: 10 * 60_000,
    }).catch((e) => e as CheckStepError);

    expect((error as CheckStepError).outcome).toBe("infra_error");
  });

  it("still says infra_error when an E2B outage surfaces AFTER the deadline", async () => {
    // The other direction: a spent clock must not turn an outage into the PR's
    // failure just because it arrived late. E2B's own description of the failure
    // closes the door the clock opened.
    const box = fakeSandbox({
      throwOn: (command) =>
        command.includes("npm run build")
          ? Object.assign(
              new Error(
                "connection error: This error is likely due to exceeding 'requestTimeoutMs'."
              ),
              { name: "TimeoutError" }
            )
          : undefined,
    });

    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
      buildTimeoutMs: 0,
    }).catch((e) => e as CheckStepError);

    expect((error as CheckStepError).outcome).toBe("infra_error");
  });

  it("gives the PR's server a timeout covering the sandbox lifetime", async () => {
    // E2B's `timeoutMs` defaults to 60 SECONDS and applies to background
    // commands too, so an unset value kills the server (and its stderr stream)
    // about a minute in — mid-suite, as a false failure.
    const box = fakeSandbox();
    await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    });

    const spawn = box.calls.find((call) => call.opts?.background === true);
    expect(spawn).toBeDefined();
    expect(spawn?.opts?.timeoutMs).toBe(CHECK_SANDBOX_TIMEOUT_MS);
    // Not 0: E2B forwards it to connect-rpc, which treats <= 0 as an expired
    // deadline and would abort the spawn instantly.
    expect(spawn?.opts?.timeoutMs).toBeGreaterThan(0);
  });

  it("treats a sandbox that cannot run commands at all as infra_error", async () => {
    const box = fakeSandbox({
      throwOn: (command) =>
        command.includes("npm") ? new Error("sandbox is gone") : undefined,
    });
    const error = await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => okInitialize()) as unknown as typeof fetch,
    }).catch((e) => e as CheckStepError);
    expect((error as CheckStepError).outcome).toBe("infra_error");
  });

  it("bounds a firehose of server output INSIDE the box, and clamps what arrives", async () => {
    // E2B's CommandHandle buffers every chunk it receives into an internal
    // string, from the moment the handle exists and regardless of callbacks. A PR
    // server that logs for twenty minutes would grow this process's heap without
    // limit, so nothing is streamed: output goes to a file and only a bounded
    // tail is ever fetched.
    const box = fakeSandbox({
      stdout: { "tail -c": `${"x".repeat(50_000)}THE-LAST-LINE` },
    });
    const error = (await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => {
        throw new Error("refused");
      }) as unknown as typeof fetch,
      healthTimeoutMs: 30,
      healthIntervalMs: 1,
    }).catch((e) => e)) as CheckStepError;

    // The spawn streams nothing back and appends to a file…
    const spawn = box.calls.find((call) => call.opts?.background === true);
    expect(spawn?.command).toContain(">> /tmp/mcp-server.log 2>&1");
    expect(spawn?.opts?.onStderr).toBeUndefined();
    expect(spawn?.opts?.onStdout).toBeUndefined();
    // …with a watchdog so the file cannot fill the sandbox's disk either, which
    // would take down the very server being evaluated.
    expect(spawn?.command).toContain("wc -c < /tmp/mcp-server.log");
    expect(spawn?.command).toContain("4194304");
    // …and the truncation is done by the sandbox, not after the fact.
    expect(
      box.calls.some((call) => call.command.includes("tail -c 8000"))
    ).toBe(true);
    // Whatever still comes back is clamped before it can reach a check body.
    expect(error.detailsMarkdown).toContain("THE-LAST-LINE");
    expect(error.detailsMarkdown!.length).toBeLessThan(
      OUTPUT_CLAMP_CHARS + 200
    );
  });
});

describe("cloneAndCheckout", () => {
  it("clones anonymously from the PR ref and asserts the resolved sha", async () => {
    const headSha = "a".repeat(40);
    const box = fakeSandbox({ stdout: { "rev-parse HEAD": `${headSha}\n` } });

    await cloneAndCheckout(box.sandbox, {
      repoFullName: "mcpjam/mcp-check-fixture",
      prNumber: 7,
      headSha,
    });

    const cloneCall = box.calls[0].command;
    expect(cloneCall).toContain(
      "https://github.com/mcpjam/mcp-check-fixture.git"
    );
    expect(cloneCall).toContain("pull/7/head");
    expect(cloneCall).toContain("git checkout --detach");
    expect(cloneCall).toContain(headSha);
    // No credential of any kind reaches the box.
    expect(cloneCall).not.toMatch(/x-access-token|ghs_|@github\.com/);
    expect(box.calls[0].opts?.envs).toBeUndefined();
  });

  it("fails loudly when the checked-out sha is not the one we were told about", async () => {
    // A force-push landed between the webhook and the clone: building the wrong
    // tree and reporting it against the old sha would be a silent lie.
    const box = fakeSandbox({
      stdout: { "rev-parse HEAD": `${"b".repeat(40)}\n` },
    });
    await expect(
      cloneAndCheckout(box.sandbox, {
        repoFullName: "mcpjam/mcp-check-fixture",
        prNumber: 7,
        headSha: "a".repeat(40),
      })
    ).rejects.toMatchObject({ outcome: "infra_error" });
  });

  it("treats a failed clone of a public repo as our problem, not the PR’s", async () => {
    const box = fakeSandbox({ exitCodes: { "git clone": 128 } });
    const error = await cloneAndCheckout(box.sandbox, {
      repoFullName: "mcpjam/mcp-check-fixture",
      prNumber: 7,
      headSha: "a".repeat(40),
    }).catch((e) => e as CheckStepError);
    expect((error as CheckStepError).outcome).toBe("infra_error");
  });

  it("quotes the sha and repo so neither can inject shell", async () => {
    const box = fakeSandbox({
      stdout: { "rev-parse HEAD": "deadbeef\n" },
    });
    await cloneAndCheckout(box.sandbox, {
      repoFullName: "owner/repo; rm -rf /",
      prNumber: 1,
      headSha: "deadbeef",
    }).catch(() => {});
    // The whole script is a single quoted argument to `bash -lc`, and the
    // injected text stays inside nested quotes.
    expect(box.calls[0].command.startsWith("bash -lc '")).toBe(true);
    expect(box.calls[0].command).not.toMatch(/;\s*rm -rf \/\s*'?\s*&&/);
  });
});

describe("lockDownEgress", () => {
  it("disables outbound while leaving the inbound host bridge alone", async () => {
    const box = fakeSandbox();
    await lockDownEgress(box.sandbox);
    expect(box.events).toEqual(['network:{"allowInternetAccess":false}']);
  });

  it("surfaces a failure as infra_error so the caller can abort", async () => {
    const box = fakeSandbox({ networkFails: true });
    await expect(lockDownEgress(box.sandbox)).rejects.toMatchObject({
      outcome: "infra_error",
    });
  });
});

describe("waitForMcpInitialize", () => {
  const seams = {
    intervalMs: 1,
    sleep: async () => {},
  };

  it("accepts a JSON initialize result", async () => {
    const fetchImpl = vi.fn(async () =>
      okInitialize()
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("accepts an SSE-framed initialize result (streamable HTTP servers send either)", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(SSE_INITIALIZE_FRAME, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("accepts an initialize result on a stream the server never closes", async () => {
    // THE realistic shape: a streamable-HTTP server answers `initialize` on an
    // SSE stream and then holds it open for server-initiated messages. Reading
    // the body with `response.text()` waits for the stream to END, so it never
    // resolves — every attempt aborts and a perfectly healthy server reads as
    // `server_unhealthy`.
    let cancelled = false;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(SSE_INITIALIZE_FRAME)
              );
              // …and then nothing. No close(): the stream stays open, exactly
              // like a real session.
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5_000,
      })
    ).toBe(true);
    // One attempt, and the socket is released rather than leaked.
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    ).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  it("decides from a frame that arrives split across chunks", async () => {
    const payload = SSE_INITIALIZE_FRAME.replace("event: message\n", "");
    const cut = 40;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              // A partial frame is not a verdict: it just fails to parse and the
              // read continues.
              controller.enqueue(encoder.encode(payload.slice(0, cut)));
              controller.enqueue(encoder.encode(payload.slice(cut)));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5_000,
      })
    ).toBe(true);
  });

  it("gives up on a stream that never carries an initialize result", async () => {
    // Untrusted code streaming its own logs at us. Bounded by the deadline, not
    // by how long it is willing to talk.
    const fetchImpl = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal }) =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (init?.signal?.aborted) {
                controller.close();
                return;
              }
              controller.enqueue(new TextEncoder().encode("noise\n"));
            },
          }),
          { status: 200 }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        fetchImpl,
        timeoutMs: 60,
        intervalMs: 10,
      })
    ).toBe(false);
  });

  it("keeps polling through connection refusals and succeeds once the server boots", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call < 3) throw new Error("ECONNREFUSED");
      return okInitialize();
    }) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 10_000,
      })
    ).toBe(true);
    expect(call).toBe(3);
  });

  it("sends a real JSON-RPC initialize, not a bare GET", async () => {
    const fetchImpl = vi.fn(async () =>
      okInitialize()
    ) as unknown as typeof fetch;
    await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ method: "initialize" });
    expect(init.headers.accept).toContain("text/event-stream");
  });

  it("does not accept an HTTP 200 that isn’t an initialize result", async () => {
    // A framework serving its own index page before the MCP route is mounted.
    const fetchImpl = vi.fn(
      async () => new Response("<html>ok</html>", { status: 200 })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an unsupported protocol version as healthy", async () => {
    // Present is not the same as usable: the real client rejects a version it
    // does not support, which would surface as `infra_error` (neutral) from the
    // eval run instead of the `server_unhealthy` the PR earned.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "bogus-9999" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a modern-only server through server/discover", async () => {
    // A 2026-07-28 endpoint (the official handler with `legacy: "reject"`) has no
    // `initialize` at all. The eval run negotiates eras automatically, so this is
    // a server it can drive — calling it `server_unhealthy` would put a red X on
    // a good PR. Probing alternates eras, so the discover attempt follows the
    // rejected legacy one.
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as { method: string };
      seen.push(parsed.method);
      if (parsed.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "legacy era rejected" },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
    expect(seen).toEqual(["initialize", "server/discover"]);
  });

  it("does not accept a discover result offering no version we speak", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as { method: string };
      if (parsed.method === "initialize") {
        return new Response("{}", {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: { supportedVersions: ["3099-01-01"], capabilities: {} },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a discover result whose nested capability flags are mistyped", async () => {
    // `ServerCapabilitiesSchema` types `tools.listChanged` as a boolean, and the
    // client runs that schema over the discover result. `{ listChanged: "yes" }` is
    // an object at the top level and a violation one level down, so the client
    // classifies this result `legacy` and declines the modern era — which is the
    // only thing this arm is asked about.
    const fetchImpl = discoverCapabilitiesFetch({
      tools: { listChanged: "yes" },
    });
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a discover result whose extensions are not a map of objects", async () => {
    // `extensions` is a record of name → object, so a bare `true` fails the schema,
    // as does a member that is not an object.
    for (const extensions of [true, { "com.example/thing": "on" }]) {
      expect(
        await waitForMcpInitialize("https://box/mcp", {
          ...seams,
          fetchImpl: discoverCapabilitiesFetch({ extensions }),
          timeoutMs: 5,
        })
      ).toBe(false);
    }
  });

  it("accepts a discover result whose nested capabilities are all well typed", async () => {
    // The other direction, and the one that would hurt: every typed member here is
    // the type the schema asks for, and the unknown extension member is an object,
    // so the client drives this server in the modern era. Rejecting it would be a
    // false `server_unhealthy` on a working PR.
    const fetchImpl = discoverCapabilitiesFetch(
      {
        tools: { listChanged: true },
        prompts: {},
        resources: { subscribe: true, listChanged: false },
        logging: {},
        experimental: { "com.example/lab": {} },
        extensions: { "com.example/thing": { enabled: true } },
        tasks: { list: {}, requests: { tools: { call: {} } } },
      },
      "how to drive me"
    );
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept a discover result whose instructions are not a string", async () => {
    const fetchImpl = discoverCapabilitiesFetch({ tools: {} }, 42);
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an answer whose event type carries trailing whitespace", async () => {
    // The parser strips ONE optional space after the colon and keeps the rest, so
    // this event's type is `"message "` — which is not `"message"`, so the transport
    // drops it. Trimming the value here would normalise it and accept an answer the
    // eval run never receives.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `event: message \ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a data field written with no space after the colon", async () => {
    // `data:{...}` is legal and the space is optional, so the single-space rule must
    // not eat the payload's first character.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `data:${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept a correct result served with the wrong content type", async () => {
    // The eval run's transport rejects anything that is not `application/json`
    // or `text/event-stream` before it parses the body at all. A server that
    // answers perfectly as `text/plain` therefore cannot be driven, and calling
    // it healthy here hands its failure to us as a neutral `infra_error` instead
    // of the `server_unhealthy` the PR earned.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT }),
          { status: 200, headers: { "content-type": "text/plain" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts an SSE frame separated by bare CRs, after a BOM", async () => {
    // LF, CRLF and bare CR are all legal separators and a leading BOM is stripped
    // — the transport's parser accepts all of it, so a server it can drive must
    // not read as unhealthy here.
    const frame = `﻿event: message\rdata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: INITIALIZE_RESULT,
    })}\r\r`;
    const fetchImpl = vi.fn(
      async () =>
        new Response(frame, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept a capability the client's schema types as an object", async () => {
    // `tools: true` fails the client's capabilities schema, so the eval run cannot
    // drive this server — that is the PR's fault, not ours.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { ...INITIALIZE_RESULT, capabilities: { tools: true } },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an SSE-framed result declared as application/json", async () => {
    // The transport switches on the declared type, and for `application/json` it
    // calls `response.json()` — which throws on `event: …\ndata: …` framing. So
    // this server cannot be driven, however well-formed the JSON inside the frame
    // is, and reading the frame anyway would call it healthy on the strength of
    // something the client never gets to see.
    const fetchImpl = vi.fn(
      async () =>
        new Response(SSE_INITIALIZE_FRAME, {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a bare JSON result declared as text/event-stream", async () => {
    // The mirror case: under `text/event-stream` the transport runs its
    // EventSource parser, and a body with no `data:` line carries no events — the
    // client's `initialize` would go unanswered until it timed out.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a JSON body that continues past its first document", async () => {
    // `response.json()` rejects trailing content, so a second document (or junk)
    // after the first makes the whole body unparseable for the client. Deciding as
    // soon as a valid prefix landed would pass a server the eval run cannot use.
    const answer = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: INITIALIZE_RESULT,
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(`${answer}\n${answer}\n`, {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a JSON body that arrives in several chunks", async () => {
    // The flip side of withholding a JSON decision until the body ends: a body
    // split across writes must still be accepted once the last one lands.
    const answer = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: INITIALIZE_RESULT,
    });
    const split = Math.floor(answer.length / 2);
    const fetchImpl = vi.fn(async () => {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(answer.slice(0, split)));
            controller.enqueue(encoder.encode(answer.slice(split)));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("accepts a media type that carries parameters", async () => {
    // `application/json; charset=utf-8` is the same essence, and the transport
    // compares essences — so this must not be turned away.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT }),
          {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("accepts an unknown capability of any shape", async () => {
    // The client's schema passes unknown keys through, so an extension advertised
    // as a bare string is still a server the eval run can drive. Rejecting it
    // would be stricter than the client — a false server_unhealthy.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              ...INITIALIZE_RESULT,
              capabilities: { tools: {}, "com.example/thing": "on" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept a discover result offering only legacy versions", async () => {
    // `server/discover` is the MODERN arm. A result naming only 2025-era
    // revisions says nothing about it: for such a server the client falls back to
    // `initialize`, and whether THAT works is what the legacy probe answers. So an
    // endpoint that answers discover with legacy-only versions while rejecting
    // `initialize` is not a server the eval run can drive, and must not read as
    // healthy off the arm that never proved it.
    let clock = 0;
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const parsed = JSON.parse(String(init.body)) as { method: string };
      seen.push(parsed.method);
      if (parsed.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "legacy era rejected" },
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          result: {
            supportedVersions: ["2025-06-18", "2025-11-25"],
            capabilities: {},
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        fetchImpl,
        timeoutMs: 100,
        intervalMs: 10,
        now: () => clock,
        sleep: async () => {
          clock += 10;
        },
      })
    ).toBe(false);
    // The modern arm really did run — this is a rejection, not a probe that never
    // got its turn.
    expect(seen).toContain("server/discover");
  });

  it("joins an event's data fields before parsing them", async () => {
    // SSE concatenates consecutive `data:` fields within one event. A server that
    // spreads one JSON-RPC message across several is legal; parsing each line
    // alone made every fragment fail and reported a false server_unhealthy.
    // Fields are joined with a newline, per spec — which is exactly what a
    // pretty-printed payload needs, since a newline is JSON whitespace between
    // tokens. (A server splitting mid-token would be sending malformed SSE.)
    const pretty = JSON.stringify(
      { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT },
      null,
      2
    );
    const frame = pretty
      .split("\n")
      .map((line) => `data: ${line}`)
      .join("\n");
    const fetchImpl = vi.fn(
      async () =>
        new Response(`event: message\n${frame}\n\n`, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not accept an answer carried by a named non-message event", async () => {
    // The transport dispatches an event's data only when the event is unnamed or
    // named `message` — `event: ping` is dropped before its data is ever parsed.
    // So the eval run's `initialize` would go unanswered here, and reading the
    // payload anyway would call this server healthy off bytes the client discards.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `event: ping\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("accepts a real answer that follows a named non-message event", async () => {
    // The name belongs to its own event and must not leak into the next one: a
    // server that emits `event: ping` before answering is perfectly usable, so the
    // filter must not turn the answer behind it into a false `server_unhealthy`.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          `event: ping\ndata: {"noise":true}\n\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: INITIALIZE_RESULT,
          })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("does not decide on a multi-field event before its terminator arrives", async () => {
    // The first `data:` field parses on its own, but the event is not over: the
    // second field makes the joined payload something else entirely. Deciding at
    // the chunk boundary would accept an answer the server never finished sending.
    // Held instead until the blank line, at which point the whole event is judged
    // — and this one is not valid JSON, so the verdict is "not healthy".
    const chunks = [
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: INITIALIZE_RESULT,
      })}\n`,
      `data: "and the rest of the message"\n\n`,
    ];
    let clock = 0;
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        fetchImpl,
        timeoutMs: 100,
        intervalMs: 10,
        now: () => clock,
        sleep: async () => {
          clock += 10;
        },
      })
    ).toBe(false);
  });

  it("does not accept a final event the server left unterminated", async () => {
    // Closing the body does NOT terminate the event. `EventSourceParserStream` is a
    // `TransformStream` with no `flush`, so a pending event with no blank line after
    // it is dropped on close rather than delivered — the client's `initialize` never
    // gets an answer. Parsing the tail here anyway would call such a server healthy
    // off a message the eval run never receives.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  SSE_INITIALIZE_FRAME.replace(/\n+$/, "\n")
                )
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a capped JSON body that parses as a prefix", async () => {
    // A body whose first `PROBE_MAX_RESPONSE_BYTES` happen to be a complete JSON
    // document, followed by more content. We stop reading at the cap; the client
    // does not — `response.json()` reads to EOF and rejects the trailing bytes. So
    // the cap must not stand in for the body ending, or the probe passes a server
    // the eval run cannot parse.
    const answer = {
      jsonrpc: "2.0",
      id: 1,
      result: INITIALIZE_RESULT,
      pad: "",
    };
    const padding = PROBE_MAX_RESPONSE_BYTES - JSON.stringify(answer).length;
    expect(padding).toBeGreaterThan(0);
    const document = JSON.stringify({ ...answer, pad: "a".repeat(padding) });
    expect(document.length).toBe(PROBE_MAX_RESPONSE_BYTES);

    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(`${document}{"trailing":"junk"}`)
              );
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;

    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a serverInfo without a name and version", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: {},
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an initialize result missing required fields", async () => {
    // `InitializeResultSchema` requires `capabilities` and `serverInfo`. A
    // result carrying only a good `protocolVersion` passes this probe but fails
    // the client's own validation moments later — the same false neutral.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-06-18" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept an answer to a different request as healthy", async () => {
    // Someone else's response, or a server echoing a wrong id, is not proof our
    // handshake completed — the client correlates by id and so does this.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            result: INITIALIZE_RESULT,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("does not accept a JSON-RPC error response as healthy", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32600, message: "nope" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", {
        ...seams,
        fetchImpl,
        timeoutMs: 5,
      })
    ).toBe(false);
  });

  it("bounds each attempt so a server that accepts and never answers cannot hang the check", async () => {
    // Untrusted PR code that takes the socket and goes silent. Without a
    // per-attempt bound this await never returns and the check occupies the
    // worker's only in-flight slot until the sandbox TTL.
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    ) as unknown as typeof fetch;

    const started = Date.now();
    const result = await waitForMcpInitialize("https://box/mcp", {
      fetchImpl,
      timeoutMs: 150,
      intervalMs: 10,
    });
    expect(result).toBe(false);
    // Bounded by the health deadline, not by the server's patience.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].signal
    ).toBeDefined();
  });

  it('does not misread a JSON body that merely contains "data:" as an SSE frame', async () => {
    // A serverInfo name, instructions blob, or tool description can contain
    // "data:" — classifying the whole body as SSE yielded zero payloads and a
    // false server_unhealthy.
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "reads data: urls", version: "1" },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
    ) as unknown as typeof fetch;
    expect(
      await waitForMcpInitialize("https://box/mcp", { ...seams, fetchImpl })
    ).toBe(true);
  });

  it("gives up at the deadline", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    let clock = 0;
    const result = await waitForMcpInitialize("https://box/mcp", {
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 25,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(result).toBe(false);
    // Bounded: it stops once another interval would overshoot the deadline.
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeLessThanOrEqual(5);
  });
});

describe("clampOutput", () => {
  it("fences with a longer run so a log containing a fence cannot break out", () => {
    const clamped = clampOutput("before\n```\n# heading\n```\nafter");
    expect(clamped.startsWith("````text\n")).toBe(true);
    expect(clamped.endsWith("\n````")).toBe(true);
  });

  it("strips ANSI escapes and NULs, keeps tabs and newlines", () => {
    const clamped = clampOutput("a\u001b[31mred\u001b[0m\u0000\tb\nc");
    expect(clamped).toContain("\tb");
    expect(clamped).not.toContain("\u001b");
    expect(clamped).not.toContain("\u0000");
  });

  it("keeps the tail and says so", () => {
    const clamped = clampOutput(`${"x".repeat(OUTPUT_CLAMP_CHARS + 100)}TAIL`);
    expect(clamped).toContain("TAIL");
    expect(clamped).toContain("Showing the last");
  });

  it("returns empty rather than an empty code block", () => {
    expect(clampOutput("")).toBe("");
    expect(clampOutput(undefined)).toBe("");
    expect(clampOutput("  \n ")).toBe("");
  });
});

describe("recipes", () => {
  it("resolves the fixture repo case-insensitively", () => {
    expect(resolveCheckRecipe("MCPJam/MCP-Check-Fixture")).toMatchObject({
      port: 3001,
      mcpPath: "/mcp",
    });
  });

  it("returns null for anything else — the worker maps that to recipe_unresolvable", () => {
    expect(resolveCheckRecipe("someone/unknown-server")).toBeNull();
    expect(resolveCheckRecipe("")).toBeNull();
  });

  it("only the fixture repo is wired up in the skeleton", () => {
    expect(listRecipeRepos()).toEqual(["mcpjam/mcp-check-fixture"]);
  });
});
