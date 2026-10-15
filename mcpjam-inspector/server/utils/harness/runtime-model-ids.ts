/**
 * The model id each brokered harness puts on the wire: the Gateway spelling
 * of a host model id, or, on the organization's own key, the native id its
 * lease admits — plus the Claude Code env pins that keep the CLI's own model
 * choices inside that lease.
 */
import type { HarnessUpstreamProfile } from "@/shared/harness-model-support";

/** The native upstream a turn's lease was minted for (non-secret). */
export type HarnessNativeUpstream = {
  profile: HarnessUpstreamProfile;
  /** The native model id the lease admits (`claude-sonnet-4-5`, `gpt-5`). */
  nativeModelId: string;
};

/** Map a host model id (Gateway `creator/model`, e.g.
 *  `anthropic/claude-opus-4.7`) to a Claude Code native model id. Haiku is the
 *  exception: Claude Code accepts the `haiku` alias as a main model, but rejects
 *  `claude-haiku-4-5` as a selectable main model. The patched bridge adds
 *  `settings.modelOverrides` so aliases/native ids still talk to the Gateway
 *  provider-specific id on the wire. */
export function toClaudeCodeModel(modelId: string): string | undefined {
  const m = modelId.toLowerCase();
  const withoutProvider = m.startsWith("anthropic/")
    ? m.slice("anthropic/".length)
    : m;
  // Trailing 8-digit date absorbs an optional dated/pinned snapshot suffix
  // (e.g. "claude-haiku-4-5-20251001", the exact shape Claude Code's own
  // internal alias resolution can produce on the wire — see the bridge's
  // modelOverrides keys below) without being captured; the return value only
  // ever depends on family/major/minor, same as the undated shape. The
  // alternation tries the bare "major + date, no minor" shape FIRST
  // (-\d{8}) — a plain (?:-\d+)? suffix here is wrong: the earlier optional
  // minor group's greedy \d+ swallows the date digits as if they were a
  // minor version (e.g. "claude-opus-4-20250929" -> minor="20250929"),
  // producing an invalid native model string instead of "claude-opus-4".
  const match = withoutProvider.match(
    /^claude-(haiku|sonnet|opus)-(\d+)(?:-\d{8}|[.-](\d+)(?:-\d{8})?)?$/,
  );
  if (match) {
    const [, family, major, minor] = match;
    // Claude Code accepts "haiku" as a selectable main model but rejects the
    // native shape ("claude-haiku-4-5") — only THIS shortcut needs the alias;
    // gated on the regex match so it can't fire for a non-Anthropic or
    // malformed id that merely contains "haiku" as a substring.
    if (family === "haiku") return "haiku";
    return `claude-${family}-${major}${minor ? `-${minor}` : ""}`;
  }
  if (
    withoutProvider === "haiku" ||
    withoutProvider === "sonnet" ||
    withoutProvider === "opus"
  ) {
    return withoutProvider;
  }
  // Another Anthropic model (the evidence table's `unknown` row: no native id
  // verified). Playground chat may still run it with a warning, and then the
  // honest attempt is the model's own id — passing nothing would let the CLI
  // silently run its DEFAULT model under this model's name. Evals and swarms
  // never get here: they refuse an unverified pair before the turn starts.
  if (m.startsWith("anthropic/") && /^claude-[a-z0-9.-]+$/.test(withoutProvider)) {
    return withoutProvider;
  }
  return undefined;
}

/**
 * Claude Code's main model. On the organization's own Anthropic key `haiku`
 * stays the alias (the CLI refuses the native Haiku id as a main model) and
 * is pinned to the leased id by the turn env; any other family runs the
 * leased native id itself, dated or not.
 */
export function toClaudeCodeNativeModel(
  modelId: string,
  upstream?: HarnessNativeUpstream,
): string | undefined {
  const gateway = toClaudeCodeModel(modelId);
  return upstream?.profile === "anthropic-native" && gateway !== "haiku"
    ? upstream.nativeModelId
    : gateway;
}

/** Map a host model id to a Codex-native OpenAI model. ALLOWLIST, not a blanket
 *  `openai/` strip: only the gpt-5 family (what Codex CLI runs) passes through;
 *  anything else ⇒ undefined so Codex uses its own pinned default rather than
 *  being forced onto a model it can't run. Whether a mapped model is actually
 *  RUN is the evidence table's call ({@link modelSupportFor}), so a line the
 *  pinned CLI runs without tools is refused by the preflight, not dropped
 *  here. */
export function toCodexModel(modelId: string): string | undefined {
  if (!modelId.toLowerCase().startsWith("openai/")) return undefined;
  const slug = modelId.slice("openai/".length);
  if (!/^gpt-5/i.test(slug)) return undefined;
  return slug;
}


/**
 * The model Codex runs: on the organization's own OpenAI key the leased native
 * id (the custom provider still points at MCPJam's proxy, with a placeholder
 * credential); otherwise the gpt-5 slug of the canonical id.
 */
export function toCodexNativeModel(
  modelId: string,
  upstream?: HarnessNativeUpstream,
): string | undefined {
  return upstream?.profile === "openai-native"
    ? upstream.nativeModelId
    : toCodexModel(modelId);
}


/**
 * The native-profile pins: on the organization's own Anthropic key, EVERY
 * model Claude Code reaches for on its own — each family alias (plan mode's
 * `sonnet`, background work's and the `Explore` subagent's `haiku`), the small
 * fast model and a subagent's model — resolves to the leased NATIVE id, and
 * the bridge's Gateway model overrides are switched off
 * (`MCPJAM_HARNESS_UPSTREAM_PROFILE`).
 *
 * Unlike the Gateway pins the chosen family's alias is pinned too: with no
 * Gateway override in between, the CLI would otherwise put its own default
 * (often a dated snapshot) on the wire, which an org lease's exact allowlist
 * refuses. The backend rewrites every body to the admitted model regardless;
 * these pins are what keep the CLI's own calls inside the lease.
 */
export function claudeCodeNativeModelPins(native: string): Record<string, string> {
  return {
    MCPJAM_HARNESS_UPSTREAM_PROFILE: "anthropic-native",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: native,
    ANTHROPIC_DEFAULT_SONNET_MODEL: native,
    ANTHROPIC_DEFAULT_OPUS_MODEL: native,
    ANTHROPIC_SMALL_FAST_MODEL: native,
    CLAUDE_CODE_SUBAGENT_MODEL: native,
  };
}
