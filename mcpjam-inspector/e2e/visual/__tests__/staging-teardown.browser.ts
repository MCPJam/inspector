import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "../staging-test";
import { fulfillWithoutForwardingCredentials } from "../staging-network";

let completed = false;
let origin: string;
const server = createServer((_request, response) => {
  response.end("Background read");
});

test.beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server port");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  expect(completed).toBe(true);
});

test("staging teardown drains an in-flight proxy callback", async ({
  context,
  page,
}) => {
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  await context.route(`${origin}/background`, async (route) => {
    started();
    // Keep the callback alive beyond the test body, like a slow staging read.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fulfillWithoutForwardingCredentials(route, route.request().headers());
    completed = true;
  });
  await page.goto(origin);
  await page.evaluate(() => {
    void fetch("/background");
  });
  await pending;
  expect(completed).toBe(false);
});
