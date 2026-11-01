import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { build } from "esbuild";
import WebSocket from "ws";
import { withBridgeToken } from "@ai-sdk/harness/utils";
import { bridgeControlPlugin } from "../lib/bridge-control-plugin.mjs";

const require = createRequire(import.meta.url);

test(
  "compiled bridge refresh is acknowledged without starting a turn",
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "harn2-control-test-"));
    let child;
    let socket;
    try {
      await symlink(
        dirname(dirname(require.resolve("ws/package.json"))),
        join(dir, "node_modules"),
        "dir",
      );
      const result = await build({
        stdin: {
          contents: `import { runBridge } from '@ai-sdk/harness/bridge';
          await runBridge({ bridgeType: 'fixture', bridgeStateDir: ${JSON.stringify(dir)},
            token: 'fixture-token', port: 0,
            onStart: async () => { throw new Error('Refresh started a turn'); },
            onMcpRefresh: async value => { if (value?.accepted !== true) throw new Error('Refused'); }
          });`,
          resolveDir: process.cwd(),
        },
        bundle: true,
        platform: "node",
        format: "esm",
        write: false,
        external: ["ws"],
        plugins: [bridgeControlPlugin],
      });
      const entry = join(dir, "bridge.mjs");
      await writeFile(entry, result.outputFiles[0].text);
      child = spawn(process.execPath, [entry], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const ready = await new Promise((fulfill, reject) => {
        child.once("exit", (code) =>
          reject(new Error(`Bridge exited: ${code}`)),
        );
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          const value = JSON.parse(line);
          if (value.type === "bridge-ready") fulfill(value);
        });
      });
      const endpoint = withBridgeToken({
        endpoint: { url: `ws://127.0.0.1:${ready.port}` },
        token: "fixture-token",
      });
      socket = new WebSocket(endpoint.url);
      await new Promise((fulfill, reject) => {
        socket.once("open", fulfill);
        socket.once("error", reject);
      });
      async function request(id, servers) {
        const response = new Promise((fulfill) => {
          const listener = (bytes) => {
            const value = JSON.parse(bytes.toString());
            if (value.type === "mcpjam-mcp-refreshed" && value.id === id) {
              socket.off("message", listener);
              fulfill(value);
            }
          };
          socket.on("message", listener);
        });
        socket.send(
          JSON.stringify({ type: "mcpjam-refresh-mcp", id, servers }),
        );
        return response;
      }
      assert.deepEqual(await request("accepted", { accepted: true }), {
        type: "mcpjam-mcp-refreshed",
        id: "accepted",
        ok: true,
      });
      assert.deepEqual(await request("refused", { accepted: false }), {
        type: "mcpjam-mcp-refreshed",
        id: "refused",
        ok: false,
      });
    } finally {
      socket?.terminate();
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
