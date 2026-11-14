import type { McpProtocolVersion } from "@mcpjam/sdk/browser";

export type ConformanceProtocolSelection = McpProtocolVersion | "auto";

export interface ProtocolVersionRefusal {
  protocolVersion: string;
  supportedVersions: string[];
}

export type ConformanceConnectionResult =
  | { status: "ready"; protocolVersion: McpProtocolVersion }
  | ({ status: "unsupported" } & ProtocolVersionRefusal)
  | { status: "auth-required" | "failed"; message: string };

const VERSION = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function versions(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .slice(0, 8)
        .filter(
          (item): item is string =>
            typeof item === "string" && VERSION.test(item),
        )
    : [];
}

/** Read only explicit version refusals, including JSON-safe saved errors. */
export function readProtocolVersionRefusal(
  error: unknown,
  requestedVersion?: string,
): ProtocolVersionRefusal | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 16) {
    const value = pending.shift();
    if (seen.has(value)) continue;
    seen.add(value);
    const message =
      typeof value === "string"
        ? value
        : isRecord(value)
          ? value.message
          : undefined;
    if (isRecord(value)) {
      const pin =
        value.name === "ProtocolVersionPinUnsupported"
          ? value.protocolVersion
          : value.name === "UnsupportedProtocolVersionError"
            ? value.requested
            : undefined;
      if (
        typeof pin === "string" &&
        VERSION.test(pin) &&
        (!requestedVersion || pin === requestedVersion)
      ) {
        return {
          protocolVersion: pin,
          supportedVersions: versions(
            value.supportedVersions ?? value.supported,
          ),
        };
      }
      pending.push(value.cause, value.errorDetails, value.details);
    }
    if (typeof message !== "string") continue;
    const pinned =
      /doesn't support MCP protocol version (\d{4}-\d{2}-\d{2})(?:, which this client is pinned to|\.)/i.exec(
        message,
      );
    if (pinned && (!requestedVersion || pinned[1] === requestedVersion)) {
      return {
        protocolVersion: pinned[1],
        supportedVersions: versions(
          message
            .match(/(?:It offers|Supported versions:) ([\d, -]+)/i)?.[1]
            .match(/\d{4}-\d{2}-\d{2}/g),
        ),
      };
    }
    // Old OAuth reports kept only this explicit refusal and its alternatives.
    const offered =
      /Unsupported protocol version \(supported versions: ([\d, -]+)\)/i.exec(
        message,
      );
    if (offered && requestedVersion && VERSION.test(requestedVersion)) {
      const supportedVersions = versions(
        offered[1].match(/\d{4}-\d{2}-\d{2}/g),
      );
      if (
        supportedVersions.length &&
        !supportedVersions.includes(requestedVersion)
      ) {
        return { protocolVersion: requestedVersion, supportedVersions };
      }
    }
  }
  return undefined;
}
