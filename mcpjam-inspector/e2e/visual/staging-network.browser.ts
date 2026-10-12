import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "@playwright/test";
import { fulfillWithoutForwardingCredentials } from "./staging-network";

test("Cloudflare credentials do not follow a staging redirect", async ({
  page,
}) => {
  const observed: Record<string, string | string[] | undefined> = {};
  const server = createServer((request, response) => {
    observed[request.url ?? ""] = request.headers["cf-access-client-secret"];
    if (request.url === "/staging") {
      response.writeHead(302, { location: "/identity-provider" });
      response.end();
    } else response.end("Identity provider");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server port");
    const origin = `http://127.0.0.1:${address.port}`;
    await page.route(`${origin}/staging`, (route) =>
      fulfillWithoutForwardingCredentials(route, {
        ...route.request().headers(),
        "CF-Access-Client-Secret": "synthetic-access-secret",
      }),
    );
    await page.goto(`${origin}/staging`);
    await expect(page.getByText("Identity provider")).toBeVisible();
    expect(observed["/staging"]).toBe("synthetic-access-secret");
    expect(Object.hasOwn(observed, "/identity-provider")).toBe(true);
    expect(observed["/identity-provider"]).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
