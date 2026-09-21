import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";

/**
 * THE display vocabulary for project environments.
 *
 * An environment row comes in two kinds. A NAMED row is one a human named: it
 * appears in the Environments list, it is editable, and its `name` is the label.
 * An AD-HOC row was materialized from a composition someone ran without picking
 * a saved environment — it has NO name by construction, is immutable, and is
 * deduped by a backend content fingerprint.
 *
 * Because half the rows have no name, `environment.name` must never be rendered
 * directly. Every surface calls {@link environmentLabel} instead, so a nameless
 * row degrades in ONE place rather than at each of the ~15 sites that used to
 * write `env.name ?? env.environmentId.slice(0, 8)` by hand.
 *
 * This module is deliberately pure and React-free: `swarm-targets.ts`,
 * `journey-environments.ts`, and `evals/helpers.ts` all need it and none of them
 * is a component. The React side of the same job — fetching the host and image
 * name maps without an N+1 — lives in `use-environment-label-context.ts`.
 */

export type ProjectEnvironmentOrigin = "named" | "adhoc";

/**
 * The row fields the label vocabulary reads. Structural rather than the full
 * {@link ProjectEnvironmentView} so callers holding a projection (a run
 * snapshot's target, a partially-selected row) can pass what they have.
 */
export type EnvironmentLabelRow = Pick<
  ProjectEnvironmentView,
  "environmentId" | "hostId"
> &
  Partial<
    Pick<
      ProjectEnvironmentView,
      | "name"
      | "origin"
      | "serverAttachmentId"
      | "skillSelection"
      | "pluginVersionIds"
      | "computerEnvironmentId"
      | "modelId"
    >
  >;

export interface EnvironmentLabelContext {
  /**
   * Client-name lookup. `undefined` for a host that is no longer in the
   * project — the fallback chain depends on that distinction, exactly like
   * `buildSwarmRunTargets`, so do not coalesce to a placeholder inside it.
   *
   * OMIT the whole function on surfaces that never need it. A picker that only
   * labels an already-selected ad-hoc row — and never offers one — should not
   * pay two project-wide queries for a rare edge case; it passes `{}` and gets
   * the generic label below. `useEnvironmentLabelContext` supplies the real
   * lookup on surfaces that list ad-hoc rows for real.
   */
  hostName?: (hostId: string) => string | undefined;
  /** Absent when the computers flag is off or no loaded row pins an image. */
  imageName?: (imageId: string) => string | undefined;
  computersEnabled?: boolean;
  /** Catalog display name for a stored model override. Omit when unused. */
  modelName?: (modelId: string) => string | undefined;
}

/** Shown when a row's host has been deleted out from under it. */
const UNKNOWN_HOST_LABEL = "Unknown client";

/** Ad-hoc label where no client-name lookup is available. */
const GENERIC_ADHOC_LABEL = "Automatic environment";

/**
 * Trim, and treat whitespace-only as absent.
 *
 * Used instead of `??` everywhere a name is consumed. The distinction is
 * load-bearing at the run-snapshot boundary: `environmentRef.name` is typed as a
 * required string on the backend (it is baked into two historical run-snapshot
 * schemas), so an ad-hoc target may arrive carrying `""` rather than an absent
 * field. With `??` an empty string passes straight through and every matrix
 * column renders blank; with this, it falls through to the host name.
 */
export function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Which kind of row this is.
 *
 * Falls back to name-presence rather than assuming, so this is correct in both
 * skew directions: a backend that predates `origin` returns named rows with no
 * `origin` field (⇒ "named", which they are), and a row that somehow arrives
 * nameless without an origin still reads as ad-hoc rather than rendering blank.
 */
export function environmentOrigin(
  environment: EnvironmentLabelRow,
): ProjectEnvironmentOrigin {
  if (environment.origin === "named" || environment.origin === "adhoc") {
    return environment.origin;
  }
  return trimOrUndefined(environment.name) ? "named" : "adhoc";
}

export function isNamedEnvironment(environment: EnvironmentLabelRow): boolean {
  return environmentOrigin(environment) === "named";
}

export function isAdhocEnvironment(environment: EnvironmentLabelRow): boolean {
  return environmentOrigin(environment) === "adhoc";
}

/**
 * The ONE display label for an environment.
 *
 * Named rows label as their name. Ad-hoc rows label as their client's name,
 * because that is the only human-meaningful thing a composition carries — which
 * means ad-hoc labels COLLIDE by design (every ad-hoc row on one client reads
 * the same). Any surface listing more than one must run the result through
 * {@link disambiguateLabels}.
 */
export function environmentLabel(
  environment: EnvironmentLabelRow,
  ctx: EnvironmentLabelContext = {},
): string {
  const name = trimOrUndefined(environment.name);
  if (name) return name;
  // No lookup supplied ⇒ this surface doesn't list ad-hoc rows and shouldn't
  // pay for the host query. "Unknown client" would be a lie there; it means
  // "the host was deleted", which we cannot know without the lookup.
  if (!ctx.hostName) return GENERIC_ADHOC_LABEL;
  const host =
    trimOrUndefined(ctx.hostName(environment.hostId)) ?? UNKNOWN_HOST_LABEL;
  const modelId = trimOrUndefined(environment.modelId);
  if (!modelId) return host;
  const model =
    trimOrUndefined(ctx.modelName?.(modelId)) ?? compactModelIdTail(modelId);
  return `${host} · ${model}`;
}

/** Segment after the last `/` — mirrors backend `environmentLabel`. */
export function compactModelIdTail(modelId: string): string {
  const trimmed = modelId.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** `"Server group attached"` vs `"Client's own servers"`. */
export function describeServerScope(environment: EnvironmentLabelRow): string {
  return environment.serverAttachmentId
    ? "Server group attached"
    : "Client's own servers";
}

/**
 * Pinned skill / plugin counts.
 *
 * These are honest row data — `skillSelection.skillIds` is the explicit pinned
 * selection and `pluginVersionIds` are pinned version ids, both stored and
 * exact. They are labeled as PINS, never as totals, because the host and plugin
 * channels contribute more skills at resolve time.
 */
export function environmentPinCounts(environment: EnvironmentLabelRow): {
  skillPins: number;
  pluginPins: number;
  /**
   * How many of `skillPins` are held at an EXACT revision rather than tracking
   * Latest (Versioned Skills). Reported separately because the difference is
   * the whole point of a pin: an environment at "3 skills, 1 at an exact
   * version" behaves differently on the next edit than one tracking Latest
   * throughout, and a single count hides that.
   */
  skillVersionPins: number;
} {
  return {
    skillPins: environment.skillSelection?.skillIds.length ?? 0,
    pluginPins: environment.pluginVersionIds?.length ?? 0,
    skillVersionPins: environment.skillSelection?.versionPins?.length ?? 0,
  };
}

/**
 * The sandbox-image chip text, or `undefined` when no chip should render.
 *
 * Absence is semantic (the provider default image), so an unpinned row shows
 * nothing rather than a filler label. A pinned image the images query hasn't
 * resolved — or one that was deleted — degrades to a truncated raw id, never a
 * silent blank.
 */
export function environmentImageLabel(
  environment: EnvironmentLabelRow,
  ctx: EnvironmentLabelContext,
): string | undefined {
  if (!ctx.computersEnabled) return undefined;
  const imageId = environment.computerEnvironmentId;
  if (!imageId) return undefined;
  return (
    trimOrUndefined(ctx.imageName?.(imageId)) ?? `image ${imageId.slice(0, 8)}…`
  );
}

/**
 * The composition line as a plain string — server scope, pin counts, and the
 * image chip, joined with the same ` · ` separator the cards use.
 *
 * Note what is NOT here: a resolved server count. The row stores a
 * `serverAttachmentId` (a scope), not a server set; the real set folds in the
 * host's own picks and any plugin-contributed servers, both LIVE. Printing a
 * number would mean either lying or paying one resolve round trip PER ROW — an
 * N+1 on a list that renders on every visit. The count belongs in the
 * Playground, where exactly one environment is resolved for real.
 *
 * `EnvironmentSummaryLine` renders the same content as JSX (so the image chip
 * can carry its tooltip); both compose the helpers above so they cannot drift.
 */
export function environmentDetailLine(
  environment: EnvironmentLabelRow,
  ctx: EnvironmentLabelContext,
): string {
  const { skillPins, pluginPins } = environmentPinCounts(environment);
  const parts = [
    describeServerScope(environment),
    `${skillPins} skill pin${skillPins === 1 ? "" : "s"}`,
    `${pluginPins} plugin pin${pluginPins === 1 ? "" : "s"}`,
  ];
  const imageLabel = environmentImageLabel(environment, ctx);
  if (imageLabel) parts.push(imageLabel);
  return parts.join(" · ");
}

/**
 * Suffix duplicate labels with a stable `#n` (collision groups only; unique
 * labels are returned untouched).
 *
 * Moved here from `swarm-targets.ts`, where it was module-private, because
 * ad-hoc rows make collisions the NORM rather than the exception: every ad-hoc
 * row on one client derives the same label.
 */
export function disambiguateLabels<T extends { label: string }>(
  items: readonly T[],
): T[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return items.map((item) => {
    if ((counts.get(item.label) ?? 0) <= 1) return item;
    const n = (seen.get(item.label) ?? 0) + 1;
    seen.set(item.label, n);
    return { ...item, label: `${item.label} #${n}` };
  });
}
