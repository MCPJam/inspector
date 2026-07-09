import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import prettier from "prettier";
import { imageSupportToHostConfigFields } from "../src/host-compat/image-support.js";
import type { HostImageSupport } from "../src/host-compat/types.js";

type BackendSeedModule = {
  SEED_DOCUMENT: unknown;
};

type ImageSourceSupport = { model: boolean; ui: boolean };

const CHECK_ONLY = process.argv.includes("--check");

const backendDir = process.env.MCPJAM_BACKEND_DIR;
if (!backendDir) {
  throw new Error(
    "Set MCPJAM_BACKEND_DIR to the mcpjam-backend checkout before generating the SDK host catalog fallback."
  );
}
const backendSeedPath = path.join(
  backendDir,
  "convex/marketHostCatalog/seed.ts"
);
const outputPath = path.resolve(
  process.cwd(),
  "src/host-compat/catalog.generated.ts"
);

const { SEED_DOCUMENT } = (await import(
  pathToFileURL(backendSeedPath).href
)) as BackendSeedModule;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isImageSourceSupport(value: unknown): value is ImageSourceSupport {
  return (
    isRecord(value) &&
    typeof value.model === "boolean" &&
    typeof value.ui === "boolean"
  );
}

function isImagePlacement(
  value: unknown
): value is HostImageSupport["placement"] {
  return value === "none" || value === "collapsed" || value === "inline";
}

function isImageSupport(value: unknown): value is HostImageSupport {
  return (
    isRecord(value) &&
    isImageSourceSupport(value.toolImageContent) &&
    isImageSourceSupport(value.embeddedResourceImages) &&
    isImageSourceSupport(value.resourceLinkImages) &&
    isImagePlacement(value.placement)
  );
}

function hydrateSeedDocument(seed: unknown): unknown {
  if (!isRecord(seed)) {
    throw new Error("Backend seed module must export a catalog object.");
  }
  if (!isRecord(seed.hostsById)) {
    throw new Error(
      "Backend seed catalog is missing hostsById; refusing to generate a partial SDK fallback."
    );
  }
  return {
    ...seed,
    hostsById: Object.fromEntries(
      Object.entries(seed.hostsById).map(([id, host]) => {
        if (!isRecord(host) || !isImageSupport(host.imageSupport)) {
          return [id, host];
        }
        return [
          id,
          { ...host, ...imageSupportToHostConfigFields(host.imageSupport) },
        ];
      })
    ),
  };
}

const hydratedSeedDocument = hydrateSeedDocument(SEED_DOCUMENT);

const rawContent = `// Generated SDK fallback snapshot copied from the backend host catalog seed.
// Run \`MCPJAM_BACKEND_DIR=/path/to/mcpjam-backend npm run generate:host-catalog-fallback -w @mcpjam/sdk\`
// after backend host catalog/template changes. Product UI should fetch the
// live backend catalog instead of treating this fallback as canonical.

import type { HostCompatCatalog } from "./catalog.js";

export const BUNDLED_HOST_COMPAT_CATALOG = ${JSON.stringify(
  hydratedSeedDocument,
  null,
  2
)} satisfies HostCompatCatalog;
`;
const content = await prettier.format(rawContent, { parser: "typescript" });

if (CHECK_ONLY) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== content) {
    throw new Error(
      "SDK host catalog fallback is stale. Run `npm run generate:host-catalog-fallback -w @mcpjam/sdk`."
    );
  }
} else {
  writeFileSync(outputPath, content);
}
