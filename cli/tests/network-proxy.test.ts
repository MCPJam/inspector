import assert from "node:assert/strict";
import test from "node:test";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import {
  cliProxy,
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
    https_proxy: "http://proxy.corp:3128/",
    HTTPS_PROXY: "http://proxy.corp:3128/",
    no_proxy: "git.corp.test,localhost,127.0.0.1,[::1]",
    NO_PROXY: "git.corp.test,localhost,127.0.0.1,[::1]",
  });
});

test("behind a proxy, a Node that cannot use it skips the update check", () => {
  assert.equal(updateCheckEnv({ HTTPS_PROXY: "http://proxy.corp:3128" }, "22.12.0"), null);
});

test("a proxy without a scheme means http://, as it does to curl", () => {
  assert.equal(
    cliProxy({ HTTPS_PROXY: "proxy.corp.com:8080" }).httpsProxy,
    "http://proxy.corp.com:8080/",
  );
  assert.equal(
    cliProxy({ http_proxy: "10.0.0.1:3128" }).httpProxy,
    "http://10.0.0.1:3128/",
  );
});

test("a scheme in capitals reaches the update check lowercased, which Node's proxy support needs", () => {
  assert.equal(
    updateCheckEnv({ HTTPS_PROXY: "HTTP://proxy.corp:3128" }, "24.22.1")
      ?.https_proxy,
    "http://proxy.corp:3128/",
  );
});

test("NO_PROXY=* keeps meaning every host, which undici honors only as the whole value", () => {
  assert.equal(
    cliProxy({ HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "*" }).noProxy,
    "*",
  );
  assert.equal(cliProxy({ no_proxy: "git.corp.test, *" }).noProxy, "*");
  assert.equal(
    updateCheckEnv(
      { HTTPS_PROXY: "http://proxy.corp:3128", NO_PROXY: "*" },
      "24.22.1",
    )?.no_proxy,
    "*",
  );
});

test("an unusable proxy is reported and left out instead of stopping the CLI", () => {
  const warnings: string[] = [];
  assert.equal(
    installProxyDispatcher(
      { HTTPS_PROXY: "socks5://proxy.corp:1080", HTTP_PROXY: "http://" },
      (message) => warnings.push(message),
    ),
    false,
  );
  assert.deepEqual(
    warnings.map((message) => message.split(" ")[0]),
    ["HTTPS_PROXY", "HTTP_PROXY"],
  );
  assert.equal(updateCheckEnv({ HTTPS_PROXY: "socks5://proxy.corp:1080" }, "24.22.1"), null);
});

test("an unset proxy reaches undici as empty, so it never reads the raw environment", () => {
  const previous = getGlobalDispatcher();
  const saved = process.env.https_proxy;
  process.env.https_proxy = " ";
  try {
    assert.equal(
      installProxyDispatcher({ https_proxy: " ", HTTP_PROXY: "http://proxy.corp:3128" }, () => {}),
      true,
    );
  } finally {
    if (saved === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = saved;
    setGlobalDispatcher(previous);
  }
});

test("with only HTTP_PROXY set, the update check sends https through it, as the CLI does", () => {
  assert.deepEqual(updateCheckEnv({ PATH: "/bin", HTTP_PROXY: "http://proxy.corp:3128" }, "24.22.1"), {
    PATH: "/bin",
    NODE_USE_ENV_PROXY: "1",
    https_proxy: "http://proxy.corp:3128/",
    HTTPS_PROXY: "http://proxy.corp:3128/",
    http_proxy: "http://proxy.corp:3128/",
    HTTP_PROXY: "http://proxy.corp:3128/",
    no_proxy: "localhost,127.0.0.1,[::1]",
    NO_PROXY: "localhost,127.0.0.1,[::1]",
  });
});

test("no proxy variable installs no dispatcher", () => {
  assert.equal(installProxyDispatcher({ https_proxy: "", HTTP_PROXY: " " }), false);
});
