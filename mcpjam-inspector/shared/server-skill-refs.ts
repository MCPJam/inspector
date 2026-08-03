/**
 * Runtime addressing for server-served skills (SEP-2640).
 *
 * SHARED because three surfaces must agree on the ref a skill is addressed
 * under, byte for byte:
 *   - `server/utils/server-skill-tools.ts`, which resolves the ref the model
 *     passes to `loadSkill`;
 *   - the playground SKILLS picker, which shows the ref and injects it;
 *   - the backend capture store, whose `serverSkills.ref` mirrors this rule.
 *
 * A mismatched slug — or a differently-ordered collision suffix — means the
 * picker shows `acme/refunds` and the chat tool resolves nothing, or worse,
 * resolves a DIFFERENT skill. That is the failure this module exists to make
 * impossible on the two TypeScript surfaces; the Convex mirror is pinned by
 * `tests/convex/serverSkills.test.ts`.
 *
 * ## Why the slug comes from OUR label
 *
 * The input is the label the USER gave the server in MCPJam, never
 * `serverInfo.name`. A server-controlled namespace would let one server squat
 * a sibling's refs — and a skill loaded under someone else's name is exactly
 * the confusion SEP-2640's per-origin namespacing exists to prevent.
 */

/** Slugifies a server LABEL into the ref namespace. */
export function slugifyServerLabel(label: string): string {
  const slug = String(label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  // A label that slugifies to nothing (all punctuation, or non-Latin) still
  // needs an addressable namespace; the uniquifier below disambiguates it.
  return slug.length > 0 ? slug : "server";
}

export interface ServerSlugAssignment<T> {
  server: T;
  serverSlug: string;
}

/**
 * Assigns a unique slug to each server, in the ORDER GIVEN.
 *
 * Order is part of the contract, not an implementation detail: two servers
 * labelled "Acme" get `acme` and `acme-2`, and which one is which depends
 * entirely on iteration order. Every caller must therefore feed servers in the
 * same order — both current callers derive theirs from the turn's selected
 * server list, which is stable.
 */
export function assignServerSlugs<T extends { serverLabel: string }>(
  servers: readonly T[]
): Array<ServerSlugAssignment<T>> {
  const taken = new Set<string>();
  return servers.map((server) => {
    const base = slugifyServerLabel(server.serverLabel);
    let slug = base;
    let suffix = 2;
    while (taken.has(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.add(slug);
    return { server, serverSlug: slug };
  });
}

/**
 * The runtime ref: `<serverSlug>/<name>`, or `<serverSlug>/<name>~<uriHash8>`
 * when the name is not unique WITHIN that server.
 *
 * The disambiguated form exists because SEP-2640 explicitly allows one server
 * to serve two skills with the same name — `acme/billing/refunds` and
 * `acme/support/refunds` are both `refunds`, and the URI is the identity.
 *
 * `~` is outside the Agent-Skills name charset, so a disambiguated ref can
 * never collide with an undisambiguated one.
 */
export function buildServerSkillRef(args: {
  serverSlug: string;
  name: string;
  disambiguator?: string;
}): string {
  return `${args.serverSlug}/${args.name}${
    args.disambiguator ? `~${args.disambiguator}` : ""
  }`;
}

/** Matches both ref forms. Used to tell a ref from a bare name or a URI. */
export const SERVER_SKILL_REF_RE = /^[a-z0-9-]+\/[a-z0-9-]+(~[0-9a-f]{8})?$/;
