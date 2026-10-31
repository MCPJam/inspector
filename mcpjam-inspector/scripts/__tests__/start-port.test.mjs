import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  DEFAULT_PORT_FALLBACK_ATTEMPTS,
  isPortAvailable,
  resolveStartPortEnv,
  selectStartPort,
  StartPortUnavailableError,
} from "../../bin/start-port.mjs";

const busy = (...ports) => {
  const taken = new Set(ports);
  return async (port) => !taken.has(port);
};

test("a launch without --port starts on the default when it is free", async () => {
  assert.equal(
    await selectStartPort({
      requestedPort: 6274,
      explicit: false,
      isPortAvailable: busy(),
    }),
    6274,
  );
});

test("a launch without --port moves to the next free port when the default is taken", async () => {
  assert.equal(
    await selectStartPort({
      requestedPort: 6274,
      explicit: false,
      isPortAvailable: busy(6274, 6275),
    }),
    6276,
  );
});

test("a launch without --port gives up after the fallback walk, naming the range", async () => {
  const taken = Array.from(
    { length: DEFAULT_PORT_FALLBACK_ATTEMPTS },
    (_, i) => 6274 + i,
  );
  await assert.rejects(
    selectStartPort({
      requestedPort: 6274,
      explicit: false,
      isPortAvailable: busy(...taken),
    }),
    (error) =>
      error instanceof StartPortUnavailableError &&
      error.message === "Ports 6274-6283 are all in use" &&
      /--port/.test(error.hint),
  );
});

test("an explicit --port that is taken fails instead of serving elsewhere", async () => {
  let probes = 0;
  await assert.rejects(
    selectStartPort({
      requestedPort: 7000,
      explicit: true,
      isPortAvailable: async (port) => {
        probes += 1;
        return port !== 7000;
      },
    }),
    (error) =>
      error instanceof StartPortUnavailableError &&
      error.message === "Explicitly requested port 7000 is not available",
  );
  assert.equal(probes, 1);
});

test("the launcher's probe sees a real listener and walks past it", async (t) => {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const occupied = listener.address().port;
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  if (occupied + DEFAULT_PORT_FALLBACK_ATTEMPTS > 65535) {
    t.skip("the OS handed out a port too close to 65535 to walk from");
    return;
  }

  assert.equal(await isPortAvailable(occupied), false);
  const port = await selectStartPort({
    requestedPort: occupied,
    explicit: false,
    isPortAvailable,
  });
  assert.ok(
    port > occupied && port < occupied + DEFAULT_PORT_FALLBACK_ATTEMPTS,
  );
});

test("a bare launch with 6274 taken points every derived address at the chosen port", async () => {
  const { requestedPort, port, env } = await resolveStartPortEnv({
    envVars: {},
    profile: {},
    isPortAvailable: busy(6274),
  });

  assert.equal(requestedPort, 6274);
  assert.equal(port, 6275);
  assert.equal(env.PORT, "6275");
  assert.equal(env.SERVER_PORT, "6275");
  assert.equal(env.MCPJAM_BROWSER_PORT, "6275");
  assert.equal(env.BASE_URL, "http://127.0.0.1:6275");
  assert.equal(env.CLI_AUTH_PUBLIC_ORIGIN, "http://127.0.0.1:6275");
  assert.equal(env.SLACK_LINK_PUBLIC_ORIGIN, "http://127.0.0.1:6275");
  assert.equal(env.DISCORD_LINK_PUBLIC_ORIGIN, "http://127.0.0.1:6275");
});

test("a loopback callback origin from the default port does not survive the walk", async () => {
  const { env } = await resolveStartPortEnv({
    envVars: {},
    profile: {
      ENVIRONMENT: "dev",
      CLI_AUTH_PUBLIC_ORIGIN: "http://localhost:6274",
      SLACK_LINK_PUBLIC_ORIGIN: "https://inspector.example.com/slack",
    },
    isPortAvailable: busy(6274),
  });

  assert.equal(env.BASE_URL, "http://localhost:6275");
  assert.equal(env.CLI_AUTH_PUBLIC_ORIGIN, "http://localhost:6275");
  // A non-loopback origin is a deliberate public deployment and is kept.
  assert.equal(env.SLACK_LINK_PUBLIC_ORIGIN, "https://inspector.example.com");
});

test("a PORT from --port or -e PORT= is explicit and never walks", async () => {
  const probed = [];
  await assert.rejects(
    resolveStartPortEnv({
      envVars: { PORT: "6274" },
      profile: {},
      isPortAvailable: async (port) => {
        probed.push(port);
        return false;
      },
    }),
    (error) =>
      error instanceof StartPortUnavailableError &&
      error.message === "Explicitly requested port 6274 is not available",
  );
  assert.deepEqual(probed, [6274]);
});

test("an invalid port is refused before anything is probed", async () => {
  await assert.rejects(
    resolveStartPortEnv({
      envVars: { PORT: "70000" },
      profile: {},
      isPortAvailable: async () => {
        throw new Error("should not probe");
      },
    }),
    { message: "Invalid port: 70000" },
  );
});
