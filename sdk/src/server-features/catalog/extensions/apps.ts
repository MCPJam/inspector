/**
 * Family 19: MCP Apps (`io.modelcontextprotocol/ui`). Apps defines no server
 * capability: a server shows it through tool `_meta.ui.resourceUri`, `ui://`
 * resources and their `_meta.ui` policy. Only the client declares support, so
 * server rows that can be absent carry `requiresClientExtension`.
 */

import {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
} from "../../../mcp-client-manager/capabilities.js";
import type {
  DeclaredItem,
  DeclaredSurface,
  FeatureDefinition,
  FeatureRuleOutcome,
  ProbeSummary,
  ProbeSurface,
  ProbeValueKeysMap,
} from "../../types.js";
import {
  countOf,
  familyFeature,
  isComplete,
  metaOf,
  probeBlocker,
  probeBoolean,
  probeNumber,
  recordAt,
  specAt,
  stringAt,
} from "./shared.js";

const feature = familyFeature("mcp-apps", "stable");
const UI_SCHEME = "ui://";
/** Deprecated flat key, "removed before GA" in the Apps specification. */
const LEGACY_UI_RESOURCE_URI_KEY = "ui/resourceUri";

function toolUi(tool: DeclaredItem) {
  return recordAt(metaOf(tool), "ui");
}

function nestedResourceUri(tool: DeclaredItem): string | undefined {
  return stringAt(toolUi(tool), "resourceUri");
}

function legacyResourceUri(tool: DeclaredItem): string | undefined {
  return stringAt(metaOf(tool), LEGACY_UI_RESOURCE_URI_KEY);
}

function isUiResource(resource: DeclaredItem): boolean {
  const uri = stringAt(resource, "uri");
  return (
    uri !== undefined &&
    uri.startsWith(UI_SCHEME) &&
    stringAt(resource, "mimeType") === MCP_UI_RESOURCE_MIME_TYPE
  );
}

const TOOL_META_BASIS = ["tools", "toolMeta"] as const;

/** Tools that link a view, by either key. */
function linkedViewUris(surface: DeclaredSurface): string[] {
  return surface.tools
    .map((tool) => nestedResourceUri(tool) ?? legacyResourceUri(tool))
    .filter(
      (uri): uri is string => uri !== undefined && uri.startsWith(UI_SCHEME)
    );
}

function noTools(surface: DeclaredSurface): FeatureRuleOutcome | undefined {
  if (surface.tools.length > 0 || !isComplete(surface, ["tools"]))
    return undefined;
  return { kind: "not-applicable", reason: "This server lists no tools." };
}

/** Counts tools that carry a field, or names the coverage a negative needs. */
function toolFieldOutcome(
  surface: DeclaredSurface,
  has: (tool: DeclaredItem) => boolean
): FeatureRuleOutcome {
  const none = noTools(surface);
  if (none) return none;
  const count = surface.tools.filter(has).length;
  if (count > 0) {
    return {
      kind: "present",
      via: "detected",
      count,
      detail: countOf(count, surface.tools.length, "tools"),
    };
  }
  return { kind: "absent", basis: TOOL_META_BASIS };
}

function uiResourceDeclared(surface: DeclaredSurface): FeatureRuleOutcome {
  const listed = surface.resources.filter(isUiResource).length;
  if (listed > 0) {
    return {
      kind: "present",
      via: "detected",
      count: listed,
      detail: `${listed} listed UI resources`,
    };
  }
  const linked = new Set(linkedViewUris(surface)).size;
  if (linked > 0) {
    return {
      kind: "present",
      via: "detected",
      count: linked,
      detail: "Linked from tool metadata and not listed in resources/list",
    };
  }
  return { kind: "absent", basis: ["resources", "tools", "toolMeta"] };
}

type UiPolicyKey = Extract<
  ProbeValueKeysMap["apps-ui-resources"],
  | "cspDeclared"
  | "permissionsDeclared"
  | "domainDeclared"
  | "prefersBorderDeclared"
>;

/** `_meta.ui` policy on list entries; the read content item wins, so a list never proves absence. */
function policyDeclared(field: string) {
  return (surface: DeclaredSurface): FeatureRuleOutcome => {
    const count = surface.resources.filter((resource) => {
      if (!isUiResource(resource)) return false;
      const ui = recordAt(metaOf(resource), "ui");
      return ui !== undefined && ui[field] !== undefined;
    }).length;
    return count > 0
      ? {
          kind: "present",
          via: "detected",
          count,
          detail: `${count} listed UI resources`,
        }
      : null;
  };
}

function uiProbe(
  probes: ProbeSurface
):
  | { outcome: FeatureRuleOutcome }
  | { probe: ProbeSummary<"apps-ui-resources"> } {
  const probe = probes["apps-ui-resources"];
  const blocked = probeBlocker(probe, "UI resource");
  if (blocked !== undefined || !probe) return { outcome: blocked ?? null };
  if (probeNumber(probe.values.uiResourceCount) === 0) {
    return {
      outcome: {
        kind: "not-applicable",
        reason: "This server has no UI resources to read.",
      },
    };
  }
  if ((probeNumber(probe.values.readCount) ?? 0) === 0) {
    const waited = (probeNumber(probe.values.abandonedInputRequired) ?? 0) > 0;
    return {
      outcome: {
        kind: "unknown",
        reason: waited
          ? "Reading the UI resources stopped because the server asked for input."
          : "No UI resource could be read.",
      },
    };
  }
  return { probe };
}

function policyProbed(key: UiPolicyKey) {
  return (probes: ProbeSurface): FeatureRuleOutcome => {
    const read = uiProbe(probes);
    if ("outcome" in read) return read.outcome;
    const { probe } = read;
    const declared = probeBoolean(probe.values[key]);
    const readCount = probeNumber(probe.values.readCount) ?? 0;
    // The read content declares the policy; no host was seen applying it.
    if (declared === true) {
      return { kind: "present", via: "detected", count: readCount };
    }
    if (
      declared === false &&
      probe.coverage === "complete" &&
      (probeNumber(probe.values.readFailures) ?? 0) === 0
    ) {
      return { kind: "absent", basis: [] };
    }
    return { kind: "unknown", reason: "Some UI resources could not be read." };
  };
}

function policyFeature(
  id: string,
  name: string,
  field: string,
  key: UiPolicyKey,
  summary: string,
  howTo: string
): FeatureDefinition {
  return feature({
    id,
    parent: "apps.resource-content",
    name,
    summary,
    howTo,
    spec: specAt("apps-draft", "metadata-location"),
    assessment: {
      primary: "probed",
      declared: policyDeclared(field),
      probed: policyProbed(key),
      requiresClientExtension: MCP_UI_EXTENSION_ID,
    },
  });
}

function bridgeFeature(
  input: Pick<FeatureDefinition, "id" | "name" | "summary" | "howTo" | "spec"> &
    Partial<Pick<FeatureDefinition, "owner" | "stage" | "parent">>
): FeatureDefinition {
  return feature({
    parent: "apps.bridge",
    owner: "host",
    ...input,
    assessment: { primary: "observed", observable: true },
  });
}

const PLAYGROUND_VIEW =
  "Open the server in the Playground and call a tool that renders a view.";

export const APPS_FEATURES: readonly FeatureDefinition[] = [
  feature({
    id: "apps.client-ui-capability",
    name: "Client declares MCP Apps support (mimeTypes)",
    summary:
      "The host tells the server it can render views of type text/html;profile=mcp-app.",
    howTo:
      "Hosts declare io.modelcontextprotocol/ui with mimeTypes in their client capabilities. MCPJam sends it when the selected client renders MCP Apps, and the capture context shows what was sent.",
    owner: "client",
    spec: specAt("apps", "clientserver-capability-negotiation"),
    assessment: { primary: "declared" },
  }),
  feature({
    id: "apps.views",
    name: "Views and tool links",
    summary: "Tools that open an interactive HTML view in the host.",
    howTo:
      "Register a ui:// resource with text/html;profile=mcp-app and point a tool's _meta.ui.resourceUri at it.",
    spec: specAt("apps", "resource-discovery"),
    assessment: {
      primary: "declared",
      declared: uiResourceDeclared,
      requiresClientExtension: MCP_UI_EXTENSION_ID,
    },
  }),
  feature({
    id: "apps.ui-resource",
    parent: "apps.views",
    name: "UI resource (ui:// with text/html;profile=mcp-app)",
    summary:
      "An HTML view the host renders in a sandbox next to the conversation.",
    howTo:
      "Serve the view as a resource with a ui:// URI and mimeType text/html;profile=mcp-app. Listing it in resources/list is optional.",
    spec: specAt("apps", "ui-resource-format"),
    assessment: {
      primary: "declared",
      declared: uiResourceDeclared,
      probed: (probes) => {
        const probe = probes["apps-ui-resources"];
        if (probe?.status !== "ok") return null;
        const count = probeNumber(probe.values.uiResourceCount) ?? 0;
        // Found by listing and tool links, the same hint the declared rule reads.
        return count > 0 ? { kind: "present", via: "detected", count } : null;
      },
      requiresClientExtension: MCP_UI_EXTENSION_ID,
    },
  }),
  feature({
    id: "apps.tool-resource-uri",
    parent: "apps.views",
    name: "Tool _meta.ui.resourceUri",
    summary: "Links a tool to the view the host shows when the tool runs.",
    howTo: 'Set _meta: { ui: { resourceUri: "ui://..." } } on the tool.',
    spec: specAt("apps", "resource-discovery"),
    assessment: {
      primary: "declared",
      declared: (surface) =>
        toolFieldOutcome(surface, (tool) =>
          (nestedResourceUri(tool) ?? "").startsWith(UI_SCHEME)
        ),
      requiresClientExtension: MCP_UI_EXTENSION_ID,
    },
  }),
  feature({
    id: "apps.legacy-resource-uri",
    parent: "apps.views",
    name: 'Tool _meta["ui/resourceUri"] (deprecated)',
    summary:
      "The older flat key for a tool's view, due to be removed before GA.",
    howTo:
      "Move the value to _meta.ui.resourceUri. The ext-apps SDK writes both keys, which is fine.",
    spec: specAt("apps", "resource-discovery"),
    assessment: {
      primary: "declared",
      declared: (surface) => {
        const legacy = surface.tools.filter(
          (tool) => legacyResourceUri(tool) !== undefined
        );
        const relying = legacy.filter(
          (tool) => nestedResourceUri(tool) === undefined
        ).length;
        if (relying > 0) {
          return {
            kind: "present",
            via: "detected",
            count: relying,
            detail: `${countOf(relying, surface.tools.length, "tools")} use only the deprecated key`,
          };
        }
        if (legacy.length > 0) {
          return {
            kind: "not-applicable",
            reason:
              "The deprecated key only mirrors _meta.ui.resourceUri, as the ext-apps SDK writes both.",
          };
        }
        return isComplete(surface, TOOL_META_BASIS)
          ? {
              kind: "not-applicable",
              reason: "Not used. Servers should use _meta.ui.resourceUri.",
            }
          : null;
      },
    },
  }),
  feature({
    id: "apps.visibility",
    parent: "apps.views",
    name: "Tool _meta.ui.visibility (model, app)",
    summary: "Chooses whether the model, the view, or both can call a tool.",
    howTo:
      'Set _meta.ui.visibility to ["app"] for tools only the view should call. The default is ["model", "app"].',
    spec: specAt("apps", "visibility"),
    assessment: {
      primary: "declared",
      declared: (surface) =>
        toolFieldOutcome(surface, (tool) =>
          Array.isArray(toolUi(tool)?.visibility)
        ),
      requiresClientExtension: MCP_UI_EXTENSION_ID,
    },
  }),
  feature({
    id: "apps.resource-content",
    name: "UI resource content and policy",
    summary:
      "The view's HTML and the security and rendering metadata the host applies to it.",
    howTo:
      "Return the HTML from resources/read and put csp, permissions, domain and prefersBorder under the content item's _meta.ui.",
    spec: specAt("apps-draft", "metadata-location"),
    assessment: {
      primary: "probed",
      requiresClientExtension: MCP_UI_EXTENSION_ID,
    },
  }),
  policyFeature(
    "apps.csp",
    "CSP domains (connect, resource, frame, baseUri)",
    "csp",
    "cspDeclared",
    "Lets the view load data and assets from the domains the server names.",
    "Set _meta.ui.csp with connectDomains, resourceDomains, frameDomains or baseUriDomains on the UI resource content."
  ),
  policyFeature(
    "apps.permissions",
    "Permissions (camera, microphone, geolocation, clipboardWrite)",
    "permissions",
    "permissionsDeclared",
    "Asks the host for device permissions the view needs.",
    "Set _meta.ui.permissions on the UI resource content with the permissions the view uses."
  ),
  policyFeature(
    "apps.domain",
    "Dedicated domain",
    "domain",
    "domainDeclared",
    "Gives the view a stable origin, for example for OAuth redirects or API keys.",
    "Set _meta.ui.domain on the UI resource content."
  ),
  policyFeature(
    "apps.prefers-border",
    "prefersBorder",
    "prefersBorder",
    "prefersBorderDeclared",
    "Tells the host whether to draw a border around the view.",
    "Set _meta.ui.prefersBorder to true or false on the UI resource content."
  ),
  feature({
    id: "apps.html-content",
    parent: "apps.resource-content",
    name: "HTML content (text or blob)",
    summary: "The UI resource returns one HTML document the host can render.",
    howTo:
      "Return exactly one content item with mimeType text/html;profile=mcp-app and the HTML in text or blob.",
    spec: specAt("apps-draft", "content-requirements"),
    assessment: {
      primary: "probed",
      probed: (probes) => {
        const read = uiProbe(probes);
        if ("outcome" in read) return read.outcome;
        const ok = probeBoolean(read.probe.values.htmlProfileOk);
        if (ok === true) {
          return {
            kind: "present",
            via: "probed",
            count: probeNumber(read.probe.values.readCount) ?? 0,
          };
        }
        return {
          kind: "unknown",
          reason:
            ok === false
              ? "A UI resource did not return text/html;profile=mcp-app content. Run checks for details."
              : "The HTML content was not checked.",
        };
      },
      requiresClientExtension: MCP_UI_EXTENSION_ID,
    },
  }),
  feature({
    id: "apps.server-behavior",
    name: "Server behavior with Apps hosts",
    summary:
      "How the server adapts its tools and results to hosts that render views.",
    howTo: PLAYGROUND_VIEW,
    spec: specAt("apps", "server-behavior"),
    assessment: { primary: "observed" },
  }),
  feature({
    id: "apps.ui-conditional-tools",
    parent: "apps.server-behavior",
    name: "Tool set conditional on the UI capability",
    summary:
      "The server offers UI tools only to hosts that declare MCP Apps support.",
    howTo:
      "Read the client's io.modelcontextprotocol/ui capability and register UI tools only when it is present.",
    spec: specAt("apps", "server-behavior"),
    assessment: { primary: "probed" },
  }),
  feature({
    id: "apps.text-fallback",
    parent: "apps.server-behavior",
    name: "Text fallback content on UI tools",
    summary:
      "UI tools also return text, so hosts without views still show a useful result.",
    howTo:
      "Return text content alongside structuredContent from tools that link a view.",
    spec: specAt("apps", "server-behavior"),
    assessment: { primary: "observed", observable: true },
  }),
  feature({
    id: "apps.bridge",
    name: "View and host messages",
    summary:
      "The messages a view and its host exchange while the view is open.",
    howTo: PLAYGROUND_VIEW,
    owner: "host",
    spec: specAt("apps", "standard-mcp-messages"),
    assessment: { primary: "observed" },
  }),
  bridgeFeature({
    id: "apps.app-tools-call",
    name: "View-originated tools/call",
    summary:
      "The view calls the server's tools through the host, which enforces visibility.",
    howTo: `${PLAYGROUND_VIEW} Use a control in the view that calls a tool.`,
    spec: specAt("apps", "standard-mcp-messages"),
  }),
  bridgeFeature({
    id: "apps.app-resources-read",
    name: "View-originated resources/read",
    summary: "The view reads the server's resources through the host.",
    howTo: PLAYGROUND_VIEW,
    spec: specAt("apps", "standard-mcp-messages"),
  }),
  bridgeFeature({
    id: "apps.view-requests",
    name: "View requests (ui/open-link, ui/message, ui/update-model-context, ui/request-display-mode)",
    summary:
      "The view asks the host to open links, send messages, update model context or change display mode.",
    howTo: PLAYGROUND_VIEW,
    owner: "app",
    spec: specAt("apps", "requests-view--host"),
  }),
  bridgeFeature({
    id: "apps.view-notifications",
    name: "View logging and ping",
    summary: "The view sends notifications/message logs and ping to the host.",
    howTo: PLAYGROUND_VIEW,
    owner: "app",
    spec: specAt("apps", "standard-mcp-messages"),
  }),
  bridgeFeature({
    id: "apps.host-notifications",
    name: "Host notifications to the view",
    summary:
      "The host sends tool input, partial input, results, cancellation, context and size changes, and teardown to the view.",
    howTo: PLAYGROUND_VIEW,
    spec: specAt("apps", "notifications-host--view"),
  }),
  bridgeFeature({
    id: "apps.display-modes",
    name: "Display modes (inline, fullscreen, pip)",
    summary: "The view lists the display modes it supports in ui/initialize.",
    howTo: `${PLAYGROUND_VIEW} Switch the view between inline, fullscreen and picture in picture.`,
    owner: "app",
    spec: specAt("apps", "app-capabilities-in-uiinitialize"),
  }),
  feature({
    id: "apps.draft",
    name: "Draft additions",
    summary:
      "View features in the Apps draft that are not in the stable specification yet.",
    howTo: PLAYGROUND_VIEW,
    owner: "app",
    stage: "experimental",
    spec: specAt("apps-draft"),
    assessment: { primary: "observed" },
  }),
  bridgeFeature({
    id: "apps.download-file-teardown",
    parent: "apps.draft",
    name: "ui/download-file and ui/notifications/request-teardown",
    summary: "The view asks the host to download a file or to close the view.",
    howTo: PLAYGROUND_VIEW,
    owner: "app",
    stage: "experimental",
    spec: specAt("apps-draft"),
  }),
  bridgeFeature({
    id: "apps.app-provided-tools",
    parent: "apps.draft",
    name: "App-provided tools",
    summary:
      "The view offers its own tools to the host through tools/list and tools/call, separate from the server's tools.",
    howTo: PLAYGROUND_VIEW,
    owner: "app",
    stage: "experimental",
    spec: specAt("apps-draft", "app-provided-tools"),
  }),
];
