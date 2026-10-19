import { createServer } from "node:http";
import { beforeAll, afterAll } from "vitest";

const previous = { key: process.env.MCPJAM_API_KEY, base: process.env.MCPJAM_BASE_URL };
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  res.setHeader("content-type", "application/json");
  if (req.headers.authorization !== "Bearer sk_vitest_fixture") {
    res.writeHead(401).end(JSON.stringify({ code: "UNAUTHORIZED" }));
    return;
  }
  if (req.url?.endsWith("/eval-ingest/pay-iteration")) {
    res.end(JSON.stringify({ ok: true, ...request, paymentId: request.iterationKey }));
    return;
  }
  res.end(JSON.stringify({ ok: true, runStartId: request.runStartId, organizationId: "org", projectId: "project" }));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  process.env.MCPJAM_API_KEY = "sk_vitest_fixture";
  process.env.MCPJAM_BASE_URL = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (previous.key === undefined) delete process.env.MCPJAM_API_KEY;
  else process.env.MCPJAM_API_KEY = previous.key;
  if (previous.base === undefined) delete process.env.MCPJAM_BASE_URL;
  else process.env.MCPJAM_BASE_URL = previous.base;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
