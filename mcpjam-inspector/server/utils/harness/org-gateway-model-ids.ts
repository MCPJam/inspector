/**
 * The model ids a harness runtime uses on the organization's gateway
 * (`org-gateway`): the leased id exactly as the gateway names it
 * (`claude-haiku-4-5`, `anthropic/claude-haiku-4-5`, `house-model`). MCPJam's
 * Gateway profile spells Claude ids `anthropic/claude-<family>-<major>.<minor>`
 * and the vendor-native profile hyphenates versions; neither applies to a
 * gateway's own names, and the model proxy rewrites every request to the
 * leased name whatever the runtime sends.
 */

/** A Claude Haiku id, bare or vendor-prefixed. */
const CLAUDE_HAIKU_ID = /^(?:anthropic\/)?claude-haiku-\d/i;

/**
 * Claude Code's main model: the leased id, except that a Haiku id runs as the
 * `haiku` alias, which the turn env pins to it. The CLI refuses a Haiku id as
 * its main model but accepts the alias.
 */
export function claudeCodeOrgGatewayModel(leased: string): string {
  return CLAUDE_HAIKU_ID.test(leased) ? "haiku" : leased;
}

/**
 * Every model Claude Code reaches for on its own (each family alias, the
 * small fast model, a subagent's model) resolves to the leased id, and the
 * profile switches off the bridge's Gateway model overrides
 * (`MCPJAM_HARNESS_UPSTREAM_PROFILE`), which would rewrite a Claude id to the
 * Gateway's spelling. Adaptive thinking and effort stay as on the
 * vendor-native profile (`claudeCodeAdapter.createHarness`).
 */
export function claudeCodeOrgGatewayPins(
  leased: string,
): Record<string, string> {
  return {
    MCPJAM_HARNESS_UPSTREAM_PROFILE: "org-gateway",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: leased,
    ANTHROPIC_DEFAULT_SONNET_MODEL: leased,
    ANTHROPIC_DEFAULT_OPUS_MODEL: leased,
    ANTHROPIC_SMALL_FAST_MODEL: leased,
    CLAUDE_CODE_SUBAGENT_MODEL: leased,
  };
}

/**
 * OpenCode's `provider/model`: its Anthropic provider, which points at the
 * model proxy on every lease, then the leased id. OpenCode splits on the
 * first `/`, so a gateway name with its own vendor prefix reaches the wire
 * whole (`anthropic/anthropic/claude-haiku-4-5` sends
 * `anthropic/claude-haiku-4-5`).
 */
export function openCodeOrgGatewayModel(leased: string): string {
  return `anthropic/${leased}`;
}
