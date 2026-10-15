import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "../staging-test";
import { fulfillWithoutForwardingCredentials } from "../staging-network";

let completed: boolean | undefined;
let origin: string;
let hungRequestStarted: () => void;
const server = createServer((request, response) => {
  if (request.url === "/hung") {
    hungRequestStarted();
    return;
  }
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
  if (completed !== undefined) expect(completed).toBe(true);
});

test("staging teardown finishes an in-flight proxy callback", async ({
  context,
  page,
}) => {
  completed = false;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const teardown = new Promise<void>((resolve) => {
    release = resolve;
  });
  const unrouteAll = context.unrouteAll.bind(context);
  context.unrouteAll = async (options) => {
    release();
    await unrouteAll(options);
  };
  await context.route(`${origin}/background`, async (route) => {
    started();
    // Hold the proxy callback until route teardown starts, regardless of speed.
    await teardown;
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

test("staging teardown cancels a hung proxy read", async ({
  context,
  page,
}) => {
  test.setTimeout(3_000);
  const pending = new Promise<void>((resolve) => {
    hungRequestStarted = resolve;
  });
  await context.route(`${origin}/hung`, (route) =>
    fulfillWithoutForwardingCredentials(route, route.request().headers()),
  );
  await page.goto(origin);
  await page.evaluate(() => {
    void fetch("/hung");
  });
  await pending;
});
