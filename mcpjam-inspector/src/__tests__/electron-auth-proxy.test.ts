import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createServer, type UserConfigFn, type ViteDevServer } from "vite";
import rendererConfig from "../../vite.renderer.config.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let backend: Server | undefined;
let renderer: ViteDevServer | undefined;

afterEach(async () => {
  await renderer?.close();
  if (backend) {
    backend.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      backend!.close((error) => (error ? reject(error) : resolve())),
    );
  }
  vi.unstubAllEnvs();
});

it("forwards Electron login and session refresh to its own embedded backend", async () => {
  const requests: Array<{ path?: string; body: unknown; cookie?: string }> = [];
  backend = createHttpServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      path: request.url,
      body: JSON.parse(body),
      cookie: request.headers.cookie,
    });
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "local-session=test-session; HttpOnly; Path=/",
    });
    response.end(JSON.stringify({ access_token: "test-access-token" }));
  });
  await new Promise<void>((resolve) => backend!.listen(0, resolve));
  vi.stubEnv("SERVER_PORT", String((backend.address() as AddressInfo).port));
  const config = await (rendererConfig as UserConfigFn)({
    command: "serve",
    mode: "development",
  });
  renderer = await createServer({
    configFile: false,
    root: resolve(root, "client"),
    logLevel: "silent",
    server: {
      ...config.server,
      host: "127.0.0.1",
      port: 0,
      open: false,
      hmr: false,
    },
  });
  await renderer.listen();
  const port = (renderer.httpServer!.address() as AddressInfo).port;
  const endpoint = `http://127.0.0.1:${port}/user_management/authenticate`;
  const login = {
    client_id: "test-client",
    grant_type: "authorization_code",
    code: "test-code",
    code_verifier: "test-verifier",
  };
  const loggedIn = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(login),
  });
  expect(loggedIn.status).toBe(200);
  expect(await loggedIn.json()).toEqual({ access_token: "test-access-token" });
  expect(loggedIn.headers.get("set-cookie")).toBe(
    "local-session=test-session; HttpOnly; Path=/",
  );

  // Cookie-mode AuthKit omits refresh_token: the embedded backend restores it.
  const refresh = { client_id: "test-client", grant_type: "refresh_token" };
  const refreshed = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: "local-session=test-session",
    },
    body: JSON.stringify(refresh),
  });
  expect(refreshed.status).toBe(200);
  await refreshed.json();
  expect(requests).toEqual([
    { path: "/user_management/authenticate", body: login, cookie: undefined },
    {
      path: "/user_management/authenticate",
      body: refresh,
      cookie: "local-session=test-session",
    },
  ]);
});
