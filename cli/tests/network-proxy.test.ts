import assert from "node:assert/strict";
import test from "node:test";
import {
  installProxyDispatcher,
  nodeHonorsEnvProxy,
  updateCheckEnv,
} from "../src/lib/network-proxy.js";

test("Node routes http and https through NODE_USE_ENV_PROXY from v22.21 and v24.5", () => {
  for (const [version, honors] of [
    ["22.12.0", false],
    ["22.20.9", false],
    ["22.21.0", true],
    ["23.11.0", false],
    ["24.4.1", false],
    ["24.5.0", true],
    ["26.3.0", true],
  ] as const) {
    assert.equal(nodeHonorsEnvProxy(version), honors, version);
  }
});

test("without a proxy the update check keeps the environment as it is", () => {
  const env = { PATH: "/bin", NO_PROXY: "corp.test" };
  assert.equal(updateCheckEnv(env, "24.22.1"), env);
});

test("the update check gets one resolved proxy in both spellings, loopback direct", () => {
  const env = updateCheckEnv(
    {
      PATH: "/bin",
      https_proxy: "",
      HTTPS_PROXY: "http://proxy.corp:3128",
      no_proxy: "",
      NO_PROXY: "git.corp.test",
    },
    "24.22.1",
  );
  assert.deepEqual(env, {
    PATH: "/bin",
    NODE_USE_ENV_PROXY: "1",
    https_proxy: "http://proxy.corp:3128",
    HTTPS_PROXY: "http://proxy.corp:3128",
    no_proxy: "git.corp.test,localhost,127.0.0.1,[::1]",
    NO_PROXY: "git.corp.test,localhost,127.0.0.1,[::1]",
  });
});

test("behind a proxy, a Node that cannot use it skips the update check", () => {
  assert.equal(updateCheckEnv({ HTTPS_PROXY: "http://proxy.corp:3128" }, "22.12.0"), null);
});

test("no proxy variable installs no dispatcher", () => {
  assert.equal(installProxyDispatcher({ https_proxy: "", HTTP_PROXY: " " }), false);
});
