/**
 * Families 8, 9 and 10: Resources, resource templates and changes, and
 * Prompts.
 */

import type { FeatureDefinition } from "../../types.js";
import { coreSpec } from "../spec-refs.js";
import {
  absent,
  capability,
  countItems,
  declaresCapability,
  emptyList,
  isNonEmptyString,
  isRecord,
  lifecycle,
  listDetail,
  listsItems,
  present,
  probeNumber,
  probeRule,
  promisedFlag,
  type DeclaredRule,
  type ProbeRule,
} from "./rules.js";

const RESOURCES = "server/resources";
const PROMPTS = "server/prompts";
const MODERN = lifecycle({ introduced: "2026-07-28" });

/** URI scheme of a resource, lowercased; undefined when the URI has none. */
function uriScheme(uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(uri);
  return match?.[1]?.toLowerCase();
}

const uriSchemes: DeclaredRule = (surface) => {
  if (surface.resources.length === 0) return emptyList(surface, "resources");
  const schemes = [
    ...new Set(
      surface.resources
        .map((resource) => uriScheme(resource.uri))
        .filter((scheme): scheme is string => scheme !== undefined)
    ),
  ].sort();
  return schemes.length > 0
    ? present("detected", {
        count: schemes.length,
        detail: listDetail(schemes),
      })
    : null;
};

/**
 * Templates are their own opportunity: a server with resources and an empty
 * template list could still add templates, so an empty list is absent.
 */
const templatesListed: DeclaredRule = (surface) => {
  const count = surface.resourceTemplates.length;
  if (count > 0) {
    return present("detected", {
      count,
      detail: `${count} resource templates`,
    });
  }
  return isRecord(capability(surface, "resources"))
    ? absent(["resourceTemplates"])
    : absent(["capabilities", "resourceTemplates"]);
};

/** A successful read of a ui:// or skill:// resource by a background probe. */
const probedRead: ProbeRule = (probes) => {
  const ui = probeRule("apps-ui-resources", (summary) => {
    const reads = probeNumber(summary.values.readCount) ?? 0;
    return reads > 0
      ? present("probed", { count: reads, detail: "Read UI resources." })
      : null;
  })(probes);
  if (ui?.kind === "present") return ui;
  const skills = probeRule("skills", (summary) => {
    const verified = probeNumber(summary.values.verified) ?? 0;
    return verified > 0
      ? present("probed", { count: verified, detail: "Read skill files." })
      : null;
  })(probes);
  return skills?.kind === "present" ? skills : null;
};

export const RESOURCE_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "resources.capability",
    family: "resources",
    name: "resources capability",
    summary: "Declares that the server exposes data clients can list and read.",
    howTo:
      "Register at least one resource or resource template. MCP SDKs declare the capability for you.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "capabilities"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: declaresCapability("resources"),
    },
  },
  {
    id: "resources.list",
    family: "resources",
    parent: "resources.capability",
    name: "resources/list",
    summary:
      "Lists resources with uri, name and optional title, description, MIME type, size, icons and annotations.",
    howTo:
      "Register resources with your SDK and it answers resources/list. Add a title and mimeType to each.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "listing-resources"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: listsItems("resources", "resources"),
    },
  },
  {
    id: "resources.read",
    family: "resources",
    parent: "resources.capability",
    name: "resources/read",
    summary: "Returns a resource's contents as text or base64 blob.",
    howTo:
      "Handle resources/read for each URI you list. Read a resource in MCPJam to test it.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "reading-resources"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "probed", observable: true, probed: probedRead },
  },
  {
    id: "resources.not-found-error",
    family: "resources",
    parent: "resources.capability",
    name: "Resource not found error",
    summary:
      "Reading an unknown URI gets a protocol error: -32002 up to 2025-11-25, -32602 on 2026-07-28.",
    howTo:
      "Return the error code for your revision when a URI does not exist, never an empty contents list. Use Run checks to test it.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "error-handling"),
    stage: "stable",
    lifecycle: {},
    optional: false,
    assessment: { primary: "checked" },
  },
  {
    id: "resources.uri-schemes",
    family: "resources",
    parent: "resources.capability",
    name: "Resource URI schemes",
    summary:
      "The schemes resource URIs use, such as https, file, git or a custom one.",
    howTo:
      "Use https:// for web content, file:// for files and your own scheme for everything else.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "common-uri-schemes"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "declared", declared: uriSchemes },
  },
  {
    id: "resources.list-changed",
    family: "resources",
    parent: "resources.capability",
    name: "resources.listChanged",
    summary:
      "The server tells clients when its resource list changes so they can list again.",
    howTo:
      "Declare resources.listChanged and send notifications/resources/list_changed when the list changes.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "list-changed-notification"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      observable: true,
      declared: promisedFlag(
        "resources",
        "listChanged",
        "a list change notification"
      ),
    },
  },
  {
    id: "resources.stable-list",
    family: "resources",
    parent: "resources.capability",
    name: "Same resource list on every connection",
    summary:
      "The resource list does not change from one connection to the next, except by authorization.",
    howTo:
      "Return the same resources to every client that has the same credentials.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "capabilities"),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: { primary: "checked" },
  },
  {
    id: "resources.read-input-required",
    family: "resources",
    parent: "resources.capability",
    name: "resources/read asks for input",
    summary:
      "A resource read can pause with input_required to ask the user before it returns contents.",
    howTo:
      "Return input_required from resources/read when reading needs the user's input. Read the resource in MCPJam to see it.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/patterns/mrtr", "supported-requests"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
];

export const RESOURCE_TEMPLATE_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "resource-templates.list",
    family: "resource-templates",
    name: "resources/templates/list",
    summary:
      "Lists URI templates clients fill in to read parameterized resources.",
    howTo:
      "Register resource templates with RFC 6570 URI templates, for example file:///{path}.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "resource-templates"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: templatesListed,
    },
  },
  {
    id: "resource-templates.fields",
    family: "resource-templates",
    name: "Resource template fields",
    summary:
      "Each template's uriTemplate, name, title, description, MIME type, annotations and icons.",
    howTo:
      "Give each template a uriTemplate, a name, and a description that says what its variables mean.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "resourcetemplate"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: countItems(
        "resourceTemplates",
        (template) =>
          isNonEmptyString(template.uriTemplate) &&
          isNonEmptyString(template.description),
        ["resourceTemplates"]
      ),
    },
  },
  {
    id: "resource-templates.expanded-read",
    family: "resource-templates",
    name: "Read through a template",
    summary:
      "Reading a URI built from a template returns that resource's contents.",
    howTo:
      "Handle resources/read for every URI your templates can produce. Fill in a template in MCPJam to test it.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "resource-templates"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "checked" },
  },
  {
    id: "resource-templates.list-changed-coverage",
    family: "resource-templates",
    name: "Template list changes",
    summary:
      "Whether resources/list_changed also signals template changes. The specification does not say.",
    howTo:
      "Send notifications/resources/list_changed when templates change too, so clients list both again.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "list-changed-notification"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "observed" },
  },
  {
    id: "resource-templates.updated",
    family: "resource-templates",
    name: "Resource change notifications",
    summary:
      "notifications/resources/updated tells a client that a resource it read has changed.",
    howTo:
      "Send notifications/resources/updated with the URI whenever a subscribed resource changes.",
    owner: "server",
    spec: coreSpec("2026-07-28", RESOURCES, "subscriptions"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
];

export const PROMPT_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "prompts.capability",
    family: "prompts",
    name: "prompts capability",
    summary: "Declares that the server offers prompt templates users can pick.",
    howTo:
      "Register at least one prompt. MCP SDKs declare the prompts capability for you.",
    owner: "server",
    spec: coreSpec("2026-07-28", PROMPTS, "capabilities"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: declaresCapability("prompts"),
    },
  },
  {
    id: "prompts.list",
    family: "prompts",
    parent: "prompts.capability",
    name: "prompts/list",
    summary:
      "Lists prompts with name and optional title, description and icons.",
    howTo:
      "Register prompts with your SDK and it answers prompts/list. Give each a title and description.",
    owner: "server",
    spec: coreSpec("2026-07-28", PROMPTS, "listing-prompts"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: listsItems("prompts", "prompts"),
    },
  },
  {
    id: "prompts.arguments",
    family: "prompts",
    parent: "prompts.capability",
    name: "Prompt arguments",
    summary:
      "Named arguments a user fills in, each with a description and a required flag.",
    howTo:
      "Add arguments to a prompt and mark the ones it cannot work without as required.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "promptargument"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      declared: countItems(
        "prompts",
        (prompt) =>
          Array.isArray(prompt.arguments) && prompt.arguments.length > 0,
        ["prompts"]
      ),
    },
  },
  {
    id: "prompts.get",
    family: "prompts",
    parent: "prompts.capability",
    name: "prompts/get",
    summary: "Returns a prompt's messages with the user's arguments filled in.",
    howTo:
      "Handle prompts/get for each prompt you list. Run a prompt in MCPJam to test it.",
    owner: "server",
    spec: coreSpec("2026-07-28", PROMPTS, "getting-a-prompt"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "checked", observable: true },
  },
  {
    id: "prompts.message-content",
    family: "prompts",
    parent: "prompts.capability",
    name: "Prompt messages",
    summary:
      "User and assistant messages with text, image, audio, resource link or embedded resource content.",
    howTo:
      "Return messages with a role and content from prompts/get. Run the prompt in MCPJam to see them.",
    owner: "server",
    spec: coreSpec("2026-07-28", PROMPTS, "promptmessage"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "prompts.errors",
    family: "prompts",
    parent: "prompts.capability",
    name: "Prompt errors (-32602)",
    summary:
      "An unknown prompt name or a missing required argument gets a -32602 protocol error.",
    howTo:
      "Return -32602 for unknown prompt names and missing required arguments.",
    owner: "server",
    spec: coreSpec("2026-07-28", PROMPTS, "error-handling"),
    stage: "stable",
    lifecycle: {},
    optional: false,
    assessment: { primary: "checked" },
  },
  {
    id: "prompts.list-changed",
    family: "prompts",
    parent: "prompts.capability",
    name: "prompts.listChanged",
    summary:
      "The server tells clients when its prompt list changes so they can list again.",
    howTo:
      "Declare prompts.listChanged and send notifications/prompts/list_changed when the list changes.",
    owner: "server",
    spec: coreSpec("2026-07-28", PROMPTS, "list-changed-notification"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      observable: true,
      declared: promisedFlag(
        "prompts",
        "listChanged",
        "a list change notification"
      ),
    },
  },
];
