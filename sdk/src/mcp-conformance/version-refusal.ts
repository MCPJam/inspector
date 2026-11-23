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
function describeRefusal(refusal: ProtocolVersionPinUnsupported): {
  message: string;
  setupGap: boolean;
} {
  const pinned = refusal.protocolVersion;
  const offered = refusal.supportedVersions;
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
  options: {
    config: NormalizedMCPConformanceConfig;
    selectedCheckIds: ReadonlySet<MCPCheckId>;
    selectedClientChecks: readonly MCPClientCheckDefinition[];
    categoryOf: (id: MCPCheckId) => MCPCheckCategory;
  }
): MCPCheckResult[] | undefined {
  const { config, selectedClientChecks } = options;
  // Only a pinned run: an Auto run negotiates instead of being refused.
  const refusal =
    config.protocolVersion !== undefined ? findPinRefusal(error) : undefined;
  if (!refusal) return undefined;
  const { message, setupGap } = describeRefusal(refusal);
  const details = {
    requestedProtocolVersion: refusal.protocolVersion,
    offeredProtocolVersions: [...refusal.supportedVersions],
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
