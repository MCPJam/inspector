/**
 * The checks a server-served skill (SEP-2640) passes before MCPJam's agent
 * puts its content in a model turn.
 *
 * Every read goes through the SDK's verified path, which checks sizes,
 * digests, frontmatter drift and URI identity, and holds a file read to the
 * skill's advertised manifest. On top of that, these functions refuse content
 * too large for one tool result and wrap a load in the origin banner. The
 * banner records the load's digest set, the held entry that later file reads
 * are checked against (`server-skill-held-entry.ts`). A file read is resolved
 * against the skill's own root and read from the server that served the skill.
 *
 * Each returns what the matching skill tool returns: the content, or a refusal
 * the model can act on. Callers check the held entry before a file is listed
 * or read.
 *
 * PIN: modelcontextprotocol/ext-skills @ c1aa87e (`specification/stable/skills.mdx`).
 */

import type { MCPClientManager, SkillEntry } from "@mcpjam/sdk";
import { buildServerSkillBanner } from "../../../shared/server-skill-banner.js";
import { manifestDigestSetHash } from "../../../shared/server-skill-refs.js";
import {
  getVerifiedServerSkill,
  isServerSkillRefusalError,
  readVerifiedServerSkillFile,
  type ServerSkillSummary,
  type VerifiedServerSkill,
} from "../server-skills.js";
import { resolveSkillRelativeReference } from "./server-skill-held-entry.js";

/**
 * A server skill as a turn's catalog lists it: its listing entry, the ref the
 * model addresses it by, and the user's label for the server that served it.
 */
export interface CatalogEntry extends ServerSkillSummary {
  ref: string;
  serverLabel: string;
}

/**
 * The digest-set hash an approval binds to.
 *
 * Covers every manifest URI AND digest, sorted, so adding a file, removing
 * one, or changing one file's bytes all produce a different approval. This is
 * the SEP's "bind approval to the digest set" rule made concrete. The same
 * hash goes into the origin banner, where it is the HELD ENTRY a later file
 * read is checked against; the shared implementation is what lets the
 * playground popover write the same banner.
 */
export async function manifestApprovalHash(
  resources: ReadonlyArray<{ uri: string; digest: string }>
): Promise<string> {
  return manifestDigestSetHash(resources);
}

/**
 * Re-exported from `shared/server-skill-banner.ts`.
 *
 * The definition lives in `shared/` because the playground popover fabricates
 * a synthetic `loadSkill` message that must BYTE-MATCH this tool's output —
 * two copies of the text would drift the moment one is edited.
 */
export const serverSkillBanner = buildServerSkillBanner;

/**
 * The cap on server-skill content placed in ONE TOOL RESULT.
 *
 * Distinct from the verification cap in the SDK, which is the spec's 16 MiB
 * per-skill budget: a host MUST accept a conforming skill of that size, and
 * MCPJam verifies and lists one. This cap governs something else, how many
 * bytes one `loadSkill` or `readSkillFile` result places in a model turn.
 * Without it a server-controlled SKILL.md or supporting file of 16 MiB would
 * go digest-verified into a single tool result, the provider request and the
 * chat history, some millions of tokens at once, and nothing else in the
 * chat pipeline bounds a tool's output.
 *
 * 256 KiB is about 64k tokens, within the context of the models the host
 * serves, and twice the 128 KiB that applied before the re-sync, which
 * refused skills of ordinary size.
 *
 * REFUSED, never truncated. A clipped skill is instructions that end
 * mid-sentence, and the model cannot tell that from a skill that simply said
 * less.
 */
export const MAX_SERVER_SKILL_PROMPT_BYTES = 256 * 1024;

/**
 * Returns the text, or a refusal naming both numbers when it is too large for
 * a turn.
 */
function withinPromptBudget(
  text: string,
  what: string
): { ok: true; text: string } | { ok: false; error: string } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_SERVER_SKILL_PROMPT_BYTES) return { ok: true, text };
  return {
    ok: false,
    error:
      `Error (too_large_for_prompt): ${what} is ${bytes} bytes, over the ` +
      `${MAX_SERVER_SKILL_PROMPT_BYTES}-byte limit for content placed in a ` +
      `model turn. It verified correctly; MCPJam declines to inject it rather ` +
      `than truncate it into instructions that end mid-sentence.`,
  };
}

/** Renders a refusal as a tool result the model (and the user) can act on. */
function refusalText(error: unknown): string {
  if (isServerSkillRefusalError(error)) {
    const { refusal } = error;
    const details = [
      refusal.resourceUri ? `file: ${refusal.resourceUri}` : undefined,
      refusal.field ? `field: ${refusal.field}` : undefined,
      refusal.expected ? `expected: ${refusal.expected}` : undefined,
      refusal.actual ? `actual: ${refusal.actual}` : undefined,
    ].filter(Boolean);
    return details.length > 0
      ? `Error (${refusal.kind}): ${refusal.message}\n${details.join("\n")}`
      : `Error (${refusal.kind}): ${refusal.message}`;
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

async function loadEntry(
  manager: MCPClientManager,
  entry: CatalogEntry
): Promise<VerifiedServerSkill | string> {
  try {
    return await getVerifiedServerSkill(manager, {
      serverId: entry.serverId,
      uri: entry.skillUri,
      // A LISTED skill is loaded against the listing entry we already have,
      // so the frontmatter compared is the one the catalog showed the user.
      entry: {
        uri: entry.skillUri,
        frontmatter: entry.frontmatter,
        resources: entry.resources,
      },
    });
  } catch (error) {
    return refusalText(error);
  }
}

/**
 * A listed skill's SKILL.md, verified against the listing entry the catalog
 * showed, behind the origin banner. A skill the listing marked unloadable is
 * refused with its reason.
 */
export async function loadLiveServerSkill(
  manager: MCPClientManager,
  entry: CatalogEntry
): Promise<string> {
  if (entry.unloadable) {
    // The REASON, not a hardcoded `no_resources`. A server declaring
    // `"resources": "dynamic"` otherwise surfaced as
    // `Error (no_resources): This skill generates its content per
    // request…` — the exact collapse the separate kind exists to
    // prevent.
    return `Error (${entry.unloadable.reason}): ${entry.unloadable.message}`;
  }
  const loaded = await loadEntry(manager, entry);
  if (typeof loaded === "string") return loaded;
  const budgeted = withinPromptBudget(
    loaded.content,
    `Skill "${entry.ref}"`
  );
  if (!budgeted.ok) return budgeted.error;
  return (
    serverSkillBanner({
      ref: entry.ref,
      serverLabel: entry.serverLabel,
      skillUri: entry.skillUri,
      digestSet: await manifestApprovalHash(loaded.resources),
    }) + budgeted.text
  );
}

/**
 * A skill addressed by URI alone, verified through `skills/get`, behind the
 * origin banner. The URI can come from a server's instructions, another
 * skill's body or the user, so the skill need not be listed.
 */
export async function loadLiveServerSkillByUri(
  manager: MCPClientManager,
  target: {
    serverId: string;
    uri: string;
    /** Names the skill in the banner; the server id stands in without it. */
    provider?: { serverSlug: string; serverLabel: string };
    /**
     * The entry fetched before the approval, when there was one. Reused, since
     * a second `skills/get` after that check would reopen a TOCTOU window.
     */
    entry?: SkillEntry;
  }
): Promise<string> {
  const { provider } = target;
  try {
    const loaded = await getVerifiedServerSkill(manager, {
      serverId: target.serverId,
      uri: target.uri,
      entry: target.entry,
    });
    const budgeted = withinPromptBudget(
      loaded.content,
      `Skill "${loaded.skillUri}"`
    );
    if (!budgeted.ok) return budgeted.error;
    return (
      serverSkillBanner({
        ref: `${provider?.serverSlug ?? target.serverId}/${loaded.name}`,
        serverLabel: provider?.serverLabel ?? target.serverId,
        skillUri: loaded.skillUri,
        digestSet: await manifestApprovalHash(loaded.resources),
      }) + budgeted.text
    );
  } catch (error) {
    return refusalText(error);
  }
}

/**
 * A skill's supporting files: its advertised manifest, which is also the only
 * set of files `readLiveServerSkillFile` reads.
 */
export function listLiveServerSkillFiles(entry: CatalogEntry): string {
  const files = entry.resources.filter(
    (resource) => resource.uri !== entry.skillUri
  );
  if (files.length === 0) {
    return `Skill "${entry.ref}" advertises no supporting files.`;
  }
  return (
    `Supporting files for "${entry.ref}" (manifest of ${files.length}):\n\n` +
    files.map((file) => `- ${file.uri}`).join("\n") +
    `\n\nUse \`readSkillFile\` with one of these URIs. Any other URI will be refused.`
  );
}

/**
 * One supporting file, resolved against the skill's own root, read from the
 * server that served the skill, verified against its manifest and tagged with
 * its origin. `approved` is the binding made when the read was approved.
 */
export async function readLiveServerSkillFile(
  manager: MCPClientManager,
  entry: CatalogEntry,
  path: string,
  approved?: { entry: Pick<SkillEntry, "uri" | "resources"> }
): Promise<string> {
  // Prefer the manifest bound at approval time; otherwise this call's.
  // Either way the read is confined to the skill's OWN manifest —
  // `readVerifiedServerSkillFile` refuses anything absent from it — so an
  // unlisted file stays unreadable.
  const approvedEntry = approved?.entry ?? {
    uri: entry.skillUri,
    resources: entry.resources,
  };
  const resourceUri = resolveSkillRelativeReference(entry.skillUri, path);
  try {
    const file = await readVerifiedServerSkillFile(manager, {
      serverId: entry.serverId,
      entry: approvedEntry,
      resourceUri,
    });
    const budgeted = withinPromptBudget(file.text, `"${file.uri}"`);
    if (!budgeted.ok) return budgeted.error;
    // Origin on the file too: it is skill content entering context.
    return (
      `# ${file.uri}\n\n` +
      `> Origin: MCP server "${entry.serverLabel}", a file of skill ${entry.ref}. ` +
      `Untrusted server-provided content.\n\n` +
      budgeted.text
    );
  } catch (error) {
    return refusalText(error);
  }
}
