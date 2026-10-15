import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { sentryInjectedDebugId } from "../../sdk/src/internal/sentry-protocol";

/**
 * The source catalogs the client imports are build outputs. A build writes
 * them before Rollup resolves those imports; the dev server writes them before
 * its first request and keeps a watcher running, so a source edit updates the
 * JSON and Vite reloads its importers.
 */
export function telemetrySourceCatalogsPlugin(): Plugin {
  // Resolved here, not at import: Vite configs load with a file URL, while the
  // client test project imports this module under jsdom, where it is not one.
  const GENERATOR = fileURLToPath(new URL("../../scripts/generate-telemetry-catalogs.mjs", import.meta.url));
  let watcher: ChildProcess | undefined;
  const generate = () => execFileSync(process.execPath, [GENERATOR], { stdio: "inherit" });
  const stop = () => {
    if (watcher?.exitCode === null) watcher.kill();
  };
  return {
    name: "telemetry-source-catalogs",
    configureServer(server) {
      generate();
      // A second watcher for the same checkout (from `npm run dev`) exits at once.
      watcher = spawn(process.execPath, [GENERATOR, "--watch"], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      server.httpServer?.once("close", stop);
      process.once("exit", stop);
    },
    buildStart() {
      if (!watcher) generate();
    },
  };
}

/** Only exact emitted app files can appear in outgoing frame locations. */
export function telemetryCatalogPlugin(): Plugin {
  return {
    name: "telemetry-build-files",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).filter((entry) => entry.type === "chunk").map((entry) => entry.fileName).sort();
      const debugIds = Object.fromEntries(Object.values(bundle).flatMap((entry) => {
        const id = entry.type === "chunk" ? sentryInjectedDebugId(entry.code) : undefined;
        return id ? [[entry.fileName, id]] : [];
      }));
      const data = JSON.stringify({ files, debugIds }).replace(/</g, "\\u003c");
      const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
      const fileName = `assets/telemetry-files-${hash}.js`;
      this.emitFile({ type: "asset", fileName, source: `(()=>{const d=${data};Object.defineProperty(globalThis,"__MCPJAM_TELEMETRY_FILES__",{value:Object.freeze(d.files)});Object.defineProperty(globalThis,"__MCPJAM_TELEMETRY_DEBUG_IDS__",{value:Object.freeze(d.debugIds)})})()` });
      for (const entry of Object.values(bundle)) {
        if (entry.type === "asset" && entry.fileName.endsWith(".html") && typeof entry.source === "string")
          entry.source = entry.source.replace("</head>", `<script src="/${fileName}"></script></head>`);
      }
    },
  };
}
