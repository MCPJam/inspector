/**
 * Where a harness CLI keeps the session it resumes from, on the box.
 *
 * A snapshot is these files and nothing else: never the working folder, the
 * CLI's config or its credentials. They are what `resume` reads, so writing
 * them onto a replaced box lets the CLI pick up the conversation natively.
 *
 *   - Claude Code: the Agent SDK's transcript for the session,
 *     `~/.claude/projects/<cwd>/<claudeSessionId>.jsonl`, and the folder of the
 *     same name beside it (subagent transcripts). The `<cwd>` folder is the
 *     CLI's encoding of the working folder, so it is found, not computed.
 *   - Codex: the rollouts `thread/resume` reads, under the per-session
 *     `CODEX_HOME` (`codex-appserver/bridge/codex-home.ts`). Its `config.toml`
 *     carries the relay credential and is never included.
 *
 * Paths are stored relative to the box's home, so a new box with the same
 * harness session id puts them back in the same place.
 */
import { posix } from "node:path";
import {
  harnessSessionDataDirectoryPath,
  harnessStateDirectoryPath,
} from "@ai-sdk/harness";

export type SnapshotHarnessId = "claude-code" | "codex";

export type SessionFileSpec = {
  harnessId: SnapshotHarnessId;
  /** Folder every saved file must sit under, absolute on this box. */
  root: string;
  /** Prints `<bytes>\t<absolute path>` for each file to save. */
  listCommand: string;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** What a box home or a derived folder may contain before it reaches a shell. */
const SAFE_PATH = /^\/[A-Za-z0-9._/%-]+$/;

function readClaudeSessionId(resumeState: unknown): string | undefined {
  if (!resumeState || typeof resumeState !== "object") return undefined;
  const data: unknown = Reflect.get(resumeState, "data");
  if (!data || typeof data !== "object") return undefined;
  const id: unknown = Reflect.get(data, "claudeSessionId");
  return typeof id === "string" && SAFE_ID.test(id) ? id : undefined;
}

/**
 * The session files for one harness session on a box whose home is `home`, or
 * undefined for a runtime this does not save, or ids it cannot place safely.
 */
export function sessionFileSpec(args: {
  harnessId: string;
  harnessSessionId: string;
  resumeState: unknown;
  home: string;
}): SessionFileSpec | undefined {
  const { home } = args;
  if (!SAFE_PATH.test(home)) return undefined;
  if (args.harnessId === "claude-code") {
    const id = readClaudeSessionId(args.resumeState);
    if (!id) return undefined;
    const root = posix.join(home, ".claude", "projects");
    return {
      harnessId: "claude-code",
      root,
      listCommand:
        `find '${root}' -mindepth 2 -maxdepth 2 \\( -name '${id}.jsonl' -o -name '${id}' \\) ` +
        `-exec find {} -type f -printf '%s\\t%p\\n' \\; 2>/dev/null`,
    };
  }
  if (args.harnessId === "codex") {
    if (!SAFE_ID.test(args.harnessSessionId)) return undefined;
    const root = posix.join(
      harnessSessionDataDirectoryPath({
        stateDirectory: harnessStateDirectoryPath({ sandboxHomeDir: home }),
        sessionId: args.harnessSessionId,
      }),
      "codex-home",
      "sessions",
    );
    if (!SAFE_PATH.test(root)) return undefined;
    return {
      harnessId: "codex",
      root,
      listCommand: `find '${root}' -type f -printf '%s\\t%p\\n' 2>/dev/null`,
    };
  }
  return undefined;
}

/** The names both CLIs give their session files, folder by folder. */
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
