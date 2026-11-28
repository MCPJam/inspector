/**
 * Family 7: Tool results and shared content. Results are runtime behavior,
 * seen in use or graded by Run checks; nothing here is inferred from the
 * declaration.
 */

import type { FeatureDefinition } from "../../types.js";
import { coreSpec } from "../spec-refs.js";
import { lifecycle } from "./rules.js";

const TOOLS = "server/tools";
const MODERN = lifecycle({ introduced: "2026-07-28" });

const RESULT_OBSERVED = { primary: "observed", observable: true } as const;

export const TOOL_RESULT_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "tool-results.content",
    family: "tool-results",
    name: "Tool result content",
    summary: "The content array a tool returns for the model and the user.",
    howTo:
      "Return content items from your tool handler. Call the tool in Playground to see them.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "tool-result"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: RESULT_OBSERVED,
  },
  {
    id: "tool-results.text",
    family: "tool-results",
    name: "Text content",
    summary: "Plain text in a tool result.",
    howTo: "Return a content item with type text.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "text-content"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: RESULT_OBSERVED,
  },
  {
    id: "tool-results.image",
    family: "tool-results",
    name: "Image content",
    summary: "Base64 image data with a MIME type.",
    howTo: "Return a content item with type image, base64 data and a mimeType.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "image-content"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: RESULT_OBSERVED,
  },
  {
    id: "tool-results.audio",
    family: "tool-results",
    name: "Audio content",
    summary: "Base64 audio data with a MIME type.",
    howTo: "Return a content item with type audio, base64 data and a mimeType.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "audio-content"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: RESULT_OBSERVED,
  },
  {
    id: "tool-results.resource-link",
    family: "tool-results",
    name: "Resource links",
    summary: "A link to a resource the client can read later.",
    howTo:
      "Return a content item with type resource_link and the resource's uri and name.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "resource-links"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: RESULT_OBSERVED,
  },
  {
    id: "tool-results.embedded-resource",
    family: "tool-results",
    name: "Embedded resources",
    summary: "A resource's contents included inline in the result.",
    howTo:
      "Return a content item with type resource that holds the resource's uri and its text or blob.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "embedded-resources"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: RESULT_OBSERVED,
  },
  {
    id: "tool-results.content-annotations",
    family: "tool-results",
    name: "Content annotations",
    summary: "Audience, priority and lastModified hints on content items.",
    howTo:
      "Add annotations with audience and priority to the content items that matter most.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "annotations"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26" }),
    optional: true,
    assessment: RESULT_OBSERVED,
  },
  {
    id: "tool-results.structured-content",
    family: "tool-results",
    name: "Structured content",
    summary:
      "Machine-readable JSON next to the text content. On 2026-07-28 it can be any JSON value.",
    howTo:
      "Return structuredContent from the tool and declare an outputSchema for it.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "structured-content"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: RESULT_OBSERVED,
  },
  {
    id: "tool-results.output-schema-conformance",
    family: "tool-results",
    name: "Results match outputSchema",
    summary:
      "structuredContent validates against the tool's declared outputSchema.",
    howTo:
      "Validate structuredContent against your outputSchema before you return it. Run checks with a fixture call to test it.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "output-schema"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: false,
    assessment: { primary: "checked" },
  },
  {
    id: "tool-results.is-error",
    family: "tool-results",
    name: "Tool errors (isError)",
    summary:
      "A failed call returns isError: true with a message the model can read.",
    howTo:
      "Return isError: true with an explanation when a tool fails, instead of throwing.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "error-handling"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: RESULT_OBSERVED,
  },
  {
    id: "tool-results.unknown-tool-error",
    family: "tool-results",
    name: "Unknown tool error (-32602)",
    summary: "Calling a tool that does not exist gets a -32602 protocol error.",
    howTo: "Return -32602 when a client calls a tool name you do not have.",
    owner: "server",
    spec: coreSpec("2026-07-28", TOOLS, "error-handling"),
    stage: "stable",
    lifecycle: {},
    optional: false,
    assessment: { primary: "checked" },
  },
  {
    id: "tool-results.result-type",
    family: "tool-results",
    name: "resultType",
    summary:
      "Every 2026-07-28 result says whether it is complete or needs input.",
    howTo:
      "Set resultType to complete on every result. SDKs for 2026-07-28 set it for you.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/index", "resulttype"),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: RESULT_OBSERVED,
  },
  {
    id: "tool-results.result-meta",
    family: "tool-results",
    name: "Result _meta",
    summary: "Metadata on a result for clients and extensions.",
    howTo:
      "Put namespaced keys in a result's _meta when a client or extension reads them.",
    owner: "server",
    spec: coreSpec("2026-07-28", "basic/index", "meta"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: RESULT_OBSERVED,
  },
];
