/**
 * A real, parseable plugin bundle for the materializer tests — including a
 * dependency-free stdio MCP server the desktop test actually spawns.
 *
 * The server is raw JSON-RPC over stdin/stdout on purpose: it must run from a
 * cache directory outside the repo, where `node_modules` resolution would not
 * find the MCP SDK. Its single tool reports the directory it was launched from
 * and the `PLUGIN_ROOT` it received, which is how the test proves substitution
 * happened at spawn rather than at parse time.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import {
  parsePluginBundle,
  type PluginFileSource,
} from "@mcpjam/sdk/plugin-bundle";
import { createZipPluginFileSource } from "../bundle-file-sources.js";

export const FIXTURE_SERVER_JS = `#!/usr/bin/env node
let buffer = "";

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffer += data;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    handle(request);
  }
});

function handle(request) {
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "plugin-fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "plugin_root",
            description: "Report the plugin root this process was launched with.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (request.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              pluginRoot: process.env.PLUGIN_ROOT ?? null,
              codexPluginRoot: process.env.CODEX_PLUGIN_ROOT ?? null,
              scriptPath: process.argv[1],
              dataFileArg: process.argv[2] ?? null,
            }),
          },
        ],
      },
    });
    return;
  }
  if (request.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: "Method not found: " + request.method },
    });
  }
}

process.stdin.resume();
`;

/** Bundle-relative path → content. Mirrors what a folder import would upload. */
export function fixtureBundleFiles(): Record<string, string> {
  return {
    ".codex-plugin/plugin.json": JSON.stringify({
      name: "fixture-plugin",
      version: "1.0.0",
      description: "Fixture plugin with one local stdio component.",
    }),
    ".mcp.json": JSON.stringify({
      mcp_servers: {
        "fixture-local": {
          command: "node",
          args: ["${PLUGIN_ROOT}/server/index.js", "${PLUGIN_ROOT}/data.txt"],
        },
      },
    }),
    "server/index.js": FIXTURE_SERVER_JS,
    "data.txt": "fixture payload\n",
  };
}

/** Zip the fixture files, as `folderSelectionToPluginZip` does client-side. */
export async function fixtureBundleZip(
  files: Record<string, string> = fixtureBundleFiles()
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: "uint8array" });
}

export async function fixtureBundleSource(
  files?: Record<string, string>
): Promise<PluginFileSource> {
  return createZipPluginFileSource(await fixtureBundleZip(files));
}

/** The `bundleHash` the backend would have pinned for these files. */
export async function fixtureBundleHash(
  files?: Record<string, string>
): Promise<string> {
  const parsed = await parsePluginBundle(await fixtureBundleSource(files));
  return parsed.bundleHash;
}

/** Disposable cache root so tests never touch the real `~/.mcpjam`. */
export async function makeCacheRoot(): Promise<{
  root: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "mcpjam-plugin-cache-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
