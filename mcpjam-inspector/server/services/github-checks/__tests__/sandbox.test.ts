import { describe, expect, it, vi } from "vitest";
import {
  buildAndStart,
  CHECK_SANDBOX_TIMEOUT_MS,
  CheckStepError,
  clampOutput,
  cloneAndCheckout,
  lockDownEgress,
  OUTPUT_CLAMP_CHARS,
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

function okInitialize(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: {} },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
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

  it("reports server_unhealthy with the server’s stderr tail when initialize never lands", async () => {
    // The started process complains on stderr while the probe keeps failing.
    const box = fakeSandbox({
      stderrOnSpawn: ["Error: listen EADDRINUSE 127.0.0.1:3001"],
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

  it("keeps only the tail of a firehose stderr", async () => {
    const box = fakeSandbox({
      stderrOnSpawn: ["x".repeat(50_000), "THE-LAST-LINE"],
    });
    const error = (await buildAndStart(box.sandbox, RECIPE, {
      fetchImpl: vi.fn(async () => {
        throw new Error("refused");
      }) as unknown as typeof fetch,
      healthTimeoutMs: 30,
      healthIntervalMs: 1,
    }).catch((e) => e)) as CheckStepError;
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
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } }
        )
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
                new TextEncoder().encode(
                  'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n'
                )
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
    const payload =
      'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}\n\n';
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
