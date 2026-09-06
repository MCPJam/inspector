/**
 * Rung 1: the declared config — `mcpjam.yaml` at the root of the PR checkout.
 *
 * This rung is AUTHORITATIVE (see types.ts): the repo author wrote the file,
 * so a present-but-invalid file fails resolution honestly instead of falling
 * through to heuristics that would run something the author never declared.
 *
 * Trust model: the input is UNTRUSTED text from a PR checkout. The worker
 * reads it out of the sandbox with an in-sandbox byte cap; this module adds
 * its own defensive length cap and never copies file content into `evidence`
 * (evidence flows into check summaries). Offending KEY NAMES do appear in
 * error messages — that is deliberate, the author needs to see their typo —
 * but they are length-clamped so a hostile file can't smuggle a novel into
 * the check output.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { CheckRecipe } from "../recipes";
import { RecipeResolutionError, type ResolvedRecipe } from "./types";

/**
 * Defensive cap in BYTES (the real byte cap is enforced in-sandbox by the
 * reader). Measured as UTF-8 bytes, not `String.length` — code units undercount
 * multi-byte text, so a length check would admit inputs larger than the
 * in-sandbox cap this bound is meant to mirror.
 */
export const MCPJAM_YAML_MAX_BYTES = 32 * 1024;

/** Keys the v1 `checks:` section understands. Anything else is a typo. */
const CHECKS_KEYS = new Set([
  "transport",
  "build",
  "start",
  "port",
  "path",
  "env",
]);

/**
 * Bounds on `checks.env`, MIRRORED FROM THE BACKEND (`github/recipeCache.ts`).
 *
 * They are duplicated rather than imported because the two live in different
 * deployments, and the duplication is deliberate in one direction: the backend
 * rejects an out-of-bounds `env` at the plan route, but it does so with a 400
 * about a `recipe.env` the author never wrote — pointing at a plan payload
 * rather than at the file. So the parser fails FIRST, at the field, in the
 * file's own vocabulary. If the two ever drift, the resolver tests are where
 * that surfaces.
 *
 * The key shape is the shape POSIX environment variables actually take; a key
 * that cannot be exported has no business travelling as far as a plan row.
 */
export const MCPJAM_ENV_MAX_KEYS = 20;
export const MCPJAM_ENV_KEY_MAX_CHARS = 64;
export const MCPJAM_ENV_VALUE_MAX_CHARS = 1_024;
const MCPJAM_ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// Messages name the requirement only — the formatter below prepends the
// `checks.<field>:` path, so embedding it here too would double it.
const checksSchema = z.object({
  transport: z.literal("streamable-http").optional(),
  build: z.string().min(1, "must be a non-empty command string"),
  start: z.string().min(1, "must be a non-empty command string"),
  port: z
    .number()
    .int("must be an integer")
    .min(1, "must be between 1 and 65535")
    .max(65535, "must be between 1 and 65535"),
  path: z.string().refine((p) => p.startsWith("/"), "must start with '/'"),
});

function invalid(message: string, detailsMarkdown?: string): never {
  throw new RecipeResolutionError(
    "invalid_mcpjam_yaml",
    `mcpjam.yaml: ${message}`,
    detailsMarkdown,
  );
}

/**
 * Clamp untrusted key names / scalar echoes before they reach an error message.
 *
 * Three hazards, all real for author-controlled text landing in check-run
 * markdown: unbounded length, backticks (a run of them can close the fenced
 * detail block and inject markdown into OUR message), and newlines (which let
 * a value fake its own error lines). `String(value)` is also unsafe on its own:
 * a cyclic YAML alias (`version: &v {self: *v}`) survives parsing as a cyclic
 * object, and stringifying one via JSON throws — so callers pass the VALUE and
 * the serialization happens here, guarded.
 */
function clampForError(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  } catch {
    // Cyclic or otherwise unserializable — describe, never echo.
    text = "[unserializable value]";
  }
  return text.replace(/`/g, "'").replace(/[\r\n]+/g, " ").slice(0, 80);
}

/**
 * Parse `checks.env` — the DECLARED ENVIRONMENT CHANNEL.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THESE ARE NON-SECRET CONFIGURATION LITERALS. NEVER PUT A CREDENTIAL HERE.
 *
 * The map comes out of a file COMMITTED to the repository — readable by anyone
 * who can read the repo, including every fork and every pull request author —
 * and it is persisted VERBATIM in the backend's durable plan rows. Nothing
 * redacts it, nothing expires it, and nothing scopes it to one check. It is for
 * the flags a server needs in order to boot (`LOG_LEVEL`, `FIXTURE_MODE`), and
 * for nothing that would matter if it were printed in public.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Returns `undefined` for both an absent map and an EMPTY one. `env: {}` and no
 * `env:` at all describe the same server, so they get the same wire shape —
 * otherwise an empty object would travel to the backend, join the plan row, and
 * become part of a candidate's identity there, making two identical recipes
 * look like two different ones.
 *
 * Everything out of bounds is REJECTED, never truncated or coerced: a shortened
 * value, or a `8080` quietly read as `"8080"`, is a different configuration from
 * the one the author committed, and starting a server with it would report a
 * verdict about something nobody wrote.
 */
function parseChecksEnv(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid("checks.env: must be a mapping of NAME: value pairs");
  }

  const source = raw as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length === 0) return undefined;
  if (keys.length > MCPJAM_ENV_MAX_KEYS) {
    // The COUNT, not the keys: naming twenty-one of them would be a wall of
    // author-controlled text in a check summary to say one number.
    invalid(
      `checks.env: has ${keys.length} entries; at most ${MCPJAM_ENV_MAX_KEYS} are allowed`,
    );
  }

  // Built fresh, own validated keys only, so nothing the YAML node carries —
  // prototype included — travels on with the recipe.
  const env: Record<string, string> = {};
  for (const key of keys) {
    // Keys are echoed (the author needs to see which one is wrong) and clamped
    // for exactly the reasons `clampForError` exists. VALUES ARE NEVER ECHOED:
    // they are the payload, and a check summary is a public page.
    const named = clampForError(key);
    if (key.length > MCPJAM_ENV_KEY_MAX_CHARS) {
      invalid(
        `checks.env.${named}: name exceeds ${MCPJAM_ENV_KEY_MAX_CHARS} characters (${key.length})`,
      );
    }
    if (!MCPJAM_ENV_KEY_PATTERN.test(key)) {
      invalid(
        `checks.env.${named}: name must match ${String(MCPJAM_ENV_KEY_PATTERN)} ` +
          "(an uppercase environment variable name)",
      );
    }
    const value = source[key];
    if (typeof value !== "string") {
      invalid(
        `checks.env.${named}: must be a string — quote it if it is a number, ` +
          "a boolean, or empty",
      );
    }
    if (value.length > MCPJAM_ENV_VALUE_MAX_CHARS) {
      invalid(
        `checks.env.${named}: exceeds ${MCPJAM_ENV_VALUE_MAX_CHARS} characters (${value.length})`,
      );
    }
    env[key] = value;
  }

  return env;
}

/**
 * Parse the contents of `mcpjam.yaml` into a recipe.
 *
 * - `raw === null` means the file does not exist: the rung is inapplicable
 *   and the ladder moves on — returns null, never an error.
 * - Any present-but-invalid file throws `RecipeResolutionError` (authoritative
 *   rung, no fall-through).
 *
 * Unknown TOP-LEVEL keys are ignored (the file will grow sections beyond
 * `checks:`; old workers must not reject new files). Unknown keys INSIDE
 * `checks:` are rejected — inside the authoritative section a stray key is a
 * typo that would otherwise silently change what runs.
 */
export function parseMcpjamYaml(raw: string | null): ResolvedRecipe | null {
  if (raw === null) return null;

  if (Buffer.byteLength(raw, "utf8") > MCPJAM_YAML_MAX_BYTES) {
    invalid(
      `file exceeds the ${MCPJAM_YAML_MAX_BYTES / 1024}KB limit for declared config`,
    );
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    invalid(
      "not valid YAML",
      `\`\`\`\n${clampForError(err instanceof Error ? err.message : err)}\n\`\`\``,
    );
  }

  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    invalid("top level must be a mapping (key: value pairs)");
  }
  const root = doc as Record<string, unknown>;

  if (root.version !== 1) {
    invalid(
      root.version === undefined
        ? "missing required `version` field (expected `version: 1`)"
        : `unsupported version ${clampForError(root.version)} (this worker understands version 1)`,
    );
  }

  const checks = root.checks;
  if (typeof checks !== "object" || checks === null || Array.isArray(checks)) {
    invalid("missing or invalid `checks` section (must be a mapping)");
  }
  const checksRecord = checks as Record<string, unknown>;

  const unknownKeys = Object.keys(checksRecord).filter(
    (key) => !CHECKS_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    invalid(
      `unknown key(s) under \`checks:\`: ${unknownKeys
        .map((k) => clampForError(k))
        .join(", ")}`,
    );
  }

  // `transport` gets its own message before zod: the literal-mismatch default
  // ("expected streamable-http") doesn't explain WHY, and "why" is the useful
  // part — v1 declared config is HTTP-only.
  if (
    checksRecord.transport !== undefined &&
    checksRecord.transport !== "streamable-http"
  ) {
    invalid(
      `checks.transport ${clampForError(checksRecord.transport)} is not supported: ` +
        "version 1 of mcpjam.yaml is HTTP-only (`transport: streamable-http`, which is also the default)",
    );
  }

  const parsed = checksSchema.safeParse(checksRecord);
  if (!parsed.success) {
    invalid(
      parsed.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `checks.${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; "),
    );
  }

  // Parsed from the RAW section, not from `parsed.data`: the zod schema above
  // describes the executable fields, and adding a record to it would express the
  // shape without any of the bounds. Validated after it, so a file missing
  // `build` is told about `build` rather than about an environment typo.
  const env = parseChecksEnv(checksRecord.env);

  const recipe: CheckRecipe = {
    build: parsed.data.build,
    start: parsed.data.start,
    port: parsed.data.port,
    mcpPath: parsed.data.path,
    // Spread so an absent environment leaves NO `env` key at all — `env:
    // undefined` is a property, and it would survive into the plan payload as
    // one. See `parseChecksEnv` for why empty and absent are the same thing.
    ...(env ? { env } : {}),
  };

  return {
    ...recipe,
    rung: "declared",
    // AUTHORITATIVE rung: the repo author declared this start command, so a
    // wrong one is attributable to them and not a silent false green from our
    // guessing. See `OwnershipProof` in ./types.ts.
    ownershipProof: "verified",
    // Constant string on purpose: evidence must never carry file content.
    evidence: ["mcpjam.yaml at repo root (version 1)"],
  };
}
