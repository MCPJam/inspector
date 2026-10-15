/**
 * The Inspector layer's launcher, run as a real child process.
 *
 * Two guarantees: the loopback patch (the bridge cannot publish its control
 * channel to the network), and invariant 1 at module resolution — code in the
 * layer may load Node builtins, its own files, and bare specifiers resolved
 * INSIDE the vendor root it is given, and nothing else. Each case is a bridge
 * stub written beside a copy of the launcher, so the patch and the hook are
 * installed before the "bridge" runs, exactly as in a session.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const LAUNCHER = new URL("../layer/launcher.mjs", import.meta.url);

let base: string;
let layer: string;
let vendor: string;

/** Run the launcher with `bridge` as `bridge.mjs`; stdout and exit code. */
function run(bridge: string, args: string[] = []): { code: number; out: string; err: string } {
  return runIn(layer, bridge, args);
}

function runIn(dir: string, bridge: string, args: string[]) {
  writeFileSync(join(dir, "bridge.mjs"), bridge);
  try {
    const out = execFileSync(process.execPath, [join(dir, "launcher.mjs"), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (error) {
    const failed = error as { status: number; stdout: string; stderr: string };
    return { code: failed.status, out: failed.stdout, err: failed.stderr };
  }
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-layer-launcher-")));
  layer = join(base, "runtime", "inspector-layer", "abc");
  vendor = join(base, "runtime", "pack", "claude-code");
  await mkdir(layer, { recursive: true });
  await writeFile(join(layer, "launcher.mjs"), await readFile(LAUNCHER, "utf8"));
  await writeFile(join(layer, "sibling.mjs"), 'export const sibling = "layer";\n');
  // A vendor package inside the pack…
  await mkdir(join(vendor, "node_modules", "vendor-sdk"), { recursive: true });
  await writeFile(
    join(vendor, "node_modules", "vendor-sdk", "package.json"),
    JSON.stringify({ name: "vendor-sdk", type: "module", main: "index.js" }),
  );
  await writeFile(join(vendor, "node_modules", "vendor-sdk", "index.js"), 'export const from = "pack";\n');
  // …and one that exists only ABOVE the layer and the pack: a user's stray
  // install, which must never load.
  await mkdir(join(base, "node_modules", "stray-package"), { recursive: true });
  await writeFile(
    join(base, "node_modules", "stray-package", "package.json"),
    JSON.stringify({ name: "stray-package", type: "module", main: "index.js" }),
  );
  await writeFile(join(base, "node_modules", "stray-package", "index.js"), 'export const from = "stray";\n');
  await writeFile(join(base, "outside.mjs"), 'export const outside = true;\n');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("the layer launcher forces the bridge onto loopback", () => {
  it.each([
    ["no host at all", "0"],
    ["the IPv4 wildcard", '0, "0.0.0.0"'],
    ["the IPv6 wildcard", '0, "::"'],
    ["an options object with a wildcard host", '{ port: 0, host: "0.0.0.0" }'],
  ])("rewrites %s", (_label, args) => {
    const result = run(`
      import net from "node:net";
      const server = net.createServer();
      await new Promise((resolve) => server.listen(${args}, resolve));
      console.log(server.address().address);
      server.close();
    `);
    expect(result.err).toBe("");
    expect(result.out.trim()).toBe("127.0.0.1");
  });
});

describe("the layer launcher admits only the two trusted sources", () => {
  it("loads Node builtins and the layer's own files", () => {
    const result = run(`
      import { sibling } from "./sibling.mjs";
      import { createHash } from "node:crypto";
      import path from "path";
      console.log(sibling, typeof createHash, typeof path.join);
    `);
    expect(result.out.trim()).toBe("layer function function");
  });

  it("refuses every bare import when it names no vendor root", () => {
    const result = run(`import { from } from "vendor-sdk"; console.log(from);`);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/may not import "vendor-sdk"/);
  });

  it("resolves a bare import from the vendor root, and hides its own flag from the bridge", () => {
    const result = run(
      `import { from } from "vendor-sdk"; console.log(from, JSON.stringify(process.argv.slice(2)));`,
      ["--mcpjam-vendor-root", vendor, "--workdir", "/w"],
    );
    expect(result.err).toBe("");
    expect(result.out.trim()).toBe('pack ["--workdir","/w"]');
  });

  it("refuses a bare import that only resolves outside the vendor root", () => {
    const result = run(`import { from } from "stray-package"; console.log(from);`, [
      "--mcpjam-vendor-root",
      vendor,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/resolved outside the verified runtime pack/);
  });

  it("refuses a relative import that climbs out of the layer", () => {
    const result = run(`import { outside } from "../../../outside.mjs"; console.log(outside);`);
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/resolved outside the Inspector layer/);
  });

  it("refuses a CommonJS require of anything but a builtin, too", () => {
    const result = run(`
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      console.log(typeof require("node:path").join);
      require("stray-package");
    `);
    expect(result.out.trim()).toBe("function");
    expect(result.code).not.toBe(0);
    expect(result.err).toMatch(/may not import "stray-package"/);
  });

  it("refuses a vendor root that is not absolute", () => {
    const result = run(`console.log("ran");`, ["--mcpjam-vendor-root", "relative/pack"]);
    expect(result.code).not.toBe(0);
    expect(result.out).not.toContain("ran");
  });
});
