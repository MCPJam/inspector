// Maintain and sign the local-harness pack revocation list.
//
//   node scripts/local-harness-revocations.mjs add --harness codex \
//     --digest sha256:… --reason "…" [--file local-harness-revocations/revocations.json]
//   LOCAL_HARNESS_PACK_SIGNING_KEY=… node scripts/local-harness-revocations.mjs sign [--file …]
//   node scripts/local-harness-revocations.mjs verify [--file …]
//
// `add` appends an entry and bumps `sequence` (clients refuse a list older
// than the one they cached, so a sequence never goes backwards). `sign` writes
// `<file>.sig` over the file's exact bytes and verifies it against the public
// key the Inspector carries, so a key mismatch fails here, not on users.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const inspectorRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REVOCATIONS_FILE = join(inspectorRoot, "local-harness-revocations", "revocations.json");
export const REVOCATION_SCHEMA = "mcpjam.local-harness-revocations/1";

/** Validate a parsed list; returns the problems, empty when sound. */
export function revocationListProblems(list) {
  const problems = [];
  if (list?.schema !== REVOCATION_SCHEMA) problems.push(`schema must be ${REVOCATION_SCHEMA}`);
  if (!Number.isSafeInteger(list?.sequence) || list.sequence < 0) problems.push("sequence must be a non-negative integer");
  if (typeof list?.issuedAt !== "string" || Number.isNaN(Date.parse(list.issuedAt))) problems.push("issuedAt must be a timestamp");
  if (!Array.isArray(list?.revoked)) problems.push("revoked must be a list");
  for (const entry of list?.revoked ?? []) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(entry?.harnessId ?? "")) problems.push(`bad harnessId ${JSON.stringify(entry?.harnessId)}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(entry?.treeDigest ?? "")) problems.push(`bad treeDigest ${JSON.stringify(entry?.treeDigest)}`);
    if (typeof entry?.reason !== "string" || entry.reason.trim() === "") problems.push("every entry needs a reason");
  }
  return problems;
}

/** The list with one more revocation: sequence bumped, entry deduplicated. */
export function addRevocation(list, entry, now = new Date()) {
  const revoked = list.revoked.filter((e) => !(e.harnessId === entry.harnessId && e.treeDigest === entry.treeDigest));
  revoked.push({ harnessId: entry.harnessId, treeDigest: entry.treeDigest, reason: entry.reason.trim() });
  return { schema: REVOCATION_SCHEMA, sequence: list.sequence + 1, issuedAt: now.toISOString(), revoked };
}

export const renderRevocationList = (list) => `${JSON.stringify(list, null, 2)}\n`;

function publicKeys() {
  const source = readFileSync(join(inspectorRoot, "server/utils/harness/local/pack-signing-key.ts"), "utf8");
  return [...source.matchAll(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g)].map((m) => m[0]);
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function main(argv) {
  const [command] = argv;
  const file = arg(argv, "file") ?? REVOCATIONS_FILE;
  const list = JSON.parse(readFileSync(file, "utf8"));
  const problems = revocationListProblems(list);
  if (problems.length > 0) throw new Error(`invalid revocation list ${file}: ${problems.join("; ")}`);
  if (command === "add") {
    const entry = { harnessId: arg(argv, "harness") ?? "", treeDigest: arg(argv, "digest") ?? "", reason: arg(argv, "reason") ?? "" };
    const next = addRevocation(list, entry);
    const nextProblems = revocationListProblems(next);
    if (nextProblems.length > 0) throw new Error(nextProblems.join("; "));
    writeFileSync(file, renderRevocationList(next));
    process.stdout.write(`revocation list sequence ${next.sequence}: ${next.revoked.length} revoked\n`);
    return;
  }
  if (command === "sign") {
    const key = process.env.LOCAL_HARNESS_PACK_SIGNING_KEY;
    if (!key) throw new Error("LOCAL_HARNESS_PACK_SIGNING_KEY is required");
    const bytes = readFileSync(file);
    const signature = sign(null, bytes, createPrivateKey(key));
    if (!publicKeys().some((pem) => verify(null, bytes, createPublicKey(pem), signature))) {
      throw new Error("the signing key does not match any key the Inspector carries");
    }
    writeFileSync(`${file}.sig`, `${signature.toString("base64")}\n`);
    process.stdout.write(`signed ${file}\n`);
    return;
  }
  if (command === "verify") {
    const bytes = readFileSync(file);
    const signature = Buffer.from(readFileSync(`${file}.sig`, "utf8").trim(), "base64");
    if (!publicKeys().some((pem) => verify(null, bytes, createPublicKey(pem), signature))) {
      throw new Error(`${file}.sig does not verify`);
    }
    process.stdout.write(`verified ${file} (sequence ${list.sequence})\n`);
    return;
  }
  throw new Error(`unknown command ${command}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
