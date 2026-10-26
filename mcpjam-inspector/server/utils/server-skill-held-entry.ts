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
 * A load counts only if the server can stand behind it. Hosted web chat runs
 * every history it is sent through `verifyClientHistory` (MJ-009), which
 * marks each tool call and result it cannot verify, and overwrites any mark
 * the browser sent, so an unmarked result there is one this server produced.
 * In local mode nothing is marked: the browser is the user's own. A load that
 * is marked, or whose text cannot be read, does not set the held entry, and
 * a read of its skill is refused until the skill is loaded again: the entry
 * the user approved is then unknown, which must not read as "none".
 *
 * PIN: modelcontextprotocol/ext-skills @ c1aa87e (`specification/stable/skills.mdx`).
 */

import type { ModelMessage } from "ai";
import {
  serverSkillLoads,
  type ActingServerSkill,
  type ServerSkillLoad,
} from "../../shared/server-skill-banner.js";
import { manifestDigestSetHash } from "../../shared/server-skill-refs.js";
import {
  isMarkedClientProvenance,
  isMarkedUnverifiedCall,
} from "./history-provenance.js";

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

interface HeldEntrySkill {
  ref: string;
  skillUri: string;
  serverLabel: string;
  resources: ReadonlyArray<{ uri: string; digest: string }>;
}

/** The `loadSkill` calls in the conversation, by call id. */
function loadSkillCalls(
  messages: ReadonlyArray<ModelMessage>,
): Map<string, { input: unknown; providerOptions: unknown }> {
  const calls = new Map<string, { input: unknown; providerOptions: unknown }>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolName === "loadSkill") {
        calls.set(part.toolCallId, {
          input: part.input,
          providerOptions: part.providerOptions,
        });
      }
    }
  }
  return calls;
}

/** A user pick, or a result whose call and content the server stands behind. */
function isTrustedLoad(
  load: ServerSkillLoad,
  call: { providerOptions: unknown } | undefined,
): boolean {
  if (load.toolCallId === undefined) return true;
  return (
    !isMarkedClientProvenance(load.providerOptions) &&
    !isMarkedUnverifiedCall(load.providerOptions) &&
    !isMarkedUnverifiedCall(call?.providerOptions)
  );
}

function isLoadOf(skill: ActingServerSkill, entry: HeldEntrySkill): boolean {
  return (
    skill.skillUri === entry.skillUri && skill.serverLabel === entry.serverLabel
  );
}

/** Whether a `loadSkill` call asked for this skill, by ref or by URI. */
function callNamesEntry(input: unknown, entry: HeldEntrySkill): boolean {
  const { name, uri } = (input ?? {}) as { name?: unknown; uri?: unknown };
  const identifier = uri ?? name;
  return identifier === entry.ref || identifier === entry.skillUri;
}

/**
 * The held-entry check for a supporting-file listing or read.
 *
 * Finds the latest trusted load of this skill in the conversation and
 * compares the digest set it records with the current manifest. A server that
 * changed the skill in between is refused, and the model is told to reload,
 * which re-presents the changed manifest for approval. An unchanged manifest
 * means the current entry IS the held entry. No load at all means the skill
 * is not being acted on in this conversation, and there is nothing to hold.
 *
 * A load of this skill the server cannot stand behind, after the last one it
 * can, is refused the same way: an untrusted result, or one whose text cannot
 * be read. An unreadable result whose call is missing is taken to be this
 * skill's, since which skill it loaded cannot be told.
 */
export async function heldEntryConflict(
  entry: HeldEntrySkill,
  messages: ReadonlyArray<ModelMessage> | undefined
): Promise<string | undefined> {
  const history = messages ?? [];
  const calls = loadSkillCalls(history);
  let held: ActingServerSkill | undefined;
  let unconfirmed = false;
  for (const load of serverSkillLoads(history)) {
    const call =
      load.toolCallId === undefined ? undefined : calls.get(load.toolCallId);
    const ofThisSkill =
      load.kind === "loaded"
        ? isLoadOf(load.skill, entry)
        : call === undefined || callNamesEntry(call.input, entry);
    if (!ofThisSkill) continue;
    if (load.kind === "loaded" && isTrustedLoad(load, call)) {
      if (load.skill.digestSet !== undefined) held = load.skill;
      unconfirmed = false;
      continue;
    }
    unconfirmed = true;
  }
  if (unconfirmed) {
    return (
      `Error (load_unconfirmed): "${entry.ref}" was loaded earlier in this ` +
      `conversation, but that load could not be confirmed as one this server ` +
      `served, so the entry its files are checked against is unknown. Load ` +
      `the skill again with \`loadSkill\` before reading its files.`
    );
  }
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
