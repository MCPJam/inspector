import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { getOrCreateLocalSecret } from "../local-secret-store.js";

const ORIGINAL_ENV = { ...process.env };

const spec = {
  fileName: "test-secret.txt",
  envVar: "TEST_LOCAL_SECRET",
  productionErrorMessage: "TEST_LOCAL_SECRET is required",
  label: "test local secret",
};

let tempDir: string;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mcpjam-local-secret-test-"));
  process.env.GUEST_JWT_KEY_DIR = tempDir;
  delete process.env.TEST_LOCAL_SECRET;
  delete process.env.VITE_MCPJAM_HOSTED_MODE;
  delete process.env.DOCKER_CONTAINER;
  delete process.env.RAILWAY_ENVIRONMENT;
  delete process.env.RAILWAY_SERVICE_ID;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe("getOrCreateLocalSecret", () => {
  it("uses the env var when present", () => {
    process.env.NODE_ENV = "production";
    process.env.VITE_MCPJAM_HOSTED_MODE = "true";
    process.env.TEST_LOCAL_SECRET = "from-env";

    expect(getOrCreateLocalSecret(spec)).toBe("from-env");
  });

  it("allows local production runtimes to use the persisted local secret", () => {
    process.env.NODE_ENV = "production";

    const value = getOrCreateLocalSecret(spec);
    const filePath = path.join(tempDir, spec.fileName);

    expect(value).toHaveLength(64);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8").trim()).toBe(value);
    expect(getOrCreateLocalSecret(spec)).toBe(value);
  });

  it("still rejects hosted production without an env var", () => {
    process.env.NODE_ENV = "production";
    process.env.DOCKER_CONTAINER = "true";

    expect(() => getOrCreateLocalSecret(spec)).toThrow(
      "TEST_LOCAL_SECRET is required"
    );
    expect(existsSync(path.join(tempDir, spec.fileName))).toBe(false);
  });

  it("keeps test runtime strict unless an env var is present", () => {
    process.env.NODE_ENV = "test";

    expect(() => getOrCreateLocalSecret(spec)).toThrow(
      "TEST_LOCAL_SECRET is required"
    );
  });
});
