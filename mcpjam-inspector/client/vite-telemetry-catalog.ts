import { createHash } from "node:crypto";
import type { Plugin } from "vite";

/** Only exact emitted app files can appear in outgoing frame locations. */
export function telemetryCatalogPlugin(): Plugin {
  return {
    name: "telemetry-build-files",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).filter((entry) => entry.type === "chunk").map((entry) => entry.fileName).sort();
      const data = JSON.stringify(files).replace(/</g, "\\u003c");
      const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
      const fileName = `assets/telemetry-files-${hash}.js`;
      this.emitFile({ type: "asset", fileName, source: `Object.defineProperty(globalThis,"__MCPJAM_TELEMETRY_FILES__",{value:Object.freeze(${data})})` });
      for (const entry of Object.values(bundle)) {
        if (entry.type === "asset" && entry.fileName.endsWith(".html") && typeof entry.source === "string")
          entry.source = entry.source.replace("</head>", `<script src="/${fileName}"></script></head>`);
      }
    },
  };
}
