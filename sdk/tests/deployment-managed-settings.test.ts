import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  deploymentPolicy,
  managedSettingsPath,
  readManagedSettings,
} from "../src/deployment/managed-settings.js";

const SEAM = Symbol.for("mcpjam.managedSettingsPath");
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcpjam-managed-"));
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, SEAM);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function settingsFile(name: string, text: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, text);
  Reflect.set(globalThis, SEAM, path);
  return path;
}

describe("the IT settings file", () => {
  it("lives at a fixed system path per platform", () => {
    expect(managedSettingsPath("darwin")).toBe(
      "/Library/Application Support/MCPJam/managed-settings.json"
    );
    expect(managedSettingsPath("linux")).toBe(
      "/etc/mcpjam/managed-settings.json"
    );
    expect(managedSettingsPath("win32")).toBe(
      "C:\\Program Files\\MCPJam\\managed-settings.json"
    );
  });

  it("is absent when no file exists", () => {
    Reflect.set(globalThis, SEAM, join(directory, "missing.json"));
    expect(readManagedSettings()).toEqual({ state: "absent" });
    expect(deploymentPolicy()).toEqual({ locked: false });
  });

  it("reads a lock and normalizes its server", async () => {
    const path = await settingsFile(
      "locked.json",
      JSON.stringify({
        version: 1,
        apiUrl: "HTTPS://MCPJam.Acme.test/api/v1/",
        lock: true,
      })
    );
    expect(readManagedSettings()).toEqual({
      state: "valid",
      path,
      lock: true,
      deployment: {
        apiUrl: "https://mcpjam.acme.test/api/v1",
        baseUrl: "https://mcpjam.acme.test",
      },
    });
    expect(deploymentPolicy()).toEqual({ locked: true });
  });

  it("reads an unlocked organization default", async () => {
    await settingsFile(
      "default.json",
      JSON.stringify({
        version: 1,
        apiUrl: "http://127.0.0.1:3000/api/v1",
        lock: false,
      })
    );
    expect(readManagedSettings()).toMatchObject({
      state: "valid",
      lock: false,
    });
    expect(deploymentPolicy()).toEqual({ locked: false });
  });

  it.each([
    ["bad JSON", "{ version: 1", "is not valid JSON"],
    ["an array", "[]", "is not a JSON object"],
    [
      "missing lock",
      JSON.stringify({ version: 1, apiUrl: "https://a.test/api/v1" }),
      `needs "lock" set to true or false`,
    ],
    [
      "a string lock",
      JSON.stringify({
        version: 1,
        apiUrl: "https://a.test/api/v1",
        lock: "true",
      }),
      `needs "lock" set to true or false`,
    ],
    [
      "missing apiUrl",
      JSON.stringify({ version: 1, lock: true }),
      `needs "apiUrl" as a string`,
    ],
    [
      "version 2",
      JSON.stringify({
        version: 2,
        apiUrl: "https://a.test/api/v1",
        lock: true,
      }),
      `needs "version": 1`,
    ],
    [
      "missing version",
      JSON.stringify({ apiUrl: "https://a.test/api/v1", lock: true }),
      `needs "version": 1`,
    ],
    [
      "organizationId",
      JSON.stringify({
        version: 1,
        apiUrl: "https://a.test/api/v1",
        lock: true,
        organizationId: "org_1",
      }),
      `has a setting this CLI does not know: "organizationId"`,
    ],
    [
      "plain http to a public host",
      JSON.stringify({
        version: 1,
        apiUrl: "http://mcpjam.acme.test/api/v1",
        lock: true,
      }),
      "is not https://",
    ],
    [
      "an unusable URL",
      JSON.stringify({ version: 1, apiUrl: "mcpjam.acme.test", lock: true }),
      `needs "apiUrl" as a full http(s) URL`,
    ],
  ])(
    "is invalid with %s, and the policy fails closed",
    async (name, text, problem) => {
      const path = await settingsFile(
        `${name.replaceAll(" ", "-")}.json`,
        text
      );
      const settings = readManagedSettings();
      expect(settings).toMatchObject({ state: "invalid", path });
      expect(settings.state === "invalid" && settings.problem).toContain(
        problem
      );
      const policy = deploymentPolicy();
      expect(policy.locked).toBe(false);
      expect(policy.invalid).toContain(path);
      expect(policy.invalid).toContain(problem);
    }
  );

  it("is invalid when the path cannot be read as a file", async () => {
    const path = join(directory, "a-directory");
    await mkdir(path, { recursive: true });
    Reflect.set(globalThis, SEAM, path);
    expect(readManagedSettings()).toMatchObject({
      state: "invalid",
      problem: "could not be read (EISDIR)",
    });
  });
});
