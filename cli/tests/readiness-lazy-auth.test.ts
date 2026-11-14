/**
 * `readiness check --lazy-auth-tool` and `--claim`, run in-process.
 *
 * The probe calls tools on the server under test, so the properties worth
 * proving are the ones a user cannot see from the report:
 *
 *   - the probe's calls carry NO credential, even with `--access-token`;
 *   - only the named read-only tools are called;
 *   - a bad flag is a usage error before anything dials.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Command } from "commander";
import {
  lazyAuthProbeFromOptions,
  parseFeatureClaims,
  registerReadinessCommands,
} from "../src/commands/readiness.js";

const TOKEN = "good-token";

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerReadinessCommands(program);
  return program;
}

async function runExpectingError(argv: string[]): Promise<Error | null> {
  try {
    await buildProgram().parseAsync(["node", "mcpjam", ...argv]);
    return null;
  } catch (error) {
    return error as Error;
  }
}

test("--claim accepts the known claims and refuses a typo", () => {
  assert.deepEqual(parseFeatureClaims(["lazy-authentication"]), [
    "lazy-authentication",
  ]);
  assert.equal(parseFeatureClaims(undefined), undefined);
  assert.throws(() => parseFeatureClaims(["lazy-auth"]), /Unknown --claim/);
  assert.throws(
    () => parseFeatureClaims(Array(11).fill("lazy-authentication")),
    /At most 10/,
  );
});

test("the lazy-auth flags arm the probe only when given", () => {
  assert.equal(lazyAuthProbeFromOptions({}), undefined);
  assert.deepEqual(lazyAuthProbeFromOptions({ lazyAuthProbe: true }), {
    enabled: true,
  });
  assert.deepEqual(lazyAuthProbeFromOptions({ lazyAuthTool: " get_orders " }), {
    enabled: true,
    toolName: "get_orders",
  });
  assert.throws(
    () =>
      lazyAuthProbeFromOptions({
        lazyAuthTool: "same",
        lazyAuthPublicTool: "same",
      }),
    /same tool/,
  );
  assert.throws(
    () => lazyAuthProbeFromOptions({ lazyAuthTool: "x".repeat(129) }),
    /longer than 128/,
  );
});

test("an unknown --claim is a usage error before anything dials", async () => {
  const error = await runExpectingError([
    "readiness",
    "check",
    "claude",
    "http://127.0.0.1:1/mcp",
    "--claim",
    "lazy-auth",
  ]);
  assert.ok(error);
  assert.match(String(error), /Unknown --claim/);
});

test("a package-only mode refuses the lazy-auth probe", async () => {
  const error = await runExpectingError([
    "readiness",
    "check",
    "openai",
    "--submission-mode",
    "skills-only",
    "--package",
    "/tmp/does-not-exist-for-this-test",
    "--lazy-auth-probe",
  ]);
  assert.ok(error);
  // Either refusal is correct; neither may dial.
  assert.match(String(error), /lazy-auth probe|does not exist/);
});

test("readiness check claude --lazy-auth-tool calls tools without the access token", async (t) => {
  const calls: Array<{ tool?: string; authorization?: string }> = [];
  let origin = "";
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status: number, payload: unknown, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      if (req.url !== "/mcp" || req.method !== "POST") {
        return send(404, {});
      }
      if (body.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (body.method === "initialize") {
        return send(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "shop", version: "1" },
          },
        });
      }
      if (body.method === "tools/list") {
        return send(200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "get_weather", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
              { name: "get_my_orders", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
              { name: "cancel_order", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
            ],
          },
        });
      }
      if (body.method === "tools/call") {
        calls.push({ tool: body.params?.name, authorization: req.headers.authorization });
        if (body.params?.name === "get_my_orders" && req.headers.authorization !== `Bearer ${TOKEN}`) {
          res.writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          });
          res.end();
          return;
        }
        return send(200, { jsonrpc: "2.0", id: body.id, result: { content: [] } });
      }
      return send(200, { jsonrpc: "2.0", id: body.id, result: { resources: [] } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  const previousExitCode = process.exitCode;
  let stdout = "";
  // Only the COMMAND's text is captured. The test runner streams its own
  // binary report frames over the same stdout, and swallowing those would
  // silently drop other tests' results.
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk !== "string") {
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  // The verdict and gap lines go to stderr; they belong to a real invocation.
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) =>
    typeof chunk === "string"
      ? true
      : (writeErr as (...args: unknown[]) => boolean)(
          chunk,
          ...rest,
        )) as typeof process.stderr.write;
  try {
    await buildProgram().parseAsync([
      "node",
      "mcpjam",
      "readiness",
      "check",
      "claude",
      `${origin}/mcp`,
      "--access-token",
      TOKEN,
      "--lazy-auth-tool",
      "get_my_orders",
      "--lazy-auth-public-tool",
      "get_weather",
      "--claim",
      "lazy-authentication",
      "--reporter",
      "json-summary",
    ]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
    // The verdict's exit code belongs to a real invocation, not to this
    // test process.
    process.exitCode = previousExitCode;
  }

  assert.deepEqual(
    calls.map((call) => call.tool),
    ["get_weather", "get_my_orders"],
  );
  assert.ok(
    calls.every((call) => call.authorization === undefined),
    "the lazy-auth probe must not send --access-token",
  );
  assert.ok(stdout.length > 0);
});

test("the hosted start commands offer the same lazy-auth and claim flags", () => {
  const program = buildProgram();
  const readiness = program.commands.find((c) => c.name() === "readiness")!;
  const start = readiness.commands.find((c) => c.name() === "start")!;
  for (const publisher of ["claude", "openai"]) {
    const command = start.commands.find((c) => c.name() === publisher)!;
    const flags = command.options.map((option) => option.long);
    for (const flag of [
      "--claim",
      "--lazy-auth-probe",
      "--lazy-auth-tool",
      "--lazy-auth-public-tool",
    ]) {
      assert.ok(flags.includes(flag), `${publisher} start lacks ${flag}`);
    }
  }
});
