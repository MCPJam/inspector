/**
 * Families 15 and 16: Multi Round-Trip Requests and Subscriptions. Almost
 * everything here is runtime behavior, seen in use or tested by Run checks.
 */

import type { FeatureDefinition } from "../../types.js";
import { coreSpec } from "../spec-refs.js";
import { lifecycle, promisedFlag } from "./rules.js";

const MRTR = "basic/patterns/mrtr";
const MRTR_SERVER = "server-requirements-basic-workflow";
const SUBSCRIPTIONS = "basic/patterns/subscriptions";
const MODERN = lifecycle({ introduced: "2026-07-28" });

export const MRTR_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "mrtr.input-required",
    family: "mrtr",
    name: "InputRequiredResult (input_required)",
    summary:
      "A request pauses with resultType input_required so the client can collect input and retry.",
    howTo:
      "Return input_required with inputRequests from tools/call, resources/read or prompts/get when you need the user. Use the server in Playground to see it.",
    owner: "server",
    spec: coreSpec("2026-07-28", MRTR),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "mrtr.supported-requests",
    family: "mrtr",
    name: "Only on tools/call, resources/read and prompts/get",
    summary:
      "Input requests are allowed on these three methods and nowhere else.",
    howTo:
      "Return input_required only from tools/call, resources/read or prompts/get.",
    owner: "server",
    spec: coreSpec("2026-07-28", MRTR, "supported-requests"),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: { primary: "observed" },
  },
  {
    id: "mrtr.input-request-types",
    family: "mrtr",
    name: "Input request types",
    summary:
      "The server asks for elicitation, sampling or roots inside inputRequests instead of sending its own requests.",
    howTo:
      "Put elicitation/create, sampling/createMessage or roots/list entries in inputRequests.",
    owner: "server",
    spec: coreSpec("2026-07-28", MRTR, MRTR_SERVER),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "mrtr.request-state",
    family: "mrtr",
    name: "requestState",
    summary:
      "Opaque state the client sends back on retry, so the server can resume without storing anything.",
    howTo:
      "Return requestState with input_required and protect it with a MAC or encryption so clients cannot change it.",
    owner: "server",
    spec: coreSpec("2026-07-28", MRTR, MRTR_SERVER),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "mrtr.load-shedding",
    family: "mrtr",
    name: "Load shedding with requestState",
    summary:
      "A busy server returns only requestState, and the client retries later with it.",
    howTo:
      "Return input_required with requestState and no inputRequests when you want the client to retry later.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "inputrequiredresult"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "mrtr.declared-capabilities-only",
    family: "mrtr",
    name: "Input requests match client capabilities",
    summary:
      "The server asks only for input the client declared it can provide.",
    howTo:
      "Check the request's clientCapabilities before adding an input request, and return -32021 when one is missing.",
    owner: "server",
    spec: coreSpec("2026-07-28", MRTR, MRTR_SERVER),
    stage: "stable",
    lifecycle: MODERN,
    optional: false,
    assessment: { primary: "checked" },
  },
  {
    id: "mrtr.input-meta",
    family: "mrtr",
    name: "_meta on input requests and responses",
    summary:
      "Input requests and responses carry their own _meta. Only the draft revision after 2026-07-28 allows it.",
    howTo:
      "Add _meta to sampling, elicitation and roots input requests when you need to pass metadata through.",
    owner: "server",
    spec: coreSpec("draft", MRTR),
    stage: "experimental",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
];

export const SUBSCRIPTION_FEATURES: readonly FeatureDefinition[] = [
  {
    id: "subscriptions.resources-subscribe",
    family: "subscriptions",
    name: "resources.subscribe capability",
    summary: "The server can tell the client when a specific resource changes.",
    howTo:
      "Declare resources.subscribe and send notifications/resources/updated when a subscribed resource changes.",
    owner: "server",
    spec: coreSpec("2026-07-28", "server/resources", "capabilities"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: {
      primary: "declared",
      observable: true,
      declared: promisedFlag("resources", "subscribe", "a resource update"),
    },
  },
  {
    id: "subscriptions.legacy-subscribe",
    family: "subscriptions",
    name: "resources/subscribe and resources/unsubscribe",
    summary: "The client subscribes to one resource URI and later stops.",
    howTo:
      "Handle resources/subscribe and resources/unsubscribe and remember each URI per session.",
    owner: "server",
    spec: coreSpec("2025-11-25", "server/resources", "subscriptions"),
    stage: "stable",
    lifecycle: lifecycle({ removed: "2026-07-28" }),
    optional: true,
    assessment: { primary: "checked", observable: true },
  },
  {
    id: "subscriptions.resource-updated",
    family: "subscriptions",
    name: "notifications/resources/updated",
    summary:
      "Tells a subscribed client that a resource changed so it can read it again.",
    howTo:
      "Send notifications/resources/updated with the resource URI after it changes.",
    owner: "server",
    spec: coreSpec("2026-07-28", "server/resources", "subscriptions"),
    stage: "stable",
    lifecycle: {},
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "subscriptions.listen",
    family: "subscriptions",
    name: "subscriptions/listen",
    summary:
      "Opens one stream the client keeps open for list changes and resource updates.",
    howTo:
      "Implement subscriptions/listen and keep the stream open until the client cancels it. Use Run checks to test it.",
    owner: "server",
    spec: coreSpec("2026-07-28", SUBSCRIPTIONS, "opening-a-stream"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "checked", observable: true },
  },
  {
    id: "subscriptions.acknowledged",
    family: "subscriptions",
    name: "Subscription acknowledgment",
    summary:
      "The server confirms which requested notifications it will send before it sends any.",
    howTo:
      "Send notifications/subscriptions/acknowledged with the subset you honor before any other notification.",
    owner: "server",
    spec: coreSpec("2026-07-28", SUBSCRIPTIONS, "acknowledgment"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "checked", observable: true },
  },
  {
    id: "subscriptions.subscription-id",
    family: "subscriptions",
    name: "Subscription ID tagging",
    summary:
      "Every notification on a listen stream carries the subscription's id, so the client can route it.",
    howTo:
      "Add io.modelcontextprotocol/subscriptionId to the _meta of each notification you send on the stream.",
    owner: "server",
    spec: coreSpec("2026-07-28", "schema", "notificationmetaobject"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "checked", observable: true },
  },
  {
    id: "subscriptions.list-changed-on-stream",
    family: "subscriptions",
    name: "list_changed on the listen stream",
    summary:
      "Tool, prompt and resource list changes arrive on the subscription stream.",
    howTo:
      "Send list_changed notifications on each open listen stream that asked for them.",
    owner: "server",
    spec: coreSpec("2026-07-28", SUBSCRIPTIONS, "receiving-notifications"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "subscriptions.stream-end",
    family: "subscriptions",
    name: "Stream end",
    summary:
      "The server closes a subscription gracefully, or sends cancelled on stdio, when it stops.",
    howTo:
      "Return the subscriptions/listen result when you end a stream, and send notifications/cancelled on stdio.",
    owner: "server",
    spec: coreSpec("2026-07-28", SUBSCRIPTIONS, "graceful-closure"),
    stage: "stable",
    lifecycle: MODERN,
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
  {
    id: "subscriptions.legacy-delivery",
    family: "subscriptions",
    name: "Notifications on open streams (2025)",
    summary:
      "On 2025 revisions the server sends list changes and updates on the GET stream or any open stream.",
    howTo:
      "Send notifications on the standalone GET stream or on a request stream that is still open.",
    owner: "server",
    spec: coreSpec(
      "2025-11-25",
      "basic/transports",
      "listening-for-messages-from-the-server"
    ),
    stage: "stable",
    lifecycle: lifecycle({ introduced: "2025-03-26", removed: "2026-07-28" }),
    optional: true,
    assessment: { primary: "observed", observable: true },
  },
];
