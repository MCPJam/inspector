/**
 * Which sampling parameters a model accepts, keyed off the model id string.
 *
 * Deliberately import-free so it is safe from every entrypoint — the browser
 * bundle, the worker, and `HostRunner` on the request path all reach it without
 * pulling in a provider SDK.
 */

/**
 * Claude families that removed the sampling parameters. Anthropic rejects
 * `temperature` (and `top_p` / `top_k`) with a 400 on Opus 4.7 and later,
 * Sonnet 5, Fable 5, and Mythos 5; earlier families (Opus 4.6, Sonnet 4.5,
 * Haiku 4.5, ...) still accept them. Bedrock serves the same models through
 * the same request surface, so an inference profile for one of these families
 * fails identically.
 *
 * Expressed as a per-family "removed from this version onward" threshold rather
 * than a list of exact ids: the removal is monotonic within a family, so
 * enumerating versions would silently regress the moment Opus 4.9 ships. A
 * family with no entry here (Haiku) has not dropped the parameters in any
 * released version, and gets no forward guess.
 */
const TEMPERATURE_REMOVED_FROM_VERSION: Record<
  string,
  { major: number; minor: number }
> = {
  opus: { major: 4, minor: 7 },
  sonnet: { major: 5, minor: 0 },
  fable: { major: 5, minor: 0 },
  mythos: { major: 5, minor: 0 },
};

/**
 * Family and version out of a model id. Matched as a substring because the same
 * model reaches us under four id shapes: hosted ("anthropic/claude-opus-4.7"), a
 * Bedrock inference profile ("us.anthropic.claude-opus-4-7-20260205-v1:0"), a
 * Bedrock ARN, and bare ("claude-sonnet-5"). Dots are folded to dashes before
 * matching so the hosted and Bedrock spellings of a version agree.
 *
 * The minor group is capped at two digits so the release date that follows a
 * bare major on Bedrock ("claude-opus-4-20250514-v1:0") is not read as one.
 *
 * Known gap: a Bedrock *application* inference profile or provisioned-throughput
 * ARN names an opaque resource id rather than the model, so there is nothing
 * here to match and the caller gets `false`. Resolving those needs a Bedrock API
 * call, which this module deliberately cannot make.
 */
const CLAUDE_FAMILY_VERSION_PATTERN =
  /(?:^|[^a-z0-9])claude-(opus|sonnet|haiku|fable|mythos)-([0-9]+)(?:-([0-9]{1,2})(?![0-9]))?/;

/**
 * True when the model rejects a `temperature` request field. Callers must omit
 * the field entirely rather than sending a default — a `temperature: undefined`
 * still serializes the key.
 */
export const modelRejectsTemperature = (modelId: string): boolean => {
  const match = CLAUDE_FAMILY_VERSION_PATTERN.exec(
    String(modelId).toLowerCase().replace(/\./g, "-")
  );
  if (!match) return false;

  const threshold = TEMPERATURE_REMOVED_FROM_VERSION[match[1]];
  if (!threshold) return false;

  const major = Number(match[2]);
  // A bare major ("claude-sonnet-5") is that family's .0 release.
  const minor = match[3] === undefined ? 0 : Number(match[3]);
  return (
    major > threshold.major ||
    (major === threshold.major && minor >= threshold.minor)
  );
};
