import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { TelemetryCatalog } from "./telemetry.js";
import { telemetryRecord } from "./telemetry.js";

/** A manifest is valid only for the exact bytes of the executing SDK bundle. */
export function packagedTelemetryCatalog(moduleUrl: string): TelemetryCatalog {
  try {
    const manifest = telemetryRecord(
      JSON.parse(
        readFileSync(
          new URL("./telemetry-frames.generated.json", moduleUrl),
          "utf8"
        )
      )
    );
    if (
      manifest.version !== 1 ||
      manifest.bundle !== "dist/index.js" ||
      manifest.sha256 !==
        createHash("sha256")
          .update(readFileSync(new URL(moduleUrl)))
          .digest("hex") ||
      !Array.isArray(manifest.functions) ||
      manifest.functions.length > 100000 ||
      !manifest.functions.every(
        (name) =>
          typeof name === "string" &&
          name.length < 300 &&
          /^(?:new )?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?$/.test(name)
      )
    )
      return {};
    return { frames: { "dist/index.js": manifest.functions } };
  } catch {
    // Source execution, stale manifests and repackaged clients retain only the source catalog.
    return {};
  }
}
