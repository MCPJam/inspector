/**
 * MCP Apps OpenAI-compatible runtime bundle-freshness regression test.
 *
 * `src/McpAppsOpenAICompatibleRuntime.bundled.ts` is auto-generated from
 * `src/McpAppsOpenAICompatibleRuntime.ts` by
 * `scripts/bundle-mcp-apps-openai-compatible-runtime.mjs` (esbuild → iife
 * → JSON-stringified into a TS export). If the source `.ts` changes but
 * the bundle isn't regenerated, the runtime injected into every MCP App
 * widget runs stale code — silently. This test fails when drift exists.
 *
 * The test uses a content-hash heuristic rather than re-running esbuild:
 * it scans the .ts source for a set of function-body fingerprints and
 * asserts each appears in the bundled string. New behaviors added to the
 * source must add a fingerprint here too — that's the intended forcing
 * function.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkRoot = path.resolve(__dirname, "..");

const source = fs.readFileSync(
  path.join(sdkRoot, "src/McpAppsOpenAICompatibleRuntime.ts"),
  "utf-8",
);
const bundle = fs.readFileSync(
  path.join(sdkRoot, "src/McpAppsOpenAICompatibleRuntime.bundled.ts"),
  "utf-8",
);

const fingerprints: Array<[string, string]> = [
  ["set_globals dispatch helper", "openai:set_globals"],
  ["tool-input handler", "ui/notifications/tool-input"],
  ["tool-result handler", "ui/notifications/tool-result"],
  ["host-context-changed handler", "ui/notifications/host-context-changed"],
  ["initialize handshake method", "ui/initialize"],
  ["initialized notification", "ui/notifications/initialized"],
  ["upload-file message type", "openai:uploadFile"],
  ["getFileDownloadUrl message type", "openai:getFileDownloadUrl"],
  ["setWidgetState postMessage", "openai:setWidgetState"],
  ["setOpenInAppUrl postMessage", "openai:setOpenInAppUrl"],
  ["toolResponseMetadata config field", "toolResponseMetadata"],
  ["requestCheckout notification", "openai/requestCheckout"],
  ["requestModal notification", "openai/requestModal"],
  ["requestClose notification", "openai/requestClose"],
];

describe("MCP Apps OpenAI-compat runtime bundle freshness", () => {
  for (const [name, needle] of fingerprints) {
    it(`bundle contains: ${name}`, () => {
      // Every fingerprint that's in the source MUST also be in the bundle.
      // If the source has the needle but the bundle does not, the bundle
      // is stale — run `node scripts/bundle-mcp-apps-openai-compatible-runtime.mjs`.
      if (source.includes(needle)) {
        expect(bundle).toContain(needle);
      }
    });
  }
});
