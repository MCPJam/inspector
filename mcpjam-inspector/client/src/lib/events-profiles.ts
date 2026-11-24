/**
 * Specification links for the Events profiles shown in Inspector.
 *
 * Only the label and the link live here. Which delivery modes a subscription
 * may use is decided by the client's saved config and the shared SDK check
 * (`subscribableModes` in `@mcpjam/sdk`), not by a profile; the conformance
 * profiles stay in the SDK, where they judge servers.
 */

/** The commit date of the pinned draft in {@link EVENTS_DRAFT_SOURCE_URL}: how the UI names it. */
export const EVENTS_DRAFT_DATE = "2026-09-04";

export const EVENTS_DRAFT_SOURCE_URL =
  "https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/28ec35e905daa241f019981e2836b4a02f1c0368/docs/design-sketch-proposal.md";

export const EVENTS_BETA_SOURCE_URL =
  "https://github.com/modelcontextprotocol/ext-events/blob/c77b84395eff0ae32f53b0516c2214fe276ed050/specification/beta/events/events.mdx";
