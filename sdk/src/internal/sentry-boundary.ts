import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import catalog from "./telemetry-catalog.generated.json" with { type: "json" };
import {
  telemetryRecord,
  withSentryBoundary,
  type SentryDropCounter,
  type SentryBoundaryOptions,
} from "./telemetry.js";
import { sentryInjectedDebugId } from "./sentry-protocol.js";

export function sdkTelemetryDisabled(): boolean {
  return [process.env.DO_NOT_TRACK, process.env.MCPJAM_TELEMETRY_DISABLED].some(
    (value) => value === "1" || value === "true"
  );
}

export function sdkSentryEntryKind(
  modulePath: string
): "source" | "package" | undefined {
  const normalized = modulePath.replaceAll("\\", "/");
  return normalized.endsWith("/internal/sentry-boundary.ts")
    ? "source"
    : sdkPackageEntry(modulePath)
      ? "package"
      : undefined;
}

function sdkPackageEntry(modulePath: string): string | undefined {
  const normalized = modulePath.replaceAll("\\", "/");
  return catalog.files.find(
    (file) => file.startsWith("dist/") && normalized.endsWith(`/${file}`)
  );
}

function sdkFrameDebugIds(root: string): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const file of catalog.files.filter((file) => file.startsWith("dist/"))) {
    try {
      const id = sentryInjectedDebugId(
        readFileSync(resolve(root, file), "utf8")
      );
      if (id) ids[file] = id;
    } catch {
      /* Packages without injected maps still retain file/line diagnostics. */
    }
  }
  return ids;
}

interface BoundaryTransport {
  send(envelope: never): PromiseLike<unknown>;
  flush(timeout?: number): PromiseLike<boolean>;
}

export function sdkDiagnosticBoundary(release: string) {
  let modulePath = "";
  try {
    if (import.meta.url) modulePath = fileURLToPath(import.meta.url);
  } catch {
    // Unknown bundle locations have no trusted frame aliases.
    modulePath = "";
  }
  const kind = sdkSentryEntryKind(modulePath);
  const packageEntry = sdkPackageEntry(modulePath);
  const root = packageEntry
    ? resolve(modulePath, ...packageEntry.split("/").map(() => ".."))
    : resolve(dirname(modulePath), "../..");
  // Only the SDK's source module or fixed package entries own these aliases.
  // A customer bundler substitutes its own import.meta.url and must not inherit them.
  let owned = false;
  if (kind) {
    try {
      const pkg = telemetryRecord(
        JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
      );
      owned = pkg.name === "@mcpjam/sdk";
    } catch {
      // Missing package provenance drops frames; diagnostics still use finite error classes.
      owned = false;
    }
  }
  const frameAliases = owned
    ? Object.fromEntries(
        catalog.files.flatMap((file) => [
          [resolve(root, file), file],
          [pathToFileURL(resolve(root, file)).href, file],
        ])
      )
    : {};
  const options: SentryBoundaryOptions = {
    ...catalog,
    files: owned ? catalog.files : [],
    frameAliases,
    frameDebugIds: owned && kind === "package" ? sdkFrameDebugIds(root) : {},
    release,
    platform: "node",
  };
  return <T extends BoundaryTransport>(
    transport: T,
    onDrop?: SentryDropCounter
  ) =>
    withSentryBoundary(transport, () => options, sdkTelemetryDisabled, onDrop);
}
