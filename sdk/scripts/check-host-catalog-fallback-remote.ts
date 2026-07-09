import { BUNDLED_HOST_COMPAT_CATALOG } from "../src/host-compat/catalog.generated.js";
import {
  hydrateHostCompatCatalog,
  type HostCompatCatalog,
} from "../src/host-compat/catalog.js";
import {
  hostCompatCatalogEnvelopeSchema,
  SUPPORTED_CATALOG_SCHEMA_VERSION,
} from "../src/host-compat/catalog-schema.js";

const DEFAULT_CATALOG_URL = "https://staging.mcpjam.com";
const LOCAL_ONLY = process.argv.includes("--local-only");

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function firstDiffPath(a: unknown, b: unknown, path = "$"): string {
  if (Object.is(a, b)) return "";
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  ) {
    return path;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return path;
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
      const diff = firstDiffPath(a[i], b[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return "";
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aRecord), ...Object.keys(bRecord)]);
  for (const key of [...keys].sort()) {
    const diff = firstDiffPath(aRecord[key], bRecord[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return "";
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (canonicalJson(actual) === canonicalJson(expected)) return;
  throw new Error(
    `${label} drifted; first difference at ${firstDiffPath(actual, expected)}.`
  );
}

function catalogUrlFromEnv(): string {
  const raw = process.env.HOST_CATALOG_PARITY_URL ?? DEFAULT_CATALOG_URL;
  const trimmed = raw.replace(/\/+$/, "");
  if (trimmed.endsWith("/host-catalog")) return trimmed;
  if (trimmed.endsWith("/api/v1") || trimmed.endsWith("/public")) {
    return `${trimmed}/host-catalog`;
  }
  return `${trimmed}/api/v1/host-catalog`;
}

function bundledCatalog(): HostCompatCatalog {
  return hydrateHostCompatCatalog(cloneJson(BUNDLED_HOST_COMPAT_CATALOG));
}

async function fetchRemoteCatalog(): Promise<HostCompatCatalog> {
  const url = catalogUrlFromEnv();
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Remote host catalog fetch failed: HTTP ${response.status} (${url}).`
    );
  }

  const body: unknown = await response.json();
  const parsed = hostCompatCatalogEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    const schemaVersion =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as { schemaVersion?: unknown }).schemaVersion
        : undefined;
    throw new Error(
      `Remote host catalog is invalid or unsupported (schemaVersion=${String(
        schemaVersion
      )}, expected=${SUPPORTED_CATALOG_SCHEMA_VERSION}).`
    );
  }

  if (parsed.data.source === "bundled" || parsed.data.version === 0) {
    throw new Error(
      `Remote host catalog is serving bundled fallback (source=${parsed.data.source}, version=${parsed.data.version}).`
    );
  }
  if (!parsed.data.contentHash) {
    throw new Error("Remote host catalog is missing contentHash.");
  }

  return hydrateHostCompatCatalog(parsed.data.catalog);
}

const localCatalog = bundledCatalog();

if (!LOCAL_ONLY) {
  const remoteCatalog = await fetchRemoteCatalog();
  assertEqual(
    "SDK fallback catalog vs remote host catalog",
    localCatalog,
    remoteCatalog
  );
}

console.log(
  LOCAL_ONLY
    ? "SDK host catalog fallback loaded."
    : `SDK host catalog fallback matches ${catalogUrlFromEnv()}.`
);
