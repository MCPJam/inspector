/**
 * Hermetic Ask MCPJam smoke test.
 *
 * Runs ONE signed-in Ask MCPJam turn through a built Inspector started the way
 * `npx @mcpjam/inspector` starts on a laptop: non-hosted, production mode, and
 * with NO `INSPECTOR_SERVICE_TOKEN`. It asserts the turn streams text and
 * finishes, and that the request the Inspector sent upstream carried the
 * MCPJam-paid claim on the user's own bearer with no service token.
 *
 * Why this exists: since v3.12.2 every self-hosted install refused every Ask
 * MCPJam turn ("INSPECTOR_SERVICE_TOKEN is not set, so this server cannot
 * attest an MCPJam-paid agent turn") for a week (PLB-189). CI and the hosted
 * app both HAVE the token, so nothing we ran looked like what our users run.
 *
 * Nothing here needs an account, a secret or a network:
 *   - sign-in is a real RS256 AuthKit session from `@workos/emulate`, verified
 *     by the Inspector's own AuthKit verifier through `WORKOS_API_BASE_URL`
 *     (loopback-only by design);
 *   - "Convex" is a loopback server that answers `/stream/platform` the way
 *     the backend does for an honoured claim, including the
 *     `x-mcpjam-platform-paid` confirmation the Inspector refuses to stream
 *     without, and records what it was sent;
 *   - the docs and spec MCP servers point at the same loopback server, which
 *     does not serve them, so the turn takes the path it takes when they are
 *     down instead of calling a third party.
 *
 * What it cannot see is the real backend refusing a client it does not accept
 * yet. Production's Ask MCPJam alerts cover that after a release ships.
 *
 * Used two ways:
 *   - `node .github/scripts/ask-mcpjam-smoke.mjs [bin/start.js]` against a
 *     built checkout (Build and Test, on every PR and merge-queue run);
 *   - `runAskMcpjamSmoke()` from smoke-packed-npm-packages.mjs, against the
 *     packed tarball a release is about to publish.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const STARTUP_TIMEOUT_MS = 120_000;
const TURN_TIMEOUT_MS = 60_000;
const CLIENT_ID = "client_01ASKMCPJAMSMOKE0000000000";
const USER = {
  id: "user_01ASKMCPJAMSMOKE00000000000",
  email: "smoke@ask-mcpjam.test",
  password: "ask-mcpjam-smoke",
};
const REPLY = "Ask MCPJam smoke reply.";
const BILLING_FEATURE = "mcpjam_agent";

/**
 * Removed from the Inspector's environment even when the runner never set
 * them. The service token is the point of the test; the WorkOS admin key is
 * the other credential only the hosted app holds, and with it the server takes
 * paths no self-hosted install can.
 */
const HOSTED_ONLY_ENV = ["INSPECTOR_SERVICE_TOKEN", "WORKOS_API_KEY"];

/**
 * The backend reads a turn needs answered besides the stream itself. Anything
 * else 404s, which the Inspector treats as that feature being unavailable.
 */
const JSON_ROUTES = {
  // An organization with no model providers and no key policy: the default
  // for a signed-in account, which is what puts the turn on MCPJam's rail.
  "POST /v1/org-model-config/resolve": { ok: true, providers: [] },
};

export async function runAskMcpjamSmoke({ inspectorBin, cwd }) {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "ask-mcpjam-smoke-"));
  const cleanup = [];
  let inspector;
  let backend;
  try {
    const workos = await startWorkosEmulator();
    cleanup.push(() => workos.close());
    backend = await startFakeBackend();
    cleanup.push(() => backend.close());

    inspector = startInspector({
      inspectorBin,
      cwd: cwd ?? tmpRoot,
      env: inspectorEnv({ backendUrl: backend.url, workosUrl: workos.url }),
    });
    cleanup.push(() => terminate(inspector.child));
    const baseUrl = await inspector.ready;
    console.log(`Inspector is up at ${baseUrl} with no service token.`);

    const accessToken = await signIn(workos);
    const text = await runTurn({ baseUrl, accessToken });
    assertUpstreamRequest(backend.requests, accessToken);
    console.log(
      `Ask MCPJam smoke passed: the turn streamed ${text.length} characters and finished, ` +
        "and the claim went upstream on the user's bearer with no service token."
    );
  } catch (error) {
    if (backend) {
      console.error("---- Requests the fake backend received ----");
      console.error(describeRequests(backend.requests));
    }
    if (inspector?.output()) {
      console.error("---- Inspector output (tail) ----");
      console.error(stripVTControlCharacters(inspector.output()).slice(-6000));
    }
    throw error;
  } finally {
    for (const step of cleanup.reverse()) await step();
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function startWorkosEmulator() {
  const { createEmulator } = await import("@workos/emulate");
  const emulator = await createEmulator({
    port: 0,
    hostname: "127.0.0.1",
    // Tokens then carry `iss = https://api.workos.com/user_management/<id>`,
    // an issuer the Inspector already trusts. Only the JWKS URL follows
    // `WORKOS_API_BASE_URL`, so the real issuer allow-list is exercised.
    issuer: "https://api.workos.com",
    seed: {
      users: [
        {
          id: USER.id,
          email: USER.email,
          first_name: "Smoke",
          password: USER.password,
          email_verified: true,
        },
      ],
    },
  });
  return {
    url: emulator.url,
    apiKey: emulator.apiKey,
    close: () => emulator.close(),
  };
}

/** A first-party AuthKit session for the seeded user, as the browser holds. */
async function signIn(workos) {
  const res = await fetch(`${workos.url}/user_management/authenticate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${workos.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: workos.apiKey,
      grant_type: "password",
      email: USER.email,
      password: USER.password,
    }),
  });
  const session = await res.json();
  if (!res.ok || typeof session.access_token !== "string") {
    throw new Error(`the WorkOS emulator issued no session (${res.status}).`);
  }
  return session.access_token;
}

/**
 * Answers the Inspector's platform stream the way Convex does for an honoured
 * claim, and 404s everything else. Every request is recorded so the run can
 * assert what went upstream and print it when something else broke.
 */
async function startFakeBackend() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://backend.invalid");
    requests.push({
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body: parseJson(raw),
    });

    if (req.method === "POST" && url.pathname === "/stream/platform") {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "x-mcpjam-platform-paid": BILLING_FEATURE,
      });
      const events = [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: REPLY },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ];
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    const answer = JSON_ROUTES[`${req.method} ${url.pathname}`];
    res.writeHead(answer ? 200 : 404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(answer ?? { error: "not served by the Ask MCPJam smoke" })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function inspectorEnv({ backendUrl, workosUrl }) {
  const env = { ...process.env };
  for (const name of HOSTED_ONLY_ENV) delete env[name];
  return Object.assign(env, {
    NODE_ENV: "production",
    VITE_MCPJAM_HOSTED_MODE: "false",
    // Set, so the packaged `.env.production` (which dotenv never lets
    // override a set variable) cannot point the turn at production.
    CONVEX_URL: backendUrl,
    VITE_CONVEX_URL: backendUrl,
    CONVEX_HTTP_URL: backendUrl,
    WORKOS_API_BASE_URL: workosUrl,
    WORKOS_CLIENT_ID: CLIENT_ID,
    VITE_WORKOS_CLIENT_ID: CLIENT_ID,
    MCPJAM_DOCS_MCP_URL: `${backendUrl}/mcp/docs`,
    MCPJAM_SPEC_MCP_URL: `${backendUrl}/mcp/spec`,
    MCPJAM_PLATFORM_MCP_URL: `${backendUrl}/mcp/platform`,
    // NOT `MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN`: it also suppresses printing
    // the access link, which is the readiness signal waited for below.
    // `--no-open` already keeps a browser from opening.
    MCPJAM_INSPECTOR_DISABLE_ORPHAN_CHECK: "1",
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  });
}

/**
 * Start the Inspector the way a user does and wait for the local access link
 * it prints once it is serving. `/api/web/*` authenticates on the bearer, not
 * on the link's token, so only the link's origin is used.
 */
function startInspector({ inspectorBin, cwd, env }) {
  const port = String(41000 + Math.floor(Math.random() * 2000));
  const child = spawn(
    process.execPath,
    [inspectorBin, "--port", port, "--no-open"],
    {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let output = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the Inspector printed no access link in time.")),
      STARTUP_TIMEOUT_MS
    );
    const onData = (chunk) => {
      output += chunk.toString();
      const match = /(https?:\/\/[^\s#]+)\/?#token=[A-Za-z0-9._~-]+/.exec(
        stripVTControlCharacters(output)
      );
      if (match) {
        clearTimeout(timer);
        resolve(new URL(match[1]).origin);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(`the Inspector exited before it was ready (${code ?? signal}).`)
      );
    });
  });
  return { child, ready, output: () => output };
}

/** One Ask MCPJam turn, read to the end of its stream. Returns its text. */
async function runTurn({ baseUrl, accessToken }) {
  const res = await fetch(`${baseUrl}/api/web/mcpjam-agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          id: "smoke-user-1",
          role: "user",
          parts: [{ type: "text", text: "Reply with one short sentence." }],
        },
      ],
      // Ignored by the route, which pins the agent model; its schema needs it.
      model: { id: "anthropic/claude-haiku-5.5" },
      chatSessionId: `ask-mcpjam-smoke-${Date.now()}`,
      projectId: "ask-mcpjam-smoke-project",
    }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) {
    // Error bodies carry the turn's RPC log ahead of the reason.
    const parsed = parseJson(body);
    const reason =
      parsed && typeof parsed === "object"
        ? JSON.stringify({
            code: parsed.code,
            message: parsed.message ?? parsed.error,
          })
        : body.slice(0, 600);
    throw new Error(`/api/web/mcpjam-agent answered ${res.status}: ${reason}`);
  }

  const chunks = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => {
      const chunk = parseJson(data);
      if (chunk === undefined) {
        throw new Error(`malformed stream chunk: ${data.slice(0, 200)}`);
      }
      return chunk;
    });
  const types = chunks.map((chunk) => chunk?.type);
  const failure = chunks.find((chunk) => chunk?.type === "error");
  if (failure) {
    throw new Error(
      `the turn streamed an error: ${String(
        failure.errorText ?? JSON.stringify(failure)
      ).slice(0, 600)}`
    );
  }
  const text = chunks
    .filter((chunk) => chunk?.type === "text-delta")
    .map((chunk) => chunk.delta ?? "")
    .join("");
  if (!text.includes(REPLY)) {
    throw new Error(
      `the turn did not stream the backend's reply (chunk types: ${summarize(types)}).`
    );
  }
  if (!types.includes("finish")) {
    throw new Error(`the turn never finished (chunk types: ${summarize(types)}).`);
  }
  return text;
}

/**
 * The PLB-189 contract: the turn goes to the MCPJam-paid route with the claim
 * and the user's own bearer, and no service token, because a self-hosted
 * install has none to send.
 */
function assertUpstreamRequest(requests, accessToken) {
  const streams = requests.filter((r) => r.path === "/stream/platform");
  if (streams.length === 0) {
    throw new Error("the Inspector never called /stream/platform.");
  }
  for (const request of streams) {
    if (request.headers.authorization !== `Bearer ${accessToken}`) {
      throw new Error("/stream/platform did not carry the user's bearer.");
    }
    if ("x-inspector-service-token" in request.headers) {
      throw new Error("/stream/platform carried a service token the install does not have.");
    }
    if (request.body?.billingFeature !== BILLING_FEATURE) {
      throw new Error(
        `/stream/platform claimed ${JSON.stringify(request.body?.billingFeature)}, not ${BILLING_FEATURE}.`
      );
    }
  }
}

function describeRequests(requests) {
  return requests.map((r) => `${r.method} ${r.path}`).join("\n") || "none";
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function summarize(types) {
  const counts = new Map();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts].map(([type, n]) => `${type}×${n}`).join(", ") || "none";
}

async function terminate(child) {
  const signal = (sig) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
  });
  signal("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  signal("SIGKILL");
  child.stdout?.destroy();
  child.stderr?.destroy();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const inspectorBin = path.resolve(
    process.argv[2] ?? path.join(rootDir, "mcpjam-inspector", "bin", "start.js")
  );
  try {
    await runAskMcpjamSmoke({ inspectorBin });
  } catch (error) {
    console.error(`::error::Ask MCPJam smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}
