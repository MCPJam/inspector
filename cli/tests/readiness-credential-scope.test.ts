/**
 * `readiness check claude --access-token`, run as a user runs it.
 *
 * The token is for the MCP server. The built CLI must send it on the MCP dial
 * and nowhere else: not on the unauthenticated probe (or an OAuth server
 * grades as authless), not on Protected Resource Metadata, and not on the
 * authorization server's metadata, which lives on an origin the server under
 * test chose. Two loopback ports are two origins, so the authorization server
 * here is a genuinely cross-origin party.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const TOKEN = "good-token";

interface Hit {
  origin: string;
  method: string;
  path: string;
  rpc?: string;
  client?: string;
  authorization?: string;
}

async function start(
  hits: Hit[],
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, any> | undefined,
    origin: string,
  ) => void,
): Promise<{ origin: string; server: http.Server }> {
  let origin = "";
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: Record<string, any> | undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      hits.push({
        origin,
        method: req.method ?? "",
        path: req.url ?? "",
        rpc: body?.method,
        client: body?.params?.clientInfo?.name,
        authorization: req.headers.authorization,
      });
      handler(req, res, body, origin);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
  return { origin, server };
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function runCli(
  args: string[],
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { encoding: "utf8", timeout: 60_000 },
      (error, stdout) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          stdout,
          exitCode: error ? (typeof code === "number" ? code : null) : 0,
        });
      },
    );
  });
}

test("readiness check claude sends --access-token only on the MCP dial", async (t) => {
  if (!existsSync(CLI_ENTRY)) {
    t.skip(
      "cli/dist is not built; run through `npm run test:fast`, which builds it first",
    );
    return;
  }

  const hits: Hit[] = [];
  const auth = await start(hits, (req, res, _body, origin) => {
    if (req.url?.startsWith("/.well-known/")) {
      json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const mcp = await start(hits, (req, res, body, origin) => {
    if (req.url === "/.well-known/oauth-protected-resource/mcp") {
      json(res, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [auth.origin],
      });
      return;
    }
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(req.url === "/mcp" ? 405 : 404);
      res.end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end();
      return;
    }
    if (body?.method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return;
    }
    const result =
      body?.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "orders", version: "1" },
          }
        : body?.method === "tools/list"
          ? { tools: [{ name: "get_my_orders", inputSchema: { type: "object" } }] }
          : body?.method === "resources/list"
            ? { resources: [] }
            : undefined;
    json(
      res,
      200,
      result
        ? { jsonrpc: "2.0", id: body?.id, result }
        : {
            jsonrpc: "2.0",
            id: body?.id,
            error: { code: -32601, message: "Method not found" },
          },
    );
  });
  t.after(() => {
    auth.server.closeAllConnections?.();
    mcp.server.closeAllConnections?.();
    auth.server.close();
    mcp.server.close();
  });

  const { stdout } = await runCli([
    "readiness",
    "check",
    "claude",
    `${mcp.origin}/mcp`,
    "--access-token",
    TOKEN,
    "--format",
    "json",
  ]);

  const isProbe = (hit: Hit) =>
    hit.rpc === "initialize" && hit.client !== "mcpjam-directory-readiness";
  const isEndpoint = (hit: Hit) =>
    hit.origin === mcp.origin && hit.path === "/mcp";

  // The run reached the authorization server, PRM, and the probe.
  assert.ok(hits.some((hit) => hit.origin === auth.origin));
  assert.ok(
    hits.some(
      (hit) => hit.path === "/.well-known/oauth-protected-resource/mcp",
    ),
  );
  assert.ok(hits.some(isProbe));

  const leaked = hits.filter(
    (hit) =>
      (!isEndpoint(hit) || isProbe(hit)) && hit.authorization !== undefined,
  );
  assert.deepEqual(leaked, []);

  const dial = hits.filter(
    (hit) => isEndpoint(hit) && hit.method === "POST" && !isProbe(hit),
  );
  assert.ok(dial.some((hit) => hit.rpc === "tools/list"));
  assert.ok(dial.every((hit) => hit.authorization === `Bearer ${TOKEN}`));

  // The probe saw the 401, so the challenge is graded rather than skipped.
  const report = JSON.parse(stdout) as {
    findings: { id: string; status: string }[];
  };
  const challenge = report.findings.find(
    (finding) => finding.id === "claude.auth.unauthenticated-challenge",
  );
  assert.equal(challenge?.status, "satisfied");
});
