import type { ClientCapabilityOptions } from "./types.js";
import { MCP_SKILLS_EXTENSION_ID } from "./skills-dispatch.js";

export const MCP_UI_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Merges MCP `extensions` maps by extension id so project/server partial
 * configs do not replace the entire `extensions` object (which would drop
 * unrelated extension entries).
 */
function mergeExtensionsMaps(
  base?: Record<string, unknown>,
  override?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  if (!base) {
    return { ...override };
  }
  if (!override) {
    return { ...base };
  }

  const merged: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const b = merged[key];
    const o = override[key];
    if (isPlainObject(b) && isPlainObject(o)) {
      merged[key] = { ...b, ...o };
    } else {
      merged[key] = o;
    }
  }
  return merged;
}

/**
 * The SDK's default advertised capabilities.
 *
 * `io.modelcontextprotocol/skills` is deliberately ABSENT. SEP-2133 makes
 * extension support opt-in, and the SDK on its own has no SEP-2640 fulfiller:
 * the thing that actually loads, verifies, and renders a server-served skill
 * is the inspector app. A default declaration would advertise behavior the
 * bare SDK cannot complete — the advertise=enforce rule read backwards.
 * Callers that DO implement it opt in with
 * {@link withSkillsExtensionCapability}, which is what the inspector's connect
 * seams do (local) and what the MCPJam host persona's stored
 * `clientCapabilities` does (hosted).
 *
 * The backend's `DEFAULT_CLIENT_CAPABILITIES_V2` is the hand-mirror of this
 * function and stays in lockstep with it.
 */
export function getDefaultClientCapabilities(): ClientCapabilityOptions {
  return {
    extensions: {
      [MCP_UI_EXTENSION_ID]: {
        mimeTypes: [MCP_UI_RESOURCE_MIME_TYPE],
      },
    },
  } as ClientCapabilityOptions;
}

/**
 * Merges `io.modelcontextprotocol/skills` (SEP-2640) into a client
 * capabilities object.
 *
 * Same shape and contract as `withXaaExtensionCapability` in the app: merge,
 * never overwrite, and never clobber an existing settings object for the same
 * extension id (a caller that already pinned settings meant them).
 *
 * Applied per connection by a surface that knows a SEP-2640 fulfiller is
 * actually installed. Because the extension is connection-level, this is the
 * ONLY seam skills declaration uses — there is no per-request `_meta`
 * equivalent, which is what makes it simpler than the tasks extension.
 */
export function withSkillsExtensionCapability<
  T extends Record<string, unknown> | undefined,
>(capabilities: T): Record<string, unknown> {
  const existingExtensions = isPlainObject(capabilities?.extensions)
    ? (capabilities.extensions as Record<string, unknown>)
    : {};
  return {
    ...(capabilities ?? {}),
    extensions: {
      ...existingExtensions,
      [MCP_SKILLS_EXTENSION_ID]: isPlainObject(
        existingExtensions[MCP_SKILLS_EXTENSION_ID]
      )
        ? existingExtensions[MCP_SKILLS_EXTENSION_ID]
        : {},
    },
  };
}

export function normalizeClientCapabilities(
  capabilities?: ClientCapabilityOptions
): ClientCapabilityOptions {
  return {
    ...(capabilities ?? {}),
  };
}

/**
 * Adds runtime-gated capabilities that are only valid when the corresponding
 * handlers are actually installed on the client.
 */
export function applyRuntimeClientCapabilities(
  capabilities?: ClientCapabilityOptions,
  runtime?: { elicitation?: boolean }
): ClientCapabilityOptions {
  const resolved = normalizeClientCapabilities(capabilities) as Record<
    string,
    unknown
  >;

  if (runtime?.elicitation && resolved.elicitation == null) {
    resolved.elicitation = {};
  }

  return resolved as ClientCapabilityOptions;
}

export function mergeClientCapabilities(
  base?: ClientCapabilityOptions,
  overrides?: ClientCapabilityOptions
): ClientCapabilityOptions {
  const baseRecord = base as Record<string, unknown> | undefined;
  const overrideRecord = overrides as Record<string, unknown> | undefined;
  const merged: Record<string, unknown> = {
    ...(base ?? {}),
    ...(overrides ?? {}),
  };

  if (
    overrideRecord &&
    Object.prototype.hasOwnProperty.call(overrideRecord, "extensions")
  ) {
    const overExt = overrideRecord.extensions;
    if (overExt === undefined) {
      merged.extensions = baseRecord?.extensions;
    } else if (isPlainObject(overExt)) {
      if (Object.keys(overExt).length === 0) {
        merged.extensions = {};
      } else if (isPlainObject(baseRecord?.extensions)) {
        merged.extensions = mergeExtensionsMaps(
          baseRecord.extensions as Record<string, unknown>,
          overExt
        );
      } else {
        merged.extensions = { ...overExt };
      }
    } else {
      merged.extensions = overExt;
    }
  }

  return merged as ClientCapabilityOptions;
}
