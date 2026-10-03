import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SERVER_PORT,
  findFreeServerPort,
  parseElectronDevArgs,
} from "../electron-dev.mjs";

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
