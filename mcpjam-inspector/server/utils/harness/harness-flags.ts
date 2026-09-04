/**
 * Harness feature flags shared by the pre-stream availability check and the
 * turn executor. Lives in its own module so `harness-availability.ts` can read
 * the broker flag without importing `run-harness-turn.ts` (import cycle).
 */

/**
 * Inspector-side gate for E2B header-broker credential delivery.
 *
 * KILL SWITCH, default ON (COMP-23): the broker is the ONLY credential path —
 * the raw-key client path (`fetchHarnessModelCredential` → backend
 * `/web/harness/model-credential`) was removed because it spent the system AI
 * Gateway key with zero metering. Setting `MCPJAM_HARNESS_BROKER_DELIVERY=false`
 * makes harness runs UNAVAILABLE with an honest pre-stream error; it never
 * falls back to a raw key (there is none to fall back to).
 */
export function harnessBrokerDeliveryEnabled(): boolean {
  return process.env.MCPJAM_HARNESS_BROKER_DELIVERY !== "false";
}

/**
 * Opt-in gate for the direct `codex app-server` transport.
 *
 * OFF BY DEFAULT, unlike the broker kill switch above — this one turns a
 * capability ON. With it set, `getHarnessAdapter("codex")` returns MCPJam's own
 * app-server adapter instead of the published `codex exec` one. The harness id
 * does not change; the protocol underneath it does.
 *
 * What flipping it buys, and why it is worth a flag at all: the exec transport
 * cannot pause for tool approval on any surface (its bridge hardcodes
 * `approvalPolicy: "never"`), so an approval-gated Codex host is refused
 * outright today. The app-server transport can. Until the parity suite is green
 * the safe default is the transport that has been in production.
 *
 * The turn's runtime fingerprint folds the transport in, so flipping this forks
 * live sessions rather than resuming a conversation onto a different protocol.
 */
export function codexAppServerTransportEnabled(): boolean {
  return process.env.MCPJAM_CODEX_APPSERVER_TRANSPORT === "true";
}
