import { expect, test } from "@playwright/test";
import { createServer as createTcpServer, connect } from "node:net";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
const token = process.env.MCPJAM_SESSION_TOKEN!;
const key = "mcpjam.local-access";

test("production documents and credential checks never disclose the key", async ({
  request,
}) => {
  for (const path of ["/", "/testest"]) {
    const res = await request.get(path, {
      headers: { Host: "localhost", "X-Forwarded-For": "198.51.100.1" },
    });
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(token);
    expect(html).not.toContain("__MCP_SESSION_TOKEN__");
  }
  const refused = await request.get("/api/session-token", {
    headers: { Host: "localhost" },
  });
  expect(refused.status()).toBe(401);
  const checked = await request.get("/api/session-token", {
    headers: { "X-MCP-Session-Auth": `Bearer ${token}` },
  });
  expect(await checked.json()).toEqual({ ok: true });
  for (const route of ["adapter-http", "manager-http"]) {
    expect((await request.get(`/api/mcp/${route}/example`)).status()).toBe(401);
    expect(
      (
        await request.post(`/api/mcp/${route}/example`, {
          data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        })
      ).status(),
    ).toBe(401);
  }
});

test("a plain address needs a link; opening it resumes both same-origin tabs", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Open MCPJam from your terminal" }),
  ).toBeVisible();
  const other = await context.newPage();
  const checked = other.waitForResponse(
    (res) => res.url().endsWith("/api/session-token") && res.status() === 200,
  );
  await other.goto(`/#token=${token}`);
  await checked;
  await expect(other).not.toHaveURL(/token=/);
  await expect(other.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  expect(await other.evaluate((key) => localStorage.getItem(key), key)).toBe(
    token,
  );
});

test("a stale link shows restart guidance and can be replaced by pasting", async ({
  page,
}) => {
  await page.goto("/#token=expired-access-link-credential");
  await expect(
    page.getByRole("heading", { name: "MCPJam restarted" }),
  ).toBeVisible();
  await page.getByText("Paste the link instead", { exact: true }).click();
  await page.getByLabel("Link or code from your terminal").fill(token);
  await page.getByRole("button", { name: "Open MCPJam", exact: true }).click();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
});

test("storage-blocked browsers sign in from memory", async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === "mcpjam.local-access")
        throw new DOMException("blocked", "SecurityError");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "mcpjam.local-access")
        throw new DOMException("blocked", "SecurityError");
      set.call(this, key, value);
    };
  });
  await page.goto(`/#token=${token}`);
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await expect(page).not.toHaveURL(/token=/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Open MCPJam from your terminal" }),
  ).toBeVisible();
});

test("TCP forwarding and a Host-rewriting proxy cannot acquire credentials", async ({
  request,
  baseURL,
}) => {
  const target = new URL(baseURL!);
  const sockets = new Set<import("node:net").Socket>();
  const forward = createTcpServer((socket) => {
    const upstream = connect(Number(target.port), target.hostname);
    sockets.add(socket);
    sockets.add(upstream);
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  const proxy = createHttpServer((req, res) => {
    const upstream = httpRequest(
      {
        // The upstream is always the app under test; only the path comes from
        // the incoming request. An absolute req.url must not retarget it.
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: "localhost",
          "x-forwarded-host": "remote.example",
          "x-forwarded-for": "198.51.100.20",
        },
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await Promise.all(
    [forward, proxy].map(
      (server) =>
        new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
    ),
  );
  try {
    for (const server of [forward, proxy]) {
      const origin = `http://127.0.0.1:${
        (server.address() as import("node:net").AddressInfo).port
      }`;
      const refused = await request.get(`${origin}/api/session-token`, {
        headers: { Host: "localhost" },
      });
      expect(refused.status()).toBe(401);
      expect(await refused.text()).not.toContain(token);
      for (const path of ["/", "/testest"]) {
        const document = await request.get(`${origin}${path}`, {
          headers: { Host: "localhost" },
        });
        expect(document.status()).toBe(200);
        expect(await document.text()).not.toContain(token);
      }
      expect(
        (
          await request.post(`${origin}/api/mcp/connect`, {
            headers: { Host: "localhost" },
            data: {},
          })
        ).status(),
      ).toBe(401);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections();
    await Promise.all(
      [forward, proxy].map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    );
  }
});
