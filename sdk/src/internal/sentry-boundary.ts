import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import catalog from "./telemetry-catalog.generated.json" with { type: "json" };
import { telemetryRecord, withSentryBoundary } from "./telemetry.js";

export function sdkTelemetryDisabled(): boolean {
  return [process.env.DO_NOT_TRACK, process.env.MCPJAM_TELEMETRY_DISABLED].some(
    (value) => value === "1" || value === "true"
  );
}

export function sdkDiagnosticBoundary(release: string) {
  let modulePath = "";
  try { if (import.meta.url) modulePath = fileURLToPath(import.meta.url); }
  catch { modulePath = ""; /* Unknown bundle locations have no trusted frame aliases. */ }
  const source = modulePath.endsWith("/internal/sentry-boundary.ts");
  const root = resolve(dirname(modulePath), source ? "../.." : "..");
  // Only the SDK's source module or fixed package entry owns these aliases.
  // A customer bundler substitutes its own import.meta.url and must not inherit them.
  let owned = false;
  if (source || modulePath.endsWith("/dist/index.js")) {
    try {
      const pkg = telemetryRecord(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));
      owned = pkg.name === "@mcpjam/sdk";
    } catch {
      // Missing package provenance drops frames; diagnostics still use finite error classes.
      owned = false;
    }
  }
  const frameAliases = owned ? Object.fromEntries(catalog.files.flatMap((file) => [
    [resolve(root, file), file],
    [new URL(file, `file://${root}/`).href, file],
  ])) : {};
  return <T extends { send(envelope: never): PromiseLike<unknown>; flush(timeout?: number): PromiseLike<boolean> }>(transport: T) =>
    withSentryBoundary(transport, () => ({ ...catalog, files: owned ? catalog.files : [], frameAliases, release }), sdkTelemetryDisabled);
}
