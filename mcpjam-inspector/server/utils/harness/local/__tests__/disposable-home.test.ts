import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localHarnessStateRoot } from "../grants.js";
import { useDisposableHome } from "./disposable-home.js";

let home: string;

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-disposable-home-")));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("useDisposableHome", () => {
  it("moves the harness state root under the temporary home on this platform", () => {
    const restore = useDisposableHome(home);
    try {
      expect(homedir()).toBe(home);
      expect(localHarnessStateRoot()).toBe(join(home, ".mcpjam", "harness-local"));
    } finally {
      restore();
    }
  });

  it("puts both home variables back as they were", () => {
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    useDisposableHome(home)();
    expect({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }).toEqual(before);
  });
});
