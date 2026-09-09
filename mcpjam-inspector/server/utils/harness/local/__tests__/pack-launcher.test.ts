/**
 * The launcher's listen patch, exercised as the bridge would meet it.
 *
 * This file is the loopback guarantee: the exposure probe checks that the
 * guarantee held, but the launcher is what makes it hold. It is plain ESM that
 * patches `net.Server.prototype.listen` for the whole process and then imports
 * the bridge, so it runs in a spawned child — patching the test runner's own
 * prototype would leak into every other suite, and the bridge is not here.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const LAUNCHER = new URL("../pack/launcher.mjs", import.meta.url);

let dir: string;

/**
 * Run the launcher's patch, then listen the way the argument says, and report
 * the address the kernel actually bound.
 *
 * The launcher's trailing `import("./bridge.mjs")` is satisfied by a stub
 * beside the copy, which is also what proves the patch is installed BEFORE the
 * bridge gets to run: the stub does the listening.
 */
function boundAddress(listenArgs: string): string {
  const script = `
    import net from "node:net";
    const server = net.createServer();
    await new Promise((resolve) => server.listen(${listenArgs}, resolve));
    console.log(JSON.stringify(server.address()));
    server.close();
  `;
  writeFileSync(join(dir, "bridge.mjs"), script);
  const out = execFileSync(process.execPath, [join(dir, "launcher.mjs")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop()!).address;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcpjam-launcher-"));
  await writeFile(join(dir, "launcher.mjs"), await readFile(LAUNCHER, "utf8"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the pack launcher forces the bridge onto loopback", () => {
  // Every spelling of "every interface" the bridge could reach for. The rule
  // is an allowlist of loopback rather than a denylist of these, precisely so
  // that a spelling nobody listed is still forced — but the ones we can name
  // are worth pinning.
  it.each([
    ["no host at all", "0"],
    ["an empty host", '0, ""'],
    ["the IPv4 wildcard", '0, "0.0.0.0"'],
    ["the IPv6 wildcard", '0, "::"'],
    ["the IPv6 wildcard, zero-spelled", '0, "::0"'],
    ["a bare zero", '0, "0"'],
    ["an options object with no host", "{ port: 0 }"],
    ["an options object with a wildcard host", '{ port: 0, host: "0.0.0.0" }'],
  ])("rewrites %s", (_label, args) => {
    expect(boundAddress(args)).toBe("127.0.0.1");
  });

  it("leaves an explicit loopback host alone", () => {
    expect(boundAddress('0, "127.0.0.1"')).toBe("127.0.0.1");
    expect(boundAddress('{ port: 0, host: "127.0.0.1" }')).toBe("127.0.0.1");
  });
});
