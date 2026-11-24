/**
 * Where a harness CLI keeps the session it resumes from, on the box, as its
 * runtime declares it (`../conversation-state.ts`).
 *
 * A snapshot is these files and nothing else: never the working folder, the
 * CLI's config or its credentials. They are what `resume` reads, so writing
 * them onto a replaced box lets the CLI pick up the conversation natively.
 *
 * Paths are stored relative to the box's home, so a new box with the same
 * harness session id puts them back in the same place.
 */
import { posix } from "node:path";
import {
  harnessSessionDataDirectoryPath,
  harnessStateDirectoryPath,
} from "@ai-sdk/harness";
import type { HarnessConversationState } from "../conversation-state.js";

export type SessionFileSpec = {
  harnessId: string;
  /** Folder every saved file must sit under, absolute on this box. */
  root: string;
  /** Prints `<bytes>\t<absolute path>` for each file to save. */
  listCommand: string;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** What a box home or a derived folder may contain before it reaches a shell. */
const SAFE_PATH = /^\/[A-Za-z0-9._/%-]+$/;
/** One plain name, which needs no escaping in a single-quoted shell word. */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const MAX_DEPTH = 8;

function resumeDataId(resumeState: unknown, key: string): unknown {
  if (!resumeState || typeof resumeState !== "object") return undefined;
  const data: unknown = Reflect.get(resumeState, "data");
  if (!data || typeof data !== "object") return undefined;
  return Reflect.get(data, key);
}

/**
 * A declared path with its placeholders filled, or undefined when one names an
 * id this session does not have, or one it cannot place safely.
 */
function expand(
  template: string,
  values: { id: () => unknown; sessionData: () => unknown },
): string | undefined {
  let placed = true;
  const path = template.replace(/\{(id|sessionData)\}/g, (_, key: string) => {
    const value = key === "id" ? values.id() : values.sessionData();
    if (typeof value === "string") return value;
    placed = false;
    return "";
  });
  return placed ? path : undefined;
}

const isPlainName = (name: string) =>
  SAFE_NAME.test(name) && name !== "." && name !== "..";

/**
 * The session files for one harness session on a box whose home is `home`, or
 * undefined for a runtime that declares none, or ids it cannot place safely.
 */
export function sessionFileSpec(args: {
  harnessId: string;
  conversationState: HarnessConversationState | null;
  harnessSessionId: string;
  resumeState: unknown;
  home: string;
}): SessionFileSpec | undefined {
  const { conversationState: state, home } = args;
  if (!state || !SAFE_PATH.test(home)) return undefined;
  const values = {
    id: () => {
      const id = state.idKey
        ? resumeDataId(args.resumeState, state.idKey)
        : undefined;
      return typeof id === "string" && SAFE_ID.test(id) ? id : undefined;
    },
    sessionData: () =>
      SAFE_ID.test(args.harnessSessionId)
        ? posix.relative(
            home,
            harnessSessionDataDirectoryPath({
              stateDirectory: harnessStateDirectoryPath({
                sandboxHomeDir: home,
              }),
              sessionId: args.harnessSessionId,
            }),
          )
        : undefined,
  };
  const folder = expand(state.folder, values);
  if (folder === undefined || !folder.split("/").every(isPlainName)) {
    return undefined;
  }
  const root = posix.join(home, folder);
  if (!SAFE_PATH.test(root)) return undefined;
  if (!state.named) {
    return {
      harnessId: args.harnessId,
      root,
      listCommand: `find '${root}' -type f -printf '%s\\t%p\\n' 2>/dev/null`,
    };
  }
  const { depth } = state.named;
  const names = state.named.names.map((name) => expand(name, values));
  if (
    !Number.isInteger(depth) ||
    depth < 1 ||
    depth > MAX_DEPTH ||
    names.length === 0 ||
    !names.every((name) => name !== undefined && isPlainName(name))
  ) {
    return undefined;
  }
  const matches = names.map((name) => `-name '${name}'`).join(" -o ");
  return {
    harnessId: args.harnessId,
    root,
    listCommand:
      `find '${root}' -mindepth ${depth} -maxdepth ${depth} \\( ${matches} \\) ` +
      `-exec find {} -type f -printf '%s\\t%p\\n' \\; 2>/dev/null`,
  };
}

/** The names the CLIs give their session files, folder by folder. */
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/**
 * A stored path, relative to home, that lies under `root`: plain names only,
 * no `..`. Anything else in a bundle is refused, and nothing that passes needs
 * escaping in a single-quoted shell word.
 */
export function isPathUnderRoot(
  relativePath: string,
  home: string,
  root: string,
): boolean {
  if (
    !SAFE_RELATIVE_PATH.test(relativePath) ||
    relativePath.split("/").includes("..")
  ) {
    return false;
  }
  return posix.join(home, relativePath).startsWith(`${root}/`);
}

/** `<bytes>\t<absolute path>` lines, kept only when under `root`. */
export function parseFileListing(
  stdout: string,
  home: string,
  root: string,
): Array<{ path: string; bytes: number }> {
  const files: Array<{ path: string; bytes: number }> = [];
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const bytes = Number(line.slice(0, tab));
    const absolute = line.slice(tab + 1);
    if (!Number.isFinite(bytes) || !absolute.startsWith(`${home}/`)) continue;
    const path = absolute.slice(home.length + 1);
    if (isPathUnderRoot(path, home, root)) files.push({ path, bytes });
  }
  return files;
}
