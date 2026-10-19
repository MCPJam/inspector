import { createServer } from "node:http";

/** Local authenticated platform boundary; inference and MCP still run normally. */
export async function evalIdentityFixture() {
  const starts = [];
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer sk_fixture") {
      res.writeHead(401).end(JSON.stringify({ code: "UNAUTHORIZED", message: "Invalid test credential" }));
      return;
    }
    if (req.url === "/api/v1/projects") {
      res.end(JSON.stringify({ items: [{ id: "project_fixture", name: "Default", organizationId: "org_fixture", updatedAt: 1 }], nextCursor: null }));
      return;
    }
    if (req.url === "/api/v1/projects/project_fixture/eval-ingest/pay-iteration") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      res.end(JSON.stringify({ ok: true, ...parsed, paymentId: parsed.iterationKey }));
      return;
    }
    if (req.url === "/api/v1/projects/project_fixture/eval-ingest/start-run") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      starts.push(parsed);
      res.end(JSON.stringify({ ok: true, runStartId: parsed.runStartId, organizationId: "org_fixture", projectId: "project_fixture" }));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ code: "NOT_FOUND" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    starts,
    env: { MCPJAM_API_KEY: "sk_fixture", MCPJAM_API_URL: `http://127.0.0.1:${address.port}/api/v1` },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
