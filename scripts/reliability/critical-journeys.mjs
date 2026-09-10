import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Shared by pre-publish artifact verification and the production canary.
// Fixtures are OWNED synthetic project rows, provisioned through the product.
// Only the MCPJam API credential enters requests: never supply a target token
// here, or the probe bypasses the saved-credential path it exists to test.
export function parseFixtures(value) {
  let fixtures;
  try {
    fixtures = JSON.parse(value);
  } catch {
    throw new Error("CANARY_FIXTURES_JSON must be valid JSON");
  }
  if (!Array.isArray(fixtures) || fixtures.length !== 2)
    throw new Error("Exactly one bearer and one OAuth fixture are required");
  for (const kind of ["bearer", "oauth"]) {
    const fixture = fixtures.find((f) => f.kind === kind);
    if (!fixture) throw new Error(`Missing ${kind} fixture`);
    const allowed = new Set([
      "kind",
      "projectId",
      "serverId",
      "toolName",
      "expectedText",
    ]);
    if (Object.keys(fixture).some((k) => !allowed.has(k)))
      throw new Error(
        "Unexpected fixture field; target credentials and arbitrary requests are not accepted"
      );
    for (const key of allowed) {
      if (typeof fixture[key] !== "string" || !fixture[key].trim())
        throw new Error(`Invalid ${kind} fixture ${key}`);
    }
    for (const key of ["projectId", "serverId"]) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(fixture[key]))
        throw new Error(`Invalid fixture ${key}`);
    }
  }
  return fixtures;
}

export function safeBaseUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Probe base must be an origin without credentials");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("Probe requires HTTPS or loopback HTTP");
  return url.origin;
}

export async function runJourneys({
  baseUrl,
  apiKey,
  localBearer,
  fixtures,
  mode = "hosted",
  accessHeaders = {},
  fetchImpl = fetch,
}) {
  const base = safeBaseUrl(baseUrl);
  const credential = mode === "local" ? localBearer : apiKey;
  if (!credential?.trim())
    throw new Error(
      "The mode-specific canary credential is required; authenticated coverage cannot be skipped"
    );
  if (mode === "local" && credential.startsWith("sk_"))
    throw new Error(
      "Local saved connections require a user session JWT, not a WorkOS API key"
    );
  if (!["hosted", "local"].includes(mode))
    throw new Error("Probe mode must be hosted or local");
  fixtures = parseFixtures(JSON.stringify(fixtures));
  let sessionToken;
  if (mode === "local") {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname))
      throw new Error("Local probe must target loopback");
    const response = await fetchImpl(`${base}/api/session-token`, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json();
    if (!response.ok || typeof data?.token !== "string" || !data.token)
      throw new Error("Local session bootstrap failed");
    sessionToken = data.token;
  }
  const results = [];
  const request = async (name, path, body, check) => {
    const started = Date.now();
    let status = 0;
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...accessHeaders,
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
          ...(sessionToken
            ? { "X-MCP-Session-Auth": `Bearer ${sessionToken}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      status = response.status;
      const data = await response.json();
      if (!response.ok || !check(data))
        throw new Error("Unexpected operation result");
      results.push({
        name,
        outcome: "passed",
        status,
        durationMs: Date.now() - started,
      });
      return true;
    } catch {
      // No response bodies, request URLs, user ids, tool output, or fetch error
      // messages in artifacts/Slack. Even a proxy error can echo credentials.
      results.push({
        name,
        outcome: "failed",
        status,
        durationMs: Date.now() - started,
      });
      return false;
    }
  };
  await request(
    "identity",
    "/api/v1/me",
    undefined,
    (d) => typeof d?.id === "string" && !!d.id
  );
  for (const fixture of fixtures) {
    const { kind, projectId, serverId, toolName, expectedText } = fixture;
    const body = { projectId, serverId };
    const prefix = `/api/v1/projects/${projectId}/servers/${serverId}`;
    if (mode === "local") {
      const connected = await request(
        `${kind}.connect`,
        "/api/mcp/connect",
        { ...body, serverName: `reliability-${kind}` },
        (d) => d?.success === true
      );
      if (!connected) continue;
      await request(
        `${kind}.reconnect`,
        "/api/mcp/servers/reconnect",
        { ...body, serverName: `reliability-${kind}` },
        (d) => d?.success === true
      );
      await request(
        `${kind}.local-tools`,
        "/api/mcp/tools/list",
        { serverId: `reliability-${kind}` },
        (d) =>
          Array.isArray(d?.tools) && d.tools.some((t) => t.name === toolName)
      );
      await request(
        `${kind}.local-call`,
        "/api/mcp/tools/execute",
        { serverId: `reliability-${kind}`, toolName, parameters: {} },
        (d) =>
          d?.status === "completed" &&
          d.result?.isError !== true &&
          Array.isArray(d.result?.content) &&
          d.result.content.some(
            (c) => c.type === "text" && c.text === expectedText
          )
      );
    }
    // The public operations use the same authorize/reveal/connect cores as
    // the UI. Each call establishes a fresh connection from the persisted row.
    await request(
      `${kind}.tools`,
      `${prefix}/tools`,
      {},
      (d) => Array.isArray(d?.items) && d.items.some((t) => t.name === toolName)
    );
    await request(
      `${kind}.call`,
      `${prefix}/tools/call`,
      { toolName, parameters: {} },
      (d) =>
        d?.isError !== true &&
        Array.isArray(d?.content) &&
        d.content.some((c) => c.type === "text" && c.text === expectedText)
    );
    await request(
      `${kind}.reopen`,
      `${prefix}/tools`,
      {},
      (d) => Array.isArray(d?.items) && d.items.some((t) => t.name === toolName)
    );
  }
  return {
    schemaVersion: 1,
    mode,
    checkedAt: new Date().toISOString(),
    passed: results.every((r) => r.outcome === "passed"),
    results,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const reportPath =
    process.env.RELIABILITY_REPORT_PATH || "reliability-report.json";
  try {
    const fixtures = parseFixtures(process.env.CANARY_FIXTURES_JSON);
    const accessHeaders =
      process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET
        ? {
            "CF-Access-Client-Id": process.env.CF_ACCESS_CLIENT_ID,
            "CF-Access-Client-Secret": process.env.CF_ACCESS_CLIENT_SECRET,
          }
        : {};
    const report = await runJourneys({
      baseUrl: process.env.CANARY_BASE_URL || "https://app.mcpjam.com",
      apiKey: process.env.CANARY_API_KEY,
      localBearer: process.env.CANARY_LOCAL_BEARER,
      fixtures,
      mode: process.env.CANARY_MODE || "hosted",
      accessHeaders,
    });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    process.stdout.write(
      `${report.passed ? "PASS" : "FAIL"}: ${report.results
        .map((r) => `${r.name}=${r.outcome}`)
        .join(", ")}\n`
    );
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    await writeFile(
      reportPath,
      JSON.stringify({
        schemaVersion: 1,
        passed: false,
        coverageFailure: true,
        results: [],
      })
    );
    process.stderr.write(
      "Required reliability configuration is unavailable or invalid; coverage is FAILED.\n"
    );
    process.exitCode = 1;
  }
}
