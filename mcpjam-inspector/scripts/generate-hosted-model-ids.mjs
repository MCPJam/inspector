#!/usr/bin/env node
// Regenerate shared/hosted-model-ids.generated.ts from the backend's public,
// keyless model catalog (`GET <base>/v1/models`). The snapshot is the
// offline/cold-start FLOOR for hosted-model classification (server billing
// catalog seed + client picker fallback); the live catalog fetch is the
// authoritative source at runtime. Run this after the backend deploys a
// widened catalog so the floor stays reasonably current.
//
// Usage:
//   node scripts/generate-hosted-model-ids.mjs                 # prod default
//   MCPJAM_MODELS_URL=https://<deployment>.convex.site/v1/models node scripts/...
//
// It intentionally does NOT run in CI/build — regeneration is a deliberate,
// reviewed step (the diff is the audit trail).

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(
  __dirname,
  "..",
  "shared",
  "hosted-model-ids.generated.ts"
);

const DEFAULT_URL = "https://api.mcpjam.com/v1/models";
const MODELS_URL = process.env.MCPJAM_MODELS_URL || DEFAULT_URL;

// A plausible catalog carries far more than this; a smaller payload is a
// broken/partial response we must not bake into the snapshot.
const MIN_PLAUSIBLE_MODELS = 50;

async function main() {
  console.error(`[generate-hosted-model-ids] fetching ${MODELS_URL}`);
  const response = await fetch(MODELS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Catalog fetch failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  // Public `/v1/models` returns a `{ items }` page.
  const items = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.data)
    ? payload.data
    : null;
  if (!items) {
    throw new Error(
      "Unexpected catalog shape: expected { items: [...] } or { data: [...] }"
    );
  }

  const ids = Array.from(
    new Set(
      items
        .map((m) => (typeof m?.id === "string" ? m.id : null))
        .filter((id) => id !== null)
    )
  ).sort((a, b) => a.localeCompare(b));

  if (ids.length < MIN_PLAUSIBLE_MODELS) {
    throw new Error(
      `Refusing to write an implausibly small snapshot (${ids.length} ids). ` +
        `Is ${MODELS_URL} the widened catalog?`
    );
  }

  const body = `// AUTO-GENERATED — do not edit by hand.
//
// The canonical ids of every MCPJam-hosted model, emitted by
// scripts/generate-hosted-model-ids.mjs from the backend's public catalog
// (\`GET /v1/models\`). This snapshot is the offline/cold-start FLOOR for the
// server billing catalog cache and the client picker fallback, so a cold
// start during a backend-catalog outage still classifies hosted models as
// source:"mcpjam" instead of silently mis-billing as BYOK. The live catalog
// fetch is authoritative at runtime; regenerate this after a backend deploy
// widens the catalog.

export const HOSTED_MODEL_IDS = [
${ids.map((id) => `  ${JSON.stringify(id)},`).join("\n")}
] as const;
`;

  await writeFile(OUTPUT_PATH, body, "utf8");
  console.error(
    `[generate-hosted-model-ids] wrote ${ids.length} ids to ${OUTPUT_PATH}`
  );
}

main()
  .then(() => {
    // Explicit exit: fetch's keep-alive agent can otherwise hold the event
    // loop open, hanging the script after it has finished its work.
    process.exit(0);
  })
  .catch((error) => {
    console.error("[generate-hosted-model-ids] failed:", error.message);
    process.exit(1);
  });
