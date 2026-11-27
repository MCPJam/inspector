/**
 * Family 14: Roots, sampling and elicitation. Requests a server makes back to
 * the client. None has a server-side declaration, so every row is seen in use.
 * MCPJam does not advertise roots or sampling, so seeing one of those means
 * the server asked and MCPJam declined.
 */

import type { FeatureDefinition } from "../../types.js";
import { coreSpec } from "../spec-refs.js";
import { lifecycle } from "./rules.js";

const ELICITATION = "client/elicitation";
const OBSERVED = { primary: "observed", observable: true } as const;

export const CLIENT_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "client.roots",
    family: "client-features",
    name: "Roots (roots/list)",
    summary:
      "The server asks which directories or files the client allows it to work in.",
    howTo:
      "Send roots/list when you need the user's workspace, and handle a client that declines.",
    owner: "client",
    spec: coreSpec("2026-07-28", "client/roots"),
    stage: "stable",
    lifecycle: lifecycle({ deprecated: "2026-07-28" }),
    optional: true,
    assessment: OBSERVED,
  },
  {
    id: "client.roots-list-changed",
    family: "client-features",
    name: "notifications/roots/list_changed",
    summary: "The client tells the server that its roots changed.",
    howTo:
      "List roots again when you receive notifications/roots/list_changed.",
    owner: "client",
    spec: coreSpec("2025-11-25", "client/roots", "root-list-changes"),
    stage: "stable",
    lifecycle: lifecycle({ removed: "2026-07-28" }),
    optional: true,
    assessment: OBSERVED,
  },
  {
    id: "client.sampling",
    family: "client-features",
    name: "Sampling (sampling/createMessage)",
    summary:
      "The server asks the client's model for a completion, with the user able to review it.",
    howTo:
      "Send sampling/createMessage with messages, maxTokens and model preferences. Use the server in Playground to see the request.",
    owner: "client",
    spec: coreSpec("2026-07-28", "client/sampling"),
    stage: "stable",
    lifecycle: lifecycle({ deprecated: "2026-07-28" }),
    optional: true,
    assessment: OBSERVED,
  },
  {
    id: "client.sampling-tools",
    family: "client-features",
    name: "Sampling with tools",
    summary:
      "A sampling request offers tools and a toolChoice, so the client's model can call them.",
    howTo:
      "Add tools and toolChoice to sampling/createMessage when the client declares sampling.tools.",
    owner: "client",
    spec: coreSpec("2026-07-28", "client/sampling", "sampling-with-tools"),
    stage: "stable",
    lifecycle: lifecycle({
      introduced: "2025-11-25",
      deprecated: "2026-07-28",
    }),
    optional: true,
    assessment: OBSERVED,
  },
  {
    id: "client.include-context",
    family: "client-features",
    name: "includeContext (thisServer, allServers)",
    summary:
      "A sampling request asks the client to add context from this server or every connected server.",
    howTo:
      "Leave includeContext out or set it to none. The thisServer and allServers values are deprecated.",
    owner: "server",
    spec: coreSpec("2026-07-28", "deprecated"),
    stage: "stable",
    lifecycle: lifecycle({ deprecated: "2025-11-25" }),
    optional: true,
    assessment: OBSERVED,
  },
  {
    id: "client.elicitation",
    family: "client-features",
    name: "Elicitation",
    summary:
      "The server asks the user for information through the client, in a form or on a web page.",
    howTo:
      "Send elicitation/create when a tool needs the user's input. Use the server in Playground to answer it.",
    owner: "client",
    spec: coreSpec("2026-07-28", ELICITATION),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: { primary: "observed" },
  },
  {
    id: "client.elicitation-form",
    family: "client-features",
    parent: "client.elicitation",
    name: "Form elicitation",
    summary:
      "A form described by a flat JSON Schema the client renders for the user.",
    howTo:
      "Send elicitation/create with a message and a requestedSchema of primitive fields.",
    owner: "client",
    spec: coreSpec("2026-07-28", ELICITATION, "form-mode-elicitation-requests"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-06-18" }),
    optional: true,
    assessment: OBSERVED,
  },
  {
    id: "client.elicitation-url",
    family: "client-features",
    parent: "client.elicitation",
    name: "URL elicitation",
    summary:
      "The client opens a URL so the user can sign in or enter sensitive data outside the chat.",
    howTo:
      "Send elicitation/create with mode url when the user must act on a web page, such as a third-party sign-in.",
    owner: "client",
    spec: coreSpec("2026-07-28", ELICITATION, "url-mode-elicitation-requests"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: OBSERVED,
  },
  {
    id: "client.url-elicitation-required-error",
    family: "client-features",
    parent: "client.elicitation",
    name: "URL elicitation required error (-32042)",
    summary:
      "A request fails with -32042 and a URL the user must visit before retrying.",
    howTo:
      "Return -32042 with the elicitation URL when a request cannot continue until the user visits it.",
    owner: "server",
    spec: coreSpec("2025-11-25", "basic/index", "error-codes"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25", removed: "2026-07-28" }),
    optional: true,
    assessment: OBSERVED,
  },
  {
    id: "client.elicitation-complete",
    family: "client-features",
    parent: "client.elicitation",
    name: "notifications/elicitation/complete",
    summary:
      "The server tells the client that the user finished a URL elicitation, by its elicitationId.",
    howTo:
      "Send notifications/elicitation/complete with the elicitationId when the out-of-band step is done.",
    owner: "server",
    spec: coreSpec("2025-11-25", ELICITATION),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25", removed: "2026-07-28" }),
    optional: true,
    assessment: OBSERVED,
  },
  {
    id: "client.elicitation-schemas",
    family: "client-features",
    parent: "client.elicitation",
    name: "Enum and default values in forms",
    summary:
      "Form fields offer single or multiple choice enums with titles, and default values.",
    howTo:
      "Use enum or oneOf with titles for choices and set default on fields the user can accept as is.",
    owner: "server",
    spec: coreSpec("2026-07-28", ELICITATION, "requested-schema"),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-11-25" }),
    optional: true,
    assessment: OBSERVED,
  },
];
