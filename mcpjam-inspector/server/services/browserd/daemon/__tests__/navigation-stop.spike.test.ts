/**
 * Live check of the callback stop behind the egress proxy, in real Chromium.
 * Opt-in like the other spikes (`RUN_BROWSERD_SPIKE=true`, pinned Chromium).
 *
 * The readiness browser sends every request through a proxy that asks for
 * credentials, and the sign-in arms the stop before its first navigation.
 * With the stop's own Fetch session unable to answer that challenge, the
 * login page failed with `net::ERR_INVALID_AUTH_CREDENTIALS` (headed) or hung
 * (headless) before anything loaded.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchBrowserdContext } from "../chromium-launch";
import { ChromiumDriver } from "../chromium-driver";
import type { BrowserEgressPolicy } from "../public-network";

const RUN = process.env.RUN_BROWSERD_SPIKE === "true";

/** Every destination is this test's own server: the proxy, not the policy, is under test. */
const loopbackOnly: BrowserEgressPolicy = {
  isActive: () => true,
  onRevoked: () => () => {},
  allowsRequest: () => true,
  resolveDestination: async () => [{ address: "127.0.0.1", family: 4 }],
};

describe.skipIf(!RUN)("navigation stop behind the egress proxy — real browser", () => {
  let server: Server;
  let base: string;
  let userDataDir: string;
  let driver: ChromiumDriver;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/authorize")) {
        res.writeHead(302, { location: `${base}/callback?code=c1&state=s1` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>login</title><h1>Sign in</h1>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
    userDataDir = await mkdtemp(join(tmpdir(), "browserd-stop-spike-"));
    const context = await launchBrowserdContext({
      userDataDir,
      headless: process.env.BROWSERD_SPIKE_HEADED !== "true",
      contextMode: "ephemeral",
      egressPolicy: loopbackOnly,
    });
    expect(context.proxyAuth?.username).toBeTruthy();
    driver = new ChromiumDriver(context);
  }, 60_000);

  afterAll(async () => {
    try {
      await driver?.close();
    } finally {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("loads the sign-in page with the stop armed, then stops at the callback with its code", async () => {
    const callback = `${base}/callback`;
    const opened = await driver.execute({
      commandId: "open",
      source: "inspector",
      action: { kind: "navigate", url: `${base}/login` },
      stopAt: callback,
      stopAtPersistent: true,
    });
    expect(opened.error).toBeUndefined();
    expect(opened.ok).toBe(true);
    expect(opened.stoppedAt).toBeUndefined();

    const approved = await driver.execute({
      commandId: "approve",
      source: "inspector",
      action: { kind: "navigate", url: `${base}/authorize` },
      stopAt: callback,
      stopAtPersistent: true,
    });
    expect(approved.stoppedAt).toBe(`${callback}?code=c1&state=s1`);
  }, 60_000);
});
