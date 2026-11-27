import { Hono } from "hono";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/** Who has `web-clients-enabled` on; "" stands for the flag file. */
const flagOn = vi.hoisted(() => new Set<string>());
vi.mock("../endpoint-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../endpoint-auth.js")>()),
  webClientsEnabledFor: async (userId?: string) => flagOn.has(userId ?? ""),
}));
// A bearer `token-<id>` is the signed-in person `<id>`.
vi.mock("../../../utils/flag-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../utils/flag-identity.js")>()),
  verifiedFlagSubject: async (token: string) => ({
    kind: "id",
    distinctId: token.replace(/^token-/, ""),
  }),
}));

import {
  createLocalConnectorRoutes,
  mountInspectorWebConnectors,
} from "../inspector-endpoint.js";
import { startFixtureServer, vendorClient } from "./forwarding-fixtures.js";

let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await fixture.close();
});
afterEach(() => {
  flagOn.clear();
});

/** This Inspector's endpoint and control routes, registering one local connector. */
async function registerLocal(authorization?: string) {
  const app = new Hono();
  mountInspectorWebConnectors(app);
  app.route("/api/web-clients/local-connectors", createLocalConnectorRoutes());
  const created = await app.request(
    "http://localhost:6274/api/web-clients/local-connectors",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({ upstreamUrl: fixture.url }),
    },
  );
  expect(created.status).toBe(201);
  const { path } = await created.json();
  return vendorClient(app, { path });
}

describe("local connectors on this Inspector", () => {
  it("stop forwarding when the flag of the person who registered them goes off", async () => {
    flagOn.add("user_1");
    const vendor = await registerLocal("Bearer token-user_1");
    expect((await vendor.listTools()).status).toBe(200);
    flagOn.delete("user_1");
    expect((await vendor.listTools()).status).toBe(404);
  });

  it("answer to the flag file when no one signed in registered them", async () => {
    flagOn.add("");
    const vendor = await registerLocal();
    expect((await vendor.listTools()).status).toBe(200);
    flagOn.delete("");
    expect((await vendor.listTools()).status).toBe(404);
  });
});
