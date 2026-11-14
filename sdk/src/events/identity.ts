/**
 * MCP Events identities (contract C2, `docs/plans/mcp-events-contracts.md`).
 *
 * Every identity here has ONE purpose, and none of them is a credential:
 *
 *   - `bindingKey`  — server + the specific account whose credentials a
 *                     subscription uses, fixed for the subscription's life;
 *   - `deliveryKey` — dedupe on arrival, per (tenant, binding, logical
 *                     subscription, eventId). `eventId` alone is NOT unique:
 *                     the draft lets servers reuse upstream ids, and two
 *                     servers routinely emit the same one;
 *   - `controlKey`  — dedupe for control envelopes, which carry a
 *                     `webhook-id` and no `eventId`;
 *   - `runKey`      — dedupe for executions, per trigger, with a namespace so
 *                     a simulated or replayed event can never collide with —
 *                     or suppress — a live run.
 *
 * Hashing is canonical JSON + SHA-256 (the evaluation contract's primitive),
 * synchronous on purpose: the Convex enqueue mutation recomputes `runKey` and
 * cannot await Web Crypto. The inbox Worker and `convex/lib/eventIdentity.ts`
 * mirror these functions; both pin the digests asserted in
 * `__tests__/identity.test.ts`, so a drift fails on whichever side moved.
 */

import { canonicalJson, sha256Hex } from "../contract/canonical.js";

export type EventRunNamespace = "live" | "simulation" | `replay:${string}`;

export interface EventBinding {
  serverId: string;
  credentialOwnerUserId: string;
  /** Fingerprint of the upstream account (e.g. hashed OAuth `sub`), when known. */
  credentialFingerprint: string | null;
}

export interface EventTenant {
  projectId: string;
  environmentId: string | null;
}

function digest(value: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(value));
}

export function computeBindingKey(binding: EventBinding): string {
  return digest({
    v: 1,
    kind: "binding",
    serverId: binding.serverId,
    credentialOwnerUserId: binding.credentialOwnerUserId,
    credentialFingerprint: binding.credentialFingerprint,
  });
}

export interface DeliveryKeyInput extends EventTenant {
  bindingKey: string;
  logicalSubscriptionId: string;
  eventId: string;
}

export function computeDeliveryKey(input: DeliveryKeyInput): string {
  return digest({
    v: 1,
    kind: "delivery",
    projectId: input.projectId,
    environmentId: input.environmentId,
    bindingKey: input.bindingKey,
    logicalSubscriptionId: input.logicalSubscriptionId,
    eventId: input.eventId,
  });
}

export interface ControlKeyInput extends EventTenant {
  bindingKey: string;
  logicalSubscriptionId: string;
  webhookId: string;
}

export function computeControlKey(input: ControlKeyInput): string {
  return digest({
    v: 1,
    kind: "control",
    projectId: input.projectId,
    environmentId: input.environmentId,
    bindingKey: input.bindingKey,
    logicalSubscriptionId: input.logicalSubscriptionId,
    webhookId: input.webhookId,
  });
}

export interface RunKeyInput extends DeliveryKeyInput {
  namespace: EventRunNamespace;
  triggerId: string;
}

export function computeRunKey(input: RunKeyInput): string {
  return digest({
    v: 1,
    kind: "run",
    namespace: input.namespace,
    projectId: input.projectId,
    environmentId: input.environmentId,
    bindingKey: input.bindingKey,
    logicalSubscriptionId: input.logicalSubscriptionId,
    triggerId: input.triggerId,
    eventId: input.eventId,
  });
}

/**
 * Canonical-JSON equality for subscription `arguments` — the draft compares
 * the subscription key's `arguments` component this way, so object key order
 * never creates a second subscription.
 */
export function computeArgumentsHash(args: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(args));
}

/** A digest of an event descriptor, used to version payload validation. */
export function computeDescriptorHash(descriptor: unknown): string {
  return sha256Hex(canonicalJson(descriptor));
}
