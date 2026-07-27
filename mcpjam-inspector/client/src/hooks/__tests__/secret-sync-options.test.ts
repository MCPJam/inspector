/**
 * The form-data → persistence secret contract, in one place.
 *
 * `syncServerToConvex` writes `env` / `headers` exclusively from
 * `buildSecretSyncOptions`, and reads key PRESENCE as intent. Plain
 * `formData.env` / `formData.headers` configure the in-memory connection only,
 * so a producer holding real secrets (a JSON import, a bundle install) must
 * present them as a `secretPatch`. Getting that wrong is invisible at connect
 * time and only surfaces as a 401 after a reload — which is why the rule is
 * pinned here rather than left to an integration test.
 */
import { describe, expect, it } from "vitest";

import { buildSecretSyncOptions } from "../use-server-state";
import type { ServerFormData } from "@/shared/types.js";

const base: ServerFormData = {
  name: "srv",
  type: "http",
  url: "https://example.com/mcp",
};

describe("buildSecretSyncOptions", () => {
  it("forwards an explicit header patch", () => {
    expect(
      buildSecretSyncOptions({
        ...base,
        secretPatch: { headers: { Authorization: "Bearer secret" } },
      }).headers,
    ).toEqual({ Authorization: "Bearer secret" });
  });

  it("forwards an explicit env patch", () => {
    expect(
      buildSecretSyncOptions({
        ...base,
        type: "stdio",
        command: "node",
        secretPatch: { env: { API_TOKEN: "token" } },
      }).env,
    ).toEqual({ API_TOKEN: "token" });
  });

  it("forwards an explicit CLEAR, which is not the same as absence", () => {
    const cleared = buildSecretSyncOptions({
      ...base,
      secretPatch: { headers: {}, env: {} },
    });
    expect(cleared).toHaveProperty("headers", {});
    expect(cleared).toHaveProperty("env", {});
  });

  it("omits the keys entirely with no patch, leaving stored secrets alone", () => {
    // The plain fields are deliberately NOT a fallback: an edit form that never
    // opened the secrets section carries values it must not write back.
    const options = buildSecretSyncOptions({
      ...base,
      headers: { Authorization: "Bearer from-form" },
      env: { API_TOKEN: "from-form" },
    });
    expect(options).not.toHaveProperty("headers");
    expect(options).not.toHaveProperty("env");
  });

  it("carries what an import stamped, on both channels", () => {
    // The persistence end of the chain the JSON import depends on: whatever the
    // importer marks here is what actually gets written.
    const imported = buildSecretSyncOptions({
      ...base,
      headers: { Authorization: "Bearer imported" },
      env: { API_TOKEN: "imported" },
      secretPatch: {
        headers: { Authorization: "Bearer imported" },
        env: { API_TOKEN: "imported" },
      },
    });
    expect(imported.headers).toEqual({ Authorization: "Bearer imported" });
    expect(imported.env).toEqual({ API_TOKEN: "imported" });
  });

  it("keeps the OAuth client-secret operations independent of the patch", () => {
    expect(
      buildSecretSyncOptions({ ...base, clientSecret: "shh" }).clientSecret,
    ).toBe("shh");
    expect(
      buildSecretSyncOptions({ ...base, clearClientSecret: true })
        .clearClientSecret,
    ).toBe(true);
    expect(
      buildSecretSyncOptions({ ...base, clearXaaConfig: true }).clearXaaConfig,
    ).toBe(true);
  });
});
