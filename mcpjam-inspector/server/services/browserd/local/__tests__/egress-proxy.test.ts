import { it, expect } from "vitest";
import { createServer, request } from "node:http";
import { startLocalBrowserProxy } from "../egress-proxy.js";
import { createLocalBrowserSecurityPolicy } from "../security-policy.js";

it("forwards authenticated localhost development requests but denies the controller and strips proxy credentials", async () => {
  let headers: unknown;
  const site = createServer((req, res) => {
    headers = req.headers;
    res.end("development page");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const port = (site.address() as import("node:net").AddressInfo).port;
  const policy = createLocalBrowserSecurityPolicy({
    controllerUrls: ["http://localhost:62345"],
  });
  const proxy = await startLocalBrowserProxy(policy);
  const auth = `Basic ${Buffer.from(
    `${proxy.proxy.username}:${proxy.proxy.password}`,
  ).toString("base64")}`;
  const get = (target: string, authorized = true) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        proxy.proxy.server,
        {
          path: target,
          headers: authorized ? { "Proxy-Authorization": auth } : {},
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    expect(await get(`http://127.0.0.1:${port}/`)).toEqual({
      status: 200,
      body: "development page",
    });
    expect(headers).not.toHaveProperty("proxy-authorization");
    expect((await get("http://localhost:62345/api/session-token")).status).toBe(
      403,
    );
    expect((await get(proxy.proxy.server)).status).toBe(403);
    expect((await get(`http://127.0.0.1:${port}/`, false)).status).toBe(407);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
  }
});
