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
 * Assigns a unique slug to each server.
 *
 * Collision suffixes are handed out in `serverId` order, NOT in the order the
 * caller passed — the returned array keeps the caller's order, but which of two
 * servers labelled "Acme" gets `acme` and which gets `acme-2` does not depend
 * on it. That independence is the point: the picker builds its list from the
 * app's connected servers and the chat wrapper builds its from the turn's
 * selected servers, and those two arrays are not ordered alike. When they
 * disagreed, the picker showed `acme/refunds` for a server the turn resolved as
 * `acme-2/refunds`, and the ref the user clicked loaded someone else's skill.
 *
 * `serverId` is the canonical key because it is the only stable per-server
 * identity here — labels are user-editable and slugs are what we are deriving.
 *
 * Callers must still feed the same SET. Both do: each assigns over its full
 * server list before any filtering, so a server that turns out not to serve
 * skills still holds its place in the namespace instead of shifting every slug
 * behind it.
 */
export function assignServerSlugs<
  T extends { serverId: string; serverLabel: string }
>(servers: readonly T[]): Array<ServerSlugAssignment<T>> {
  const taken = new Set<string>();
  const slugById = new Map<string, string>();
  const canonical = [...servers].sort((a, b) =>
    a.serverId < b.serverId ? -1 : a.serverId > b.serverId ? 1 : 0
  );
  for (const server of canonical) {
    // A repeated serverId is the same server, so it keeps the slug it already
    // has rather than colliding with itself.
    if (slugById.has(server.serverId)) continue;
    const base = slugifyServerLabel(server.serverLabel);
    let slug = base;
    let suffix = 2;
    while (taken.has(slug)) {
      slug = `${base}-${suffix}`;
      suffix += 1;
    }
    taken.add(slug);
    slugById.set(server.serverId, slug);
  }
  return servers.map((server) => ({
    server,
    serverSlug:
      slugById.get(server.serverId) ?? slugifyServerLabel(server.serverLabel),
  }));
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

/**
 * The 8-hex-character URI digest used as a ref disambiguator.
 *
 * WebCrypto rather than `node:crypto`, because this module is imported by the
 * browser bundle as well as the Hono server.
 */
export async function skillUriHash8(uri: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(uri)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

export interface SkillRefAssignment<T> {
  skill: T;
  ref: string;
}

/**
 * Assigns each of one server's skills its runtime ref.
 *
 * SEP-2640 lets a single server serve two skills with the same `name` under
 * different URIs. When that happens BOTH get the `~<uriHash8>` form — not just
 * the second one. Giving the first arrival the bare ref would make the refs
 * depend on listing order, and a server is free to reorder its listing between
 * two calls; the picker and the chat wrapper would then disagree about which
 * skill `acme/refunds` means. Disambiguating every member of a duplicated name
 * removes the question: a bare ref is only ever issued when it is unambiguous.
 *
 * Two entries sharing a name AND a URI are the same skill listed twice, so they
 * are not a collision and stay undisambiguated.
 */
export async function assignSkillRefs<
  T extends { name: string; skillUri: string }
>(
  serverSlug: string,
  skills: readonly T[]
): Promise<Array<SkillRefAssignment<T>>> {
  const urisByName = new Map<string, Set<string>>();
  for (const skill of skills) {
    const uris = urisByName.get(skill.name) ?? new Set<string>();
    uris.add(skill.skillUri);
    urisByName.set(skill.name, uris);
  }
  return Promise.all(
    skills.map(async (skill) => {
      const duplicated = (urisByName.get(skill.name)?.size ?? 0) > 1;
      return {
        skill,
        ref: buildServerSkillRef({
          serverSlug,
          name: skill.name,
          ...(duplicated
            ? { disambiguator: await skillUriHash8(skill.skillUri) }
            : {}),
        }),
      };
    })
  );
}
