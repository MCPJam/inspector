/**
 * Family 24: Third-party and experimental. OpenAI extensions
 * (`openai/mcp-extensions`), legacy OpenAI Apps SDK `_meta`, experimental
 * proposals and capabilities the catalog does not recognize. OpenAI
 * capabilities live under `extensions` on 2026-07-28 and under `extensions`
 * or `experimental` on earlier revisions, so both are read.
 */

import { protocolEra } from "../../context.js";
import type {
  DeclaredItem,
  DeclaredSurface,
  FeatureDefinition,
  FeatureRuleOutcome,
} from "../../types.js";
import { coreSpec, externalSpec } from "../spec-refs.js";
import {
  MCP_FILES_EXTENSION_ID,
  OPENAI_MENTIONS_CAPABILITY,
  OPENAI_SETTINGS_CAPABILITY,
  unrecognizedCapabilityKeys,
} from "./known-capabilities.js";
import {
  capabilitiesOf,
  countOf,
  familyFeature,
  isComplete,
  lookupExtension,
  metaOf,
  recordAt,
  specAt,
  stringAt,
} from "./shared.js";

const openaiFeature = familyFeature("third-party-experimental", "early-access");
const appsSdkFeature = familyFeature("third-party-experimental", "stable");
const experimentalFeature = familyFeature(
  "third-party-experimental",
  "experimental"
);

const OPENAI_CONTAINERS = ["extensions", "experimental"] as const;
const OPENAI_CAPABILITIES = [
  OPENAI_SETTINGS_CAPABILITY,
  OPENAI_MENTIONS_CAPABILITY,
];
const APPS_SDK_DOCS = "https://developers.openai.com/apps-sdk/reference";
const TOOL_META_BASIS = ["tools", "toolMeta"] as const;

/** Legacy Apps SDK keys on tool descriptors and on UI resources. */
export const APPS_SDK_TOOL_META_KEYS = [
  "openai/outputTemplate",
  "openai/widgetAccessible",
  "openai/visibility",
  "openai/toolInvocation/invoking",
  "openai/toolInvocation/invoked",
  "openai/fileParams",
] as const;
export const APPS_SDK_RESOURCE_META_KEYS = [
  "openai/widgetDescription",
  "openai/widgetPrefersBorder",
  "openai/widgetCSP",
  "openai/widgetDomain",
] as const;
export const APPS_SDK_RESOURCE_MIME_TYPE = "text/html+skybridge";

/** An OpenAI capability, read from `extensions` and then `experimental`. */
function openaiCapability(
  surface: DeclaredSurface,
  id: string
): FeatureRuleOutcome {
  const lookup = lookupExtension(surface, id, OPENAI_CONTAINERS);
  if (lookup.state === "declared") {
    return { kind: "present", via: "advertised", detail: lookup.location };
  }
  if (lookup.state === "malformed") {
    return {
      kind: "unknown",
      reason: `${id} is declared with a value that is not an object, so clients ignore it.`,
    };
  }
  if (lookup.state === "not-captured") {
    return {
      kind: "unknown",
      reason: "The server's capabilities were not captured.",
    };
  }
  return { kind: "absent", basis: ["capabilities"] };
}

function toolNamed(
  surface: DeclaredSurface,
  name: string
): DeclaredItem | undefined {
  return surface.tools.find((tool) => stringAt(tool, "name") === name);
}

/** Tools with `_meta[key]` matching `has`; not applicable on a server with no tools. */
function toolMetaOutcome(
  surface: DeclaredSurface,
  has: (meta: Readonly<Record<string, unknown>>) => boolean
): FeatureRuleOutcome {
  if (surface.tools.length === 0 && isComplete(surface, ["tools"])) {
    return { kind: "not-applicable", reason: "This server lists no tools." };
  }
  const count = surface.tools.filter((tool) => {
    const meta = metaOf(tool);
    return meta !== undefined && has(meta);
  }).length;
  return count > 0
    ? {
        kind: "present",
        via: "detected",
        count,
        detail: countOf(count, surface.tools.length, "tools"),
      }
    : { kind: "absent", basis: TOOL_META_BASIS };
}

function mentionsOutcome(surface: DeclaredSurface): FeatureRuleOutcome {
  const lookup = lookupExtension(
    surface,
    OPENAI_MENTIONS_CAPABILITY,
    OPENAI_CONTAINERS
  );
  if (lookup.state !== "declared")
    return openaiCapability(surface, OPENAI_MENTIONS_CAPABILITY);
  const searchTool = stringAt(lookup.settings, "searchTool");
  const tool = searchTool ? toolNamed(surface, searchTool) : undefined;
  if (!tool) {
    return isComplete(surface, ["tools"])
      ? {
          kind: "unknown",
          reason:
            "openai/mentions names a search tool the server does not list.",
        }
      : { kind: "present", via: "advertised", detail: lookup.location };
  }
  const readOnly = recordAt(tool, "annotations")?.readOnlyHint === true;
  const visibility = recordAt(metaOf(tool), "ui")?.visibility;
  const appVisible = !Array.isArray(visibility) || visibility.includes("app");
  if (!readOnly || !appVisible) {
    return {
      kind: "unknown",
      reason:
        "The mentions search tool must set readOnlyHint and stay visible to the app.",
    };
  }
  return {
    kind: "present",
    via: "advertised",
    detail: `${lookup.location}, searchTool ${searchTool}`,
  };
}

const USE_IN_CHATGPT_HOST =
  "Open the server in the Playground with the ChatGPT or Codex client and use one of its views.";

function hostObserved(
  input: Pick<FeatureDefinition, "id" | "name" | "summary" | "spec"> &
    Partial<Pick<FeatureDefinition, "owner" | "howTo">>
): FeatureDefinition {
  return openaiFeature({
    parent: "openai.extensions",
    owner: "host",
    howTo: USE_IN_CHATGPT_HOST,
    ...input,
    assessment: { primary: "observed", observable: true },
  });
}

export const THIRD_PARTY_FEATURES: readonly FeatureDefinition[] = [
  openaiFeature({
    id: "openai.extensions",
    name: "OpenAI extensions",
    summary:
      "OpenAI's extensions for MCP servers and apps in ChatGPT and Codex.",
    howTo: "Use @openai/mcp-extensions on your server and in your views.",
    spec: specAt("openai"),
    assessment: { primary: "declared" },
  }),
  openaiFeature({
    id: "openai.capability-location",
    parent: "openai.extensions",
    name: "Capability location (extensions or experimental)",
    summary:
      "OpenAI capabilities sit under extensions, or under experimental for clients older than 2026-07-28.",
    howTo:
      "Declare OpenAI capabilities under extensions, and also under experimental for older clients.",
    spec: specAt("openai", "server-capabilities"),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const locations = OPENAI_CAPABILITIES.flatMap((id) => {
          const lookup = lookupExtension(surface, id, OPENAI_CONTAINERS);
          return lookup.state === "declared" || lookup.state === "malformed"
            ? [lookup.location]
            : [];
        });
        if (locations.length === 0) {
          return isComplete(surface, ["capabilities"])
            ? {
                kind: "not-applicable",
                reason: "The server declares no OpenAI capability.",
              }
            : null;
        }
        const underExtensions = locations.some((location) =>
          location.startsWith("extensions")
        );
        if (
          !underExtensions &&
          protocolEra(surface.protocolVersion) === "modern"
        ) {
          return {
            kind: "unknown",
            reason:
              "OpenAI capabilities are only under experimental, which 2026-07-28 clients do not read.",
          };
        }
        return {
          kind: "present",
          via: "advertised",
          detail: locations.join(", "),
        };
      },
    },
  }),
  openaiFeature({
    id: "openai.settings",
    parent: "openai.extensions",
    name: "openai/settings (readTool, updateTool)",
    summary:
      "Lets the host show and change the server's settings through two tools.",
    howTo:
      "Register settings with @openai/mcp-extensions, which declares openai/settings with readTool and updateTool.",
    spec: specAt("openai", "structured-settings"),
    assessment: {
      primary: "declared",
      declared: (surface) =>
        openaiCapability(surface, OPENAI_SETTINGS_CAPABILITY),
    },
  }),
  openaiFeature({
    id: "openai.mentions",
    parent: "openai.extensions",
    name: "openai/mentions (searchTool)",
    summary: "Lets users @-mention the server's resources from the composer.",
    howTo:
      "Declare openai/mentions with a searchTool that sets readOnlyHint: true and stays visible to the app.",
    spec: specAt("openai", "composer-at-mentions"),
    assessment: { primary: "declared", declared: mentionsOutcome },
  }),
  openaiFeature({
    id: "openai.mentions-legacy-key",
    parent: "openai.extensions",
    name: '_meta["openai/extensions"]["mentions/search"] (deprecated)',
    summary: "The older way to mark the mentions search tool.",
    howTo:
      "Declare the openai/mentions capability instead. @openai/mcp-extensions still writes this key too.",
    spec: specAt("openai", "composer-at-mentions"),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const outcome = toolMetaOutcome(
          surface,
          (meta) =>
            recordAt(meta, "openai/extensions")?.["mentions/search"] !==
            undefined
        );
        return outcome?.kind === "absent"
          ? isComplete(surface, TOOL_META_BASIS)
            ? {
                kind: "not-applicable",
                reason: "Not used. Servers should declare openai/mentions.",
              }
            : null
          : outcome;
      },
    },
  }),
  openaiFeature({
    id: "openai.entrypoints",
    parent: "openai.extensions",
    name: 'Entrypoints (_meta["openai/ui"].entrypoints)',
    summary:
      "Opens the server's views from the sidebar, a conversation or a file type.",
    howTo:
      'Add global, thread or file entrypoints under _meta["openai/ui"] on a tool that links a view.',
    spec: specAt("openai", "mcp-app-entrypoints"),
    assessment: {
      primary: "declared",
      declared: (surface) =>
        toolMetaOutcome(surface, (meta) => {
          const entrypoints = recordAt(meta, "openai/ui")?.entrypoints;
          return Array.isArray(entrypoints) && entrypoints.length > 0;
        }),
    },
  }),
  openaiFeature({
    id: "openai.deep-links",
    parent: "openai.extensions",
    name: "Deep links",
    summary: "The host opens a view at a specific URL inside the app.",
    howTo:
      "Read the openai/deepLink host state in your view and navigate to its url.",
    owner: "app",
    spec: specAt("openai", "deep-links"),
    assessment: { primary: "observed" },
  }),
  openaiFeature({
    id: "openai.display-modes",
    parent: "openai.extensions",
    name: 'Display modes (_meta["openai/ui"] on the UI resource)',
    summary:
      "Tells the host which display modes the view supports and which it prefers.",
    howTo:
      'Set availableDisplayModes and preferredDisplayMode under _meta["openai/ui"] on the UI resource content.',
    spec: specAt("openai", "display-modes"),
    assessment: {
      primary: "probed",
      declared: (surface) => {
        const count = surface.resources.filter((resource) => {
          const ui = recordAt(metaOf(resource), "openai/ui");
          return (
            ui?.availableDisplayModes !== undefined ||
            ui?.preferredDisplayMode !== undefined
          );
        }).length;
        return count > 0 ? { kind: "present", via: "detected", count } : null;
      },
    },
  }),
  hostObserved({
    id: "openai.file-resources",
    name: "File resources (openai/resource, openai/resources/write)",
    summary:
      "The view reads, watches and writes files the user shared with the host.",
    spec: specAt("openai", "filesystem-access"),
  }),
  hostObserved({
    id: "openai.model-context",
    name: "openai/modelContext",
    summary:
      "The view adds titled, grouped context with thumbnails for the model.",
    spec: specAt("openai", "uiupdate-model-context-extensions"),
  }),
  hostObserved({
    id: "openai.message",
    name: "openai/message",
    summary: "The view sends a message with a title, target and send behavior.",
    spec: specAt("openai", "uimessage-extensions"),
  }),
  hostObserved({
    id: "openai.files",
    name: "openai/files (open local files)",
    summary: "The view asks the host to open a local file.",
    spec: specAt("openai", "opening-local-files"),
  }),
  hostObserved({
    id: "openai.elicitation",
    name: "openai/elicitation forms",
    summary:
      "The server asks for input with OpenAI's richer forms, through MRTR on 2026-07-28 and openai/elicitation/create before.",
    owner: "server",
    howTo: "Call a tool that requests an OpenAI form in the Playground.",
    spec: specAt("openai", "openai-form-elicitation"),
  }),
  openaiFeature({
    id: "openai.onboarding",
    parent: "openai.extensions",
    name: "Plugin onboarding skill",
    summary:
      'A plugin manifest names a skill to run when a user installs the app (extensions["com.openai"].onboardingSkill).',
    howTo:
      "Set onboardingSkill in the plugin manifest. Adding the plugin in MCPJam offers to run it.",
    spec: specAt("openai", "plugin-onboarding"),
    assessment: { primary: "configured", setup: "openai-onboarding" },
  }),
  appsSdkFeature({
    id: "openai.apps-sdk",
    name: "OpenAI Apps SDK metadata (legacy)",
    summary: "Older ChatGPT app metadata that MCP Apps metadata replaces.",
    howTo:
      "Move to _meta.ui and text/html;profile=mcp-app. MCPJam renders both.",
    spec: externalSpec("openai-apps-sdk", APPS_SDK_DOCS),
    assessment: { primary: "declared" },
  }),
  appsSdkFeature({
    id: "openai.apps-sdk-meta",
    parent: "openai.apps-sdk",
    name: "Legacy Apps SDK _meta (openai/outputTemplate, widgetCSP and related keys)",
    summary:
      "Links tools to widgets and sets widget policy with openai/* keys and text/html+skybridge.",
    howTo:
      "Keep these keys for older ChatGPT clients and add the MCP Apps equivalents under _meta.ui.",
    spec: externalSpec("openai-apps-sdk", APPS_SDK_DOCS),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const keys = new Set<string>();
        for (const tool of surface.tools) {
          const meta = metaOf(tool) ?? {};
          for (const key of APPS_SDK_TOOL_META_KEYS)
            if (meta[key] !== undefined) keys.add(key);
        }
        for (const resource of surface.resources) {
          const meta = metaOf(resource) ?? {};
          for (const key of APPS_SDK_RESOURCE_META_KEYS)
            if (meta[key] !== undefined) keys.add(key);
          if (stringAt(resource, "mimeType") === APPS_SDK_RESOURCE_MIME_TYPE) {
            keys.add(APPS_SDK_RESOURCE_MIME_TYPE);
          }
        }
        if (keys.size > 0) {
          return {
            kind: "present",
            via: "detected",
            count: keys.size,
            detail: [...keys].join(", "),
          };
        }
        return isComplete(surface, ["tools", "toolMeta", "resources"])
          ? {
              kind: "not-applicable",
              reason: "Not used. MCP Apps metadata replaces these keys.",
            }
          : null;
      },
    },
  }),
  appsSdkFeature({
    id: "openai.profile",
    parent: "openai.apps-sdk",
    name: '_meta["openai/profile"] profile tool',
    summary: "Marks the one tool that returns the signed-in account's profile.",
    howTo:
      'Set _meta["openai/profile"] = true on exactly one tool that returns { id, name, email }.',
    spec: externalSpec("openai-apps-sdk", APPS_SDK_DOCS),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const marked = surface.tools.filter(
          (tool) => metaOf(tool)?.["openai/profile"] === true
        ).length;
        if (marked === 1) return { kind: "present", via: "detected", count: 1 };
        if (marked > 1) {
          return {
            kind: "unknown",
            reason: `${marked} tools set openai/profile. Hosts use it only when exactly one does.`,
          };
        }
        return isComplete(surface, TOOL_META_BASIS)
          ? {
              kind: "not-applicable",
              reason: "Optional. Hosts that connect several accounts use it.",
            }
          : null;
      },
    },
  }),
  experimentalFeature({
    id: "experimental.extensions",
    name: "Experimental extensions (experimental-ext-*)",
    summary:
      "Proposals such as File Uploads and Downloads that are not official extensions yet.",
    howTo:
      "Declare the proposal's id under extensions, or under experimental on older revisions, as its repository describes.",
    spec: externalSpec(
      "experimental",
      "https://modelcontextprotocol.io/extensions/overview#experimental-extensions"
    ),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const capabilities = capabilitiesOf(surface);
        if (!capabilities) return null;
        const found = new Set<string>();
        if (
          lookupExtension(surface, MCP_FILES_EXTENSION_ID, OPENAI_CONTAINERS)
            .state === "declared"
        ) {
          found.add(MCP_FILES_EXTENSION_ID);
        }
        // Official-namespace ids carried under experimental are how the
        // experimental-ext-* repositories declared themselves.
        const experimental = recordAt(capabilities, "experimental") ?? {};
        for (const key of Object.keys(experimental)) {
          if (key.startsWith("io.modelcontextprotocol/")) found.add(key);
        }
        if (found.size > 0) {
          return {
            kind: "present",
            via: "advertised",
            count: found.size,
            detail: [...found].join(", "),
          };
        }
        return { kind: "absent", basis: ["capabilities"] };
      },
    },
  }),
  experimentalFeature({
    id: "third-party.unrecognized-capabilities",
    name: "Unrecognized capabilities",
    summary:
      "Capabilities, extension ids and settings the server declares that this catalog does not know.",
    howTo:
      "Nothing to add. The row lists each key so you can look it up in the server's documentation.",
    spec: coreSpec("2026-07-28", "basic/versioning", "extension-negotiation"),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const capabilities = capabilitiesOf(surface);
        if (!capabilities) return null;
        const keys = unrecognizedCapabilityKeys(capabilities);
        if (keys.length > 0) {
          return {
            kind: "present",
            via: "advertised",
            count: keys.length,
            detail: keys.slice(0, 20).join(", "),
          };
        }
        return isComplete(surface, ["capabilities"])
          ? {
              kind: "not-applicable",
              reason: "Every declared capability is in the catalog.",
            }
          : null;
      },
    },
  }),
];
