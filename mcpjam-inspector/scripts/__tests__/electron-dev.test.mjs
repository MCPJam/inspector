import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  DEFAULT_SERVER_PORT,
  findFreeServerPort,
  isPortFree,
  parseElectronDevArgs,
  resolveLaunchServerPort,
} from "../electron-dev.mjs";

test("an occupied explicit --server-port is refused, never split from the renderer", async () => {
  // A real listener on an ephemeral port, as in the review's reproduction:
  // the launcher used to accept it, pin the renderer's proxy to it, and let
  // main fall forward to the next port.
  const holder = net.createServer();
  const occupied = await new Promise((resolve) =>
    holder.listen(0, "127.0.0.1", () => resolve(holder.address().port)),
  );
  try {
    assert.equal(await isPortFree(occupied), false);
    await assert.rejects(
      resolveLaunchServerPort({ explicitPort: occupied }),
      new RegExp(`--server-port ${occupied} is already in use`),
    );
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }
});

test("a free explicit --server-port is used as is; none means the first free one", async () => {
  assert.equal(
    await resolveLaunchServerPort({ explicitPort: 7000, isFree: async () => true }),
    7000,
  );
  assert.equal(
    await resolveLaunchServerPort({
      start: 6274,
      isFree: async (port) => port !== 6274,
    }),
    6275,
  );
});

test("the free-port walk starts at 6274 and skips ports another Inspector holds", async () => {
  const asked = [];
  const taken = new Set([6274, 6275]);
  const port = await findFreeServerPort({
    isFree: async (candidate) => {
      asked.push(candidate);
      return !taken.has(candidate);
    },
  });
  assert.equal(port, 6276);
  assert.deepEqual(asked, [6274, 6275, 6276]);
});

test("a fully occupied range is an error that names the escape hatch", async () => {
  await assert.rejects(
    findFreeServerPort({ attempts: 3, isFree: async () => false }),
    /6274\.\.6276.*--server-port/,
  );
});

test("--server-port pins the port and everything else goes to forge", () => {
  assert.deepEqual(parseElectronDevArgs(["--server-port", "7000", "--", "--inspect"]), {
    serverPort: 7000,
    forgeArgs: ["--", "--inspect"],
  });
  assert.deepEqual(parseElectronDevArgs(["--server-port=7001"]), {
    serverPort: 7001,
    forgeArgs: [],
  });
  assert.deepEqual(parseElectronDevArgs([]), {
    serverPort: undefined,
    forgeArgs: [],
  });
  assert.throws(() => parseElectronDevArgs(["--server-port", "abc"]), /--server-port/);
  assert.throws(() => parseElectronDevArgs(["--server-port", "70000"]), /--server-port/);
  assert.equal(DEFAULT_SERVER_PORT, 6274);
});
