/**
 * MCP Apps check metadata and the result shapes the runner and the grader
 * share.
 */

import { AUTHORIZATION_REQUIRED_MESSAGE } from "../conformance-authorization.js";
import {
  loginRequiredDetails,
  type ConformanceCredentialSource,
} from "../conformance-login.js";
import {
  blockedByDetails,
  blockedByMessage,
} from "../conformance-blocked.js";
import { deepJsonSafe } from "../json-safe.js";
import type {
  MCPAppsCheckId,
  MCPAppsCheckResult,
  MCPAppsSkipReason,
} from "./types.js";

// `tests/conformance-catalog.test.ts` asserts, through the runner's re-export,
// that the browser-safe catalog still matches these canonical strings.
export const APPS_CHECK_METADATA: Record<
  MCPAppsCheckId,
  Pick<MCPAppsCheckResult, "id" | "category" | "title" | "description">
> = {
  "ui-tools-present": {
    id: "ui-tools-present",
    category: "tools",
    title: "UI Tools Present",
    description:
      "At least one tool advertises MCP Apps UI metadata through _meta.ui.resourceUri or the deprecated ui/resourceUri field.",
  },
  "ui-tool-metadata-valid": {
    id: "ui-tool-metadata-valid",
    category: "tools",
    title: "UI Tool Metadata Valid",
    description:
      "Tools with UI metadata use a ui:// resource URI and valid visibility values.",
  },
  "ui-tool-input-schema-valid": {
    id: "ui-tool-input-schema-valid",
    category: "tools",
    title: "UI Tool Input Schema Valid",
    description:
      "UI tools provide a non-null JSON Schema object as their inputSchema.",
  },
  "ui-listed-resources-valid": {
    id: "ui-listed-resources-valid",
    category: "resources",
    title: "Listed UI Resources Valid",
    description:
      "UI resources returned by resources/list use ui:// URIs and the MCP Apps HTML MIME type.",
  },
  "ui-resources-readable": {
    id: "ui-resources-readable",
    category: "resources",
    title: "UI Resources Readable",
    description:
      "Every UI resource referenced by a tool or listed by the server can be fetched with resources/read.",
  },
  "ui-resource-contents-valid": {
    id: "ui-resource-contents-valid",
    category: "resources",
    title: "UI Resource Contents Valid",
    description:
      "UI resource contents use the MCP Apps HTML MIME type and provide exactly one HTML payload via text or blob.",
  },
  "ui-resource-meta-valid": {
    id: "ui-resource-meta-valid",
    category: "resources",
    title: "UI Resource Metadata Valid",
    description:
      "UI resource metadata uses valid csp, permissions, domain, and prefersBorder shapes.",
  },
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function passedResult(
  id: MCPAppsCheckId,
  durationMs: number,
  details?: Record<string, unknown>,
  warnings?: string[],
): MCPAppsCheckResult {
  return {
    ...APPS_CHECK_METADATA[id],
    status: "passed",
    durationMs,
    ...(details ? { details } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

export function failedResult(
  id: MCPAppsCheckId,
  durationMs: number,
  message: string,
  details?: Record<string, unknown>,
  rawError?: unknown,
  warnings?: string[],
): MCPAppsCheckResult {
  return {
    ...APPS_CHECK_METADATA[id],
    status: "failed",
    durationMs,
    error: {
      message,
      // Raw thrown values are often class instances (e.g. MCPAuthError), and
      // the persistence layer rejects those wholesale — one live instance in
      // `errorDetails` used to destroy the entire finished report at the
      // Convex write. Reports carry plain JSON data only.
      ...(rawError === undefined ? {} : { details: deepJsonSafe(rawError) }),
    },
    ...(details ? { details } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}

export function skippedResult(
  id: MCPAppsCheckId,
  skipReason: MCPAppsSkipReason,
  message: string,
  details?: Record<string, unknown>,
): MCPAppsCheckResult {
  return {
    ...APPS_CHECK_METADATA[id],
    status: "skipped",
    skipReason,
    durationMs: 0,
    error: { message },
    ...(details ? { details } : {}),
  };
}

/** A check that never ran because `blockerId` broke first. */
export function blockedSkip(
  id: MCPAppsCheckId,
  blockerId: MCPAppsCheckId,
): MCPAppsCheckResult {
  return skippedResult(
    id,
    "could-not-run",
    blockedByMessage(APPS_CHECK_METADATA[blockerId].title),
    blockedByDetails(blockerId),
  );
}

/** A check a 401 stopped: the caller's login to fix, at no cost. */
export function loginSkip(
  id: MCPAppsCheckId,
  credentials: ConformanceCredentialSource | undefined,
  error: unknown,
): MCPAppsCheckResult {
  return skippedResult(
    id,
    "could-not-run",
    AUTHORIZATION_REQUIRED_MESSAGE,
    loginRequiredDetails(error, credentials),
  );
}
