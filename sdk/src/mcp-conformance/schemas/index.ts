/**
 * VENDORED SPEC SCHEMAS — the JSON Schema documents the wire-schema check
 * validates against.
 *
 * PIN: modelcontextprotocol/modelcontextprotocol @
 * 4e67bdc2f3403a8602f72025b28ac27fe7fd4e44 (`schema/<revision>/schema.json`)
 * PIN: modelcontextprotocol/ext-tasks @
 * e4345978be1f602f1fc48d89051e8559dd5302a6 (`schema/draft/schema.json`)
 *
 * Re-diff against those commits when re-syncing. The files are VERBATIM copies,
 * descriptions and all, precisely so that re-syncing is a plain `diff` against
 * upstream rather than a re-derivation. Pruning them would save bytes and cost
 * the one property that makes a vendored artifact maintainable.
 *
 * WHY VENDOR AT ALL. The schemas are the only machine-readable statement of
 * what a conforming message looks like, and no npm package ships them (the
 * client package ships TypeScript types, which are not a validator and which
 * the client itself relaxes at the decode seam). Fetching them at run time
 * would make a conformance verdict depend on a network round trip to a third
 * party — a run must be reproducible offline and must not change its answer
 * because someone merged a schema PR mid-sweep.
 *
 * DIALECTS ARE NOT UNIFORM: 2025-03-26 and 2025-06-18 are draft-07
 * (`definitions`), 2025-11-25 and 2026-07-28 are 2020-12 (`$defs`). That is why
 * the validator needs both Ajv engines and why the defs pointer is read off
 * each document rather than assumed.
 */

import mcp20250326 from "./mcp-2025-03-26.json" with { type: "json" };
import mcp20250618 from "./mcp-2025-06-18.json" with { type: "json" };
import mcp20251125 from "./mcp-2025-11-25.json" with { type: "json" };
import mcp20260728 from "./mcp-2026-07-28.json" with { type: "json" };
import extTasksDraft from "./ext-tasks-draft.json" with { type: "json" };
import { MCP_TASKS_EXTENSION_ID } from "../../mcp-client-manager/tasks-dispatch.js";
import type { McpProtocolVersion } from "../../mcp-client-manager/mcp-protocol-version.js";

/**
 * A vendored schema document, widened at the import boundary.
 *
 * DELIBERATELY `unknown`-valued: `resolveJsonModule` would otherwise infer the
 * whole 180KB literal as the export's type and inline it into the emitted
 * `.d.ts`. Nothing downstream reads these structurally except the validator,
 * which walks them dynamically anyway.
 */
export interface WireSchemaDocument {
  $schema?: string;
  definitions?: Record<string, unknown>;
  $defs?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Core spec schema per protocol revision. Total over `McpProtocolVersion`. */
export const CORE_WIRE_SCHEMAS: Record<
  McpProtocolVersion,
  WireSchemaDocument
> = {
  "2025-03-26": mcp20250326 as WireSchemaDocument,
  "2025-06-18": mcp20250618 as WireSchemaDocument,
  "2025-11-25": mcp20251125 as WireSchemaDocument,
  "2026-07-28": mcp20260728 as WireSchemaDocument,
};

/**
 * Extension schemas, keyed by the extension id a server declares.
 *
 * Only `io.modelcontextprotocol/tasks` today. Apps is deliberately absent
 * rather than stubbed: composing a schema for an extension whose results we do
 * not yet correlate would add a code path with no assertion behind it.
 */
export const EXTENSION_WIRE_SCHEMAS: Record<string, WireSchemaDocument> = {
  [MCP_TASKS_EXTENSION_ID]: extTasksDraft as WireSchemaDocument,
};

/**
 * The revision directory each extension schema was vendored from, so a profile
 * stamp names what was actually validated against rather than a guess. The
 * tasks extension has published only `schema/draft/` to date; when it cuts a
 * dated revision this becomes that date, and the stamp moves with it.
 */
export const EXTENSION_SCHEMA_REVISIONS: Record<string, string> = {
  [MCP_TASKS_EXTENSION_ID]: "draft",
};

/**
 * Where a document keeps its definitions. draft-07 says `definitions`,
 * 2020-12 says `$defs`; both spellings appear across the four revisions, and
 * a `$ref` built with the wrong one resolves to nothing (which Ajv reports as
 * a compile error, not as a validation failure — i.e. it would break the
 * check, not the server).
 */
export function definitionsPointer(document: WireSchemaDocument): {
  key: "definitions" | "$defs";
  definitions: Record<string, unknown>;
} {
  if (document.$defs) {
    return { key: "$defs", definitions: document.$defs };
  }
  return { key: "definitions", definitions: document.definitions ?? {} };
}
