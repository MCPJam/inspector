/**
 * The held entry of a server-served skill (SEP-2640), across requests.
 *
 * A host acting on a skill resolves reads of its files only against the entry
 * it loaded the skill under. `prepareChatV2` rebuilds its closures per
 * request, so that entry cannot live in memory; it lives in the conversation
 * instead, as the digest-set hash the origin banner records. A read in a later
 * request runs against a freshly drained catalog, and this module is what
 * compares the two.
 *
 * PIN: modelcontextprotocol/ext-skills @ c1aa87e (`specification/stable/skills.mdx`).
 */

import type { ModelMessage } from "ai";
import { actingServerSkills } from "../../shared/server-skill-banner.js";
import { manifestDigestSetHash } from "../../shared/server-skill-refs.js";

/** Anything with a scheme is treated as a skill URI, not a relative path. */
function looksLikeUri(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

/**
 * Resolves a relative reference against the skill's root, as a filesystem
 * path would: `./references/x.md` and `references/../x.md` both name the file
 * the manifest lists. A reference that climbs above the root is returned as
 * written, which the manifest allowlist then refuses as unlisted.
 */
export function resolveSkillRelativeReference(
  skillUri: string,
  path: string
): string {
  if (looksLikeUri(path)) return path;
  const root = skillUri.replace(/SKILL\.md$/i, "");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return `${root}${path}`;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${root}${segments.join("/")}`;
}

/** The AI SDK's execution options, read for the conversation they carry. */
export function messagesOf(
  options: unknown
): ReadonlyArray<ModelMessage> | undefined {
  return (options as { messages?: ReadonlyArray<ModelMessage> } | undefined)
    ?.messages;
}

/**
 * The held-entry check for a supporting-file listing or read.
 *
 * Finds the banner for this skill in the conversation and compares the
 * digest set it records with the current manifest. A server that changed the
 * skill in between is refused, and the model is told to reload, which
 * re-presents the changed manifest for approval. An unchanged manifest means
 * the current entry IS the held entry. No banner means the skill is not being
 * acted on in this conversation, and there is nothing to hold.
 */
export async function heldEntryConflict(
  entry: {
    ref: string;
    skillUri: string;
    serverLabel: string;
    resources: ReadonlyArray<{ uri: string; digest: string }>;
  },
  messages: ReadonlyArray<ModelMessage> | undefined
): Promise<string | undefined> {
  const held = actingServerSkills(messages).find(
    (acting) =>
      acting.digestSet !== undefined &&
      acting.skillUri === entry.skillUri &&
      acting.serverLabel === entry.serverLabel
  );
  if (!held) return undefined;
  const current = await manifestDigestSetHash(entry.resources);
  if (current === held.digestSet) return undefined;
  return (
    `Error (manifest_changed): "${entry.ref}" was loaded under digest-set ` +
    `${held.digestSet}, and the server now advertises digest-set ${current}. ` +
    `Its files are not readable under the loaded entry. Load the skill again ` +
    `with \`loadSkill\` to review the changed manifest.`
  );
}
