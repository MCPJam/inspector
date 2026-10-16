import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  DEFAULT_PORT_FALLBACK_ATTEMPTS,
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
  // PLB-190: `npx @mcpjam/inspector` next to a running desktop app, which
  // holds 6274, exited instead of starting.
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

test("the walk never probes past the last valid port", async () => {
  const probed = [];
  await assert.rejects(
    selectStartPort({
      requestedPort: 65534,
      explicit: false,
      isPortAvailable: async (port) => {
        probed.push(port);
        return false;
      },
    }),
    (error) => error.message === "Ports 65534-65535 are all in use",
  );
  assert.deepEqual(probed, [65534, 65535]);
});

test("a real listener on the default moves the launch to another port", async () => {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const occupied = listener.address().port;
  const isPortAvailable = (port) =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
  try {
    const port = await selectStartPort({
      requestedPort: occupied,
      explicit: false,
      isPortAvailable,
    });
    assert.notEqual(port, occupied);
    assert.ok(
      port > occupied && port < occupied + DEFAULT_PORT_FALLBACK_ATTEMPTS,
    );
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});
