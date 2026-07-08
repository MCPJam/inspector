import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import prettier from "prettier";

type BackendSeedModule = {
  SEED_DOCUMENT: unknown;
};

const CHECK_ONLY = process.argv.includes("--check");

const backendDir =
  process.env.MCPJAM_BACKEND_DIR ??
  path.resolve(process.cwd(), "../../mcpjam-backend");
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

const rawContent = `// Generated SDK fallback snapshot copied from the backend host catalog seed.
// Run \`npm run generate:host-catalog-fallback -w @mcpjam/sdk\` after backend
// host catalog/template changes. Product UI should fetch the live backend
// catalog instead of treating this fallback as canonical.

import type { HostCompatCatalog } from "./catalog.js";

export const BUNDLED_HOST_COMPAT_CATALOG = ${JSON.stringify(
  SEED_DOCUMENT,
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
