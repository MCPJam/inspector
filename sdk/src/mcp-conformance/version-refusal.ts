/**
 * A pinned protocol run whose connection the server refused because it does
 * not speak the pinned version.
 *
 * The server is allowed to do that ("If the server supports the requested
 * protocol version, it MUST respond with the same version. Otherwise, the
 * server MUST respond with another protocol version it supports"), so nothing
 * here is its fault, and nothing can be tested on the pinned version. Every
 * selected check, client or raw, could not run, with one message.
 */

import { needsSetupDetails } from "../conformance-input.js";
import { PROTOCOL_CHECK_CATALOG } from "../conformance-catalog.js";
import { ProtocolVersionPinUnsupported } from "../mcp-client-manager/managed-mcp-client.js";
import { isKnownProtocolVersion } from "../mcp-client-manager/mcp-protocol-version.js";
import {
  couldNotRunResult,
  eraSkipMessage,
  notApplicableResult,
} from "./checks/helpers.js";
import { MCP_ERROR_CODES } from "../mcp-client-manager/mcp-error-codes.js";
import {
  jsonRpcError,
  type JsonRpcErrorShape,
  type RawHttpResult,
} from "./raw-http.js";
import { CHECK_ERAS } from "./types.js";
import type {
  MCPCheckCategory,
  MCPCheckId,
  MCPCheckResult,
  MCPClientCheckDefinition,
  NormalizedMCPConformanceConfig,
} from "./types.js";

/** The pin refusal behind a failed connect, however deep it was wrapped. */
function findPinRefusal(
  error: unknown
): ProtocolVersionPinUnsupported | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof ProtocolVersionPinUnsupported) return current;
    current =
      typeof current === "object" && "cause" in current
        ? current.cause
        : undefined;
  }
  return undefined;
}

/**
 * Why the run stopped, and whether the caller can fix it by picking another
 * version. They can when the server offered one MCPJam speaks, or offered
 * nothing at all (another version may still work). They cannot when every
 * version it offered is one MCPJam does not speak: no choice of pin gets
 * around that, so it is not a setup gap.
 */
export function describePinRefusal(
  pinned: string,
  offered: readonly string[]
): {
  message: string;
  setupGap: boolean;
} {
  const known = offered.filter(isKnownProtocolVersion);
  const stopped = `The server does not support protocol version ${pinned}, which this run uses, so nothing could be checked on it.`;
  if (known.length === 1) {
    return {
      message: `${stopped} Run it on ${known[0]} instead.`,
      setupGap: true,
    };
  }
  if (known.length > 1) {
    return {
      message: `${stopped} Run it on one of ${known.join(", ")} instead.`,
      setupGap: true,
    };
  }
  if (offered.length === 0) {
    return {
      message: `${stopped} Run it on a version the server supports instead.`,
      setupGap: true,
    };
  }
  return {
    message: `${stopped} It offers only ${offered.join(", ")}, which MCPJam does not support.`,
    setupGap: false,
  };
}

/**
 * One result per selected check when `error` is a pinned run's version
 * refusal, otherwise undefined. A setup gap costs no points and keeps the
 * run incomplete, like a missing login. Checks the pinned era rules out stay
 * not-applicable, as on any run, except that when NO selected check applies,
 * the first one carries the refusal: a run that tested nothing must never
 * read as passed.
 */
export function pinRefusalChecks(
  error: unknown,
  options: PinRefusalOptions
): MCPCheckResult[] | undefined {
  // Only a pinned run: an Auto run negotiates instead of being refused.
  const refusal =
    options.config.protocolVersion !== undefined
      ? findPinRefusal(error)
      : undefined;
  if (!refusal) return undefined;
  return pinRefusalResults(
    {
      pinned: refusal.protocolVersion,
      offered: refusal.supportedVersions,
    },
    options
  );
}

interface PinRefusalOptions {
  config: NormalizedMCPConformanceConfig;
  selectedCheckIds: ReadonlySet<MCPCheckId>;
  selectedClientChecks: readonly MCPClientCheckDefinition[];
  categoryOf: (id: MCPCheckId) => MCPCheckCategory;
}

/**
 * The results for a refused pin, however the refusal was seen: the client's
 * connect, or the raw `server/discover` gate below. `extraDetails` carries
 * what the refusing answer said, when there was one to quote.
 */
export function pinRefusalResults(
  refusal: {
    pinned: string;
    offered: readonly string[];
    extraDetails?: Record<string, unknown>;
  },
  options: PinRefusalOptions
): MCPCheckResult[] {
  const { config, selectedClientChecks } = options;
  const { message, setupGap } = describePinRefusal(
    refusal.pinned,
    refusal.offered
  );
  const details = {
    ...refusal.extraDetails,
    requestedProtocolVersion: refusal.pinned,
    offeredProtocolVersions: [...refusal.offered],
    ...(setupGap ? needsSetupDetails("protocolVersion", message) : {}),
  };
  const ids = [...options.selectedCheckIds];
  const applies = (id: MCPCheckId) => CHECK_ERAS[id].includes(config.era);
  const anchor = ids.some(applies) ? undefined : ids[0];

  return ids.map((id) => {
    const metadata = selectedClientChecks.find((check) => check.id === id) ?? {
      id,
      category: options.categoryOf(id),
      ...PROTOCOL_CHECK_CATALOG[id],
    };
    return applies(id) || id === anchor
      ? couldNotRunResult(metadata, message, details)
      : notApplicableResult(
          metadata,
          eraSkipMessage(config.era, config.protocolVersion)
        );
  });
}

/**
 * Whether a `server/discover` answer refuses a 2026-era pin. The runner sends
 * that request once before the raw checks of a raw-only 2026 pin.
 *
 * A pinned run with no client check skips the client connect, and 2026 has no
 * handshake, so nothing else would see the refusal: every raw probe would draw
 * it and grade it as the server's answer to that probe. Two answers mean the
 * server does not speak the pin:
 *
 *   - `-32022`, the 2026 refusal, on any status, with the server's own
 *     `supported` list ("it MUST respond with an UnsupportedProtocolVersionError
 *     listing the versions it does support").
 *   - `400 Bad Request` carrying `-32000`, a code in the range 2026 keeps for
 *     "legacy" use: a 2025 server refusing the request. "If the body is empty
 *     or is not a recognized modern JSON-RPC error, fall back to `initialize`",
 *     i.e. the server speaks a 2025 version, not the pin.
 *
 * Anything else is left to the checks to grade: Server Discover grades this
 * same answer rather than sending its own.
 */
export function modernPinRefusal(
  result: RawHttpResult
): { offered: string[]; status: number; error: JsonRpcErrorShape } | undefined {
  const error = jsonRpcError(result);
  if (error === undefined) return undefined;
  if (error.code === MCP_ERROR_CODES.UnsupportedProtocolVersion) {
    const supported = (error.data as { supported?: unknown } | undefined)
      ?.supported;
    return {
      offered: Array.isArray(supported)
        ? supported.filter(
            (version): version is string => typeof version === "string"
          )
        : [],
      status: result.status,
      error,
    };
  }
  if (result.status === 400 && error.code === -32000) {
    return {
      offered: legacyOfferedVersions(error.message),
      status: result.status,
      error,
    };
  }
  return undefined;
}

/**
 * The versions a 2025 server's `-32000` names, when it names them. The
 * TypeScript SDK's server says "Unsupported protocol version: X (supported
 * versions: A, B)". Other wording yields none, and the message then asks for
 * "a version the server supports" rather than guessing.
 */
function legacyOfferedVersions(message: string): string[] {
  const listed = /supported versions:\s*([^)]*)/i.exec(message)?.[1];
  return listed?.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
}
