import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { createXaaWebRouter } from "../../xaa.js";

const app = new Hono();
app.route("/api/web/xaa", createXaaWebRouter());

// The Node adapter replaces the global Request and Response constructors.
// Keep this setup in a child process so the mutation cannot leak into Vitest.
createAdaptorServer({ fetch: app.fetch });

const malformedOrgId = encodeURIComponent("[object Response]");
const response = await app.request(
  `https://app.mcpjam.com/api/web/xaa/o/${malformedOrgId}/.well-known/openid-configuration`
);
const body = await response.json();

process.stdout.write(
  JSON.stringify({
    status: response.status,
    body,
  })
);
