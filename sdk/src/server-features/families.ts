/**
 * The 24 feature families and the eight cards that hold them, named after the
 * MCP specification's own sections (product spec v0.4, "Catalog").
 */

import {
  FEATURE_CARD_IDS,
  type FeatureCardId,
  type FeatureFamilyDefinition,
  type FeatureFamilyId,
} from "./types.js";

export const FEATURE_CARD_NAMES = {
  "server-info": "Server info",
  "base-protocol": "Base Protocol",
  "server-features": "Server Features",
  "server-utilities": "Server Utilities",
  "client-features": "Client Features",
  authorization: "Authorization",
  extensions: "Extensions",
  "third-party": "Third-party and experimental",
} as const satisfies Record<FeatureCardId, string>;

const FAMILY_TABLE = {
  "server-information": {
    card: "server-info",
    name: "Server information",
    summary: "Name, version, title, icons and instructions the server reports.",
  },
  "lifecycle-discovery": {
    card: "base-protocol",
    name: "Lifecycle and Discovery",
    summary:
      "How client and server agree on a protocol version and exchange capabilities.",
  },
  transports: {
    card: "base-protocol",
    name: "Transports",
    summary: "How messages travel: stdio, Streamable HTTP or the older HTTP+SSE.",
  },
  "transport-behavior": {
    card: "base-protocol",
    name: "Transport behavior",
    summary:
      "Sessions, headers, streams and response modes on the HTTP transport.",
  },
  mrtr: {
    card: "base-protocol",
    name: "Multi Round-Trip Requests",
    summary:
      "Requests that pause with input_required so the client can ask the user.",
  },
  subscriptions: {
    card: "base-protocol",
    name: "Subscriptions",
    summary: "Change notifications for lists and resources.",
  },
  "tools-discovery": {
    card: "server-features",
    name: "Tools",
    summary: "Listing tools and describing them to clients and models.",
  },
  "tool-annotations-schemas": {
    card: "server-features",
    name: "Tool annotations and schemas",
    summary: "Behavior hints and the input and output schemas of each tool.",
  },
  "tool-results": {
    card: "server-features",
    name: "Tool results and content",
    summary: "Content types, structured content and errors in tool results.",
  },
  resources: {
    card: "server-features",
    name: "Resources",
    summary: "Data the server exposes for clients to read.",
  },
  "resource-templates": {
    card: "server-features",
    name: "Resource templates and changes",
    summary: "Parameterized resource URIs and resource change notifications.",
  },
  prompts: {
    card: "server-features",
    name: "Prompts",
    summary: "Reusable prompt templates users can pick.",
  },
  completion: {
    card: "server-utilities",
    name: "Completion",
    summary: "Argument suggestions for prompts and resource templates.",
  },
  "pagination-caching": {
    card: "server-utilities",
    name: "Pagination and caching",
    summary: "Cursors for long lists and cache hints on results.",
  },
  "request-control": {
    card: "server-utilities",
    name: "Progress, cancellation and logging",
    summary: "Progress updates, cancellation, ping and log messages.",
  },
  "client-features": {
    card: "client-features",
    name: "Roots, sampling and elicitation",
    summary: "Requests a server makes back to the client.",
  },
  "core-authorization": {
    card: "authorization",
    name: "Authorization",
    summary: "OAuth for HTTP servers: metadata, registration, tokens.",
  },
  "authorization-extensions": {
    card: "authorization",
    name: "Authorization extensions",
    summary:
      "OAuth Client Credentials and Enterprise-Managed Authorization (XAA).",
  },
  "mcp-apps": {
    card: "extensions",
    name: "MCP Apps",
    summary: "Interactive HTML views that tools render inside the host.",
  },
  tasks: {
    card: "extensions",
    name: "Tasks",
    summary: "Long-running requests the client polls or cancels.",
  },
  skills: {
    card: "extensions",
    name: "Skills",
    summary: "Agent skills served as MCP resources.",
  },
  events: {
    card: "extensions",
    name: "Events",
    summary: "Event streams and webhooks a client can subscribe to.",
  },
  "server-cards": {
    card: "extensions",
    name: "Server Cards",
    summary: "A published card that describes the server before connecting.",
  },
  "third-party-experimental": {
    card: "third-party",
    name: "Third-party and experimental",
    summary:
      "OpenAI extensions, Apps SDK metadata, experimental proposals and unrecognized capabilities.",
  },
} as const satisfies Record<
  FeatureFamilyId,
  Omit<FeatureFamilyDefinition, "id">
>;

export const FEATURE_FAMILIES: readonly FeatureFamilyDefinition[] = (
  Object.keys(FAMILY_TABLE) as FeatureFamilyId[]
).map((id) => ({ id, ...FAMILY_TABLE[id] }));

export function featureFamily(id: FeatureFamilyId): FeatureFamilyDefinition {
  return { id, ...FAMILY_TABLE[id] };
}

/** Families on one card, in display order. */
export function familiesForCard(
  card: FeatureCardId,
): readonly FeatureFamilyDefinition[] {
  return FEATURE_FAMILIES.filter((family) => family.card === card);
}

export const FEATURE_CARDS = FEATURE_CARD_IDS.map((id) => ({
  id,
  name: FEATURE_CARD_NAMES[id],
}));
