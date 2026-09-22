/**
 * What the orchestrator ASKS THE BOX, and how it reads the answers.
 *
 * Two jobs, both of which exist because the resolver's static reasoning stops
 * at the sandbox boundary:
 *
 *   1. FEEDING THE RESOLVER. The detector is a pure function of already-read
 *      file contents plus a checkout listing (`resolver/detect.ts` says so in
 *      its own docblock), so somebody has to do the reading. Every read here is
 *      byte-capped INSIDE the box (`head -c`), never `cat` followed by a
 *      caller-side slice: a 200MB generated lockfile must not cross the command
 *      channel at all, and a cap applied after the transfer is not a cap.
 *
 *   2. SETTLING WHAT ACTUALLY LISTENS. The install-hook rounds established that
 *      a rogue listener can answer our probe while the validated start command
 *      never binds, and that question has exactly one source of ground truth:
 *      the process holding the port. That is what `inspectListener` looks at.
 *
 *      IT ONLY EVER READS FACTS THE BOX CANNOT FORGE. Everything running in
 *      there after the build is PR code, so an identity the box WRITES is an
 *      identity the PR chooses. This module therefore reads kernel state
 *      (`/proc/net/tcp`, `/proc/<pid>/stat`, `/proc/<pid>/fd`) and nothing that
 *      a process authored — no pid file, and no inference from `cmdline`. WHO WE
 *      EXPECT comes from the spawn instead (`SpawnIdentity` in sandbox.ts) and
 *      the comparison happens on our side of the boundary.
 *
 * WHY NODE AND /proc RATHER THAN `ss -ltnp` / `lsof`. The dedicated checks
 * template is node + git and nothing else (see `sandbox.ts`), and `sandbox.ts`
 * already leans on node being the one guaranteed interpreter for its in-box
 * liveness probe. `ss` and `lsof` are not guaranteed to be installed, and both
 * read `/proc/net/tcp` + `/proc/<pid>/fd` anyway — so this reads them directly
 * and depends on nothing the image might not carry. If `/proc` is unreadable
 * the answer is "could not tell", which the caller must treat as OUR problem
 * (`infra_error`), never as a pass.
 */

import {
  CheckStepError,
  CHECKOUT_DIR,
  shellQuote,
  type CheckSandbox,
} from "./sandbox.js";
import {
  DETECTION_MAX_BYTES,
  DETECTION_README_MAX_BYTES,
  MCPJAM_YAML_MAX_BYTES,
  parseLsFilesEntries,
  type DetectionInputs,
  type RepoFileEntry,
} from "./resolver/index.js";

/** Per-read command budget. These are file reads; a stall is the box's. */
const READ_TIMEOUT_MS = 60_000;
/** The listener inspection walks `/proc`; still a fraction of a second. */
const INSPECT_TIMEOUT_MS = 60_000;

/**
 * Cap on the `git ls-files -s -z` output we pull across, in BYTES.
 *
 * `MAX_REPO_FILES` (20k entries) bounds what the detector keeps, but the bytes
 * still have to cross the command channel first, and a monorepo with deep paths
 * can be tens of megabytes. Truncation is safe in the SUPPRESS direction — a
 * listing that is missing entries can only downgrade a candidate to
 * `unverified` or reject it — provided a half-written record never becomes an
 * entry, which `readRepoFiles` guarantees by discarding everything after the
 * last NUL when the cap bit.
 */
export const LS_FILES_MAX_BYTES = 4 * 1024 * 1024;

/** Marker the in-box inspection prints its JSON on. Matched, never parsed for. */
const LISTENER_MARKER = "MCPJAM_CHECK_LISTENER";

/** Exit code the read script uses for "the file does not exist". */
const MISSING_FILE_EXIT = 42;

type RunResult = { exitCode: number; stdout: string; stderr: string };

/**
 * A foreground command, with E2B's non-zero-exit throw normalized back into a
 * result.
 *
 * A private twin of `sandbox.ts`'s `runForeground` on purpose: that one takes a
 * `timeoutOutcome` because it runs PR CODE, whose failures may be the PR's. Every
 * command here is OURS — a `head -c`, a `git ls-files`, a `/proc` walk — so a
 * failure that is not the command's own exit status is unambiguously
 * infrastructure, and there is no attribution decision to parameterize.
 */
async function runInBox(
  sandbox: CheckSandbox,
  command: string,
  timeoutMs: number
): Promise<RunResult> {
  try {
    const result = (await sandbox.commands.run(command, { timeoutMs })) as
      | Partial<RunResult>
      | undefined;
    return {
      exitCode: result?.exitCode ?? 0,
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
    };
  } catch (error) {
    const exit = error as Partial<RunResult> & { exitCode?: number };
    if (typeof exit?.exitCode === "number") {
      return {
        exitCode: exit.exitCode,
        stdout: exit.stdout ?? "",
        stderr: exit.stderr ?? "",
      };
    }
    throw new CheckStepError(
      "infra_error",
      `sandbox read failed: ${
        error instanceof Error ? error.message.slice(0, 200) : String(error)
      }`
    );
  }
}

/**
 * The three things a capped read can find, kept APART.
 *
 * The distinction that matters is `absent` vs `over_cap`, and it is load-bearing
 * for exactly one caller: `mcpjam.yaml` is an AUTHORITATIVE rung, and the ladder
 * reads "absent" as "this rung does not apply, move on". Collapsing an over-cap
 * declared config into absence therefore let a file the parser itself calls
 * `recipe_invalid` fall through to heuristic candidates and green a PR on a
 * command its author never declared — the one thing authoritative rungs promise
 * cannot happen. A reader that cannot tell the two apart cannot keep that
 * promise, so it now says which one it saw and lets the caller decide.
 *
 * Heuristic inputs (package.json, lockfiles, the README) genuinely do not care:
 * the detector ignores an over-cap file rather than parsing a prefix, so absence
 * and over-cap have identical consequences there and `orNull` below collapses
 * them on purpose, at the call site, in one visible place.
 */
export type CappedRead =
  | { kind: "absent" }
  | { kind: "present"; text: string }
  | { kind: "over_cap" };

/**
 * Read at most `cap` bytes of one checkout file, and say WHICH of the three
 * outcomes happened.
 *
 * `cap + 1` bytes are requested, deliberately, and that extra byte is what makes
 * `over_cap` observable at all. Reading exactly `cap` bytes would hand the caller
 * a TRUNCATED file that fits the cap perfectly — a lockfile cut mid-object parses
 * as absent (harmless) but a README cut mid-sentence still yields port/path hints
 * from whatever survived, and an over-cap `mcpjam.yaml` would be indistinguishable
 * from a small valid one. So the read is `cap + 1` and anything longer than `cap`
 * is reported as over-cap rather than as content or as absence.
 */
async function readCapped(
  sandbox: CheckSandbox,
  relativePath: string,
  cap: number
): Promise<CappedRead> {
  const absolute = `${CHECKOUT_DIR}/${relativePath}`;
  const script =
    `if [ ! -f ${shellQuote(
      absolute
    )} ]; then exit ${MISSING_FILE_EXIT}; fi; ` +
    `head -c ${cap + 1} ${shellQuote(absolute)}`;
  const result = await runInBox(
    sandbox,
    `bash -lc ${shellQuote(script)}`,
    READ_TIMEOUT_MS
  );
  if (result.exitCode === MISSING_FILE_EXIT) return { kind: "absent" };
  if (result.exitCode !== 0) {
    // An unreadable file is not a missing one, but nothing downstream can act on
    // the difference — there is no content to judge either way — and a read
    // failure of OURS must not fail somebody's PR. Absent, which biases toward
    // suppression.
    return { kind: "absent" };
  }
  if (Buffer.byteLength(result.stdout, "utf8") > cap)
    return { kind: "over_cap" };
  return { kind: "present", text: result.stdout };
}

/**
 * A capped read as the detector wants it: content or nothing.
 *
 * The collapse lives here, named, rather than inside `readCapped` — so that
 * every caller that discards the over-cap case is visibly choosing to, and the
 * one caller that must not (see `CappedRead`) cannot do it by accident.
 */
async function readCappedOrNull(
  sandbox: CheckSandbox,
  relativePath: string,
  cap: number
): Promise<string | null> {
  const read = await readCapped(sandbox, relativePath, cap);
  return read.kind === "present" ? read.text : null;
}

/**
 * The checkout's tracked files WITH their git modes, from inside the box.
 *
 * Deliberately routed through `parseLsFilesEntries` from `resolver/repoFiles.ts`
 * rather than parsed here: that module owns the `git ls-files -s -z` contract
 * (why `-s`, why NUL, what each mode means), and the corpus harness already
 * feeds the same parser from a clone on disk. Two hand-rolled listings that
 * disagree about symlinks would mean the corpus measures a detector the sandbox
 * never runs.
 */
export async function readRepoFiles(
  sandbox: CheckSandbox
): Promise<RepoFileEntry[]> {
  const script =
    `git -C ${shellQuote(CHECKOUT_DIR)} ls-files -s -z | ` +
    `head -c ${LS_FILES_MAX_BYTES}`;
  const result = await runInBox(
    sandbox,
    `bash -lc ${shellQuote(script)}`,
    READ_TIMEOUT_MS
  );
  // `[]` is a VALID input, not an error: detection reads an empty listing as
  // "no listing", suppresses what it cannot prove, and labels the rest
  // `unverified` — which the runtime ownership check then settles. Same
  // fallback `listRepoFiles` documents for a git failure on disk.
  if (result.exitCode !== 0) return [];

  let stdout = result.stdout;
  if (Buffer.byteLength(stdout, "utf8") >= LS_FILES_MAX_BYTES) {
    // The cap bit, so the final record is a PREFIX of a real path. A prefix is
    // not a shorter path, it is a DIFFERENT one, and a truncated `src/index.jsx`
    // landing in the map as `src/index.js` would let rule C "verify" an entry
    // point that does not exist. Everything after the last NUL is discarded.
    const lastNul = stdout.lastIndexOf("\0");
    stdout = lastNul === -1 ? "" : stdout.slice(0, lastNul + 1);
  }
  return parseLsFilesEntries(stdout);
}

/**
 * Everything the ladder needs about this checkout, read once.
 *
 * The FIELD LIST is fixed and ordered by `DetectionInputs`, because R3 keys the
 * recipe cache on exactly these paths — adding one here is a cache-key change in
 * two repos, not a local edit.
 */
export async function readResolverInputs(sandbox: CheckSandbox): Promise<{
  /**
   * The DECLARED config, with absence and over-cap kept apart — the ladder
   * treats those two as different rungs' worth of different outcomes. See
   * `CappedRead`.
   */
  mcpjamYaml: CappedRead;
  detection: DetectionInputs;
}> {
  const mcpjamYaml = await readCapped(
    sandbox,
    "mcpjam.yaml",
    MCPJAM_YAML_MAX_BYTES
  );
  const detection: DetectionInputs = {
    repoFiles: await readRepoFiles(sandbox),
    packageJson: await readCappedOrNull(
      sandbox,
      "package.json",
      DETECTION_MAX_BYTES
    ),
    packageLockJson: await readCappedOrNull(
      sandbox,
      "package-lock.json",
      DETECTION_MAX_BYTES
    ),
    pnpmLockYaml: await readCappedOrNull(
      sandbox,
      "pnpm-lock.yaml",
      DETECTION_MAX_BYTES
    ),
    yarnLock: await readCappedOrNull(sandbox, "yarn.lock", DETECTION_MAX_BYTES),
    pyprojectToml: await readCappedOrNull(
      sandbox,
      "pyproject.toml",
      DETECTION_MAX_BYTES
    ),
    uvLock: await readCappedOrNull(sandbox, "uv.lock", DETECTION_MAX_BYTES),
    serverJson: await readCappedOrNull(
      sandbox,
      "server.json",
      DETECTION_MAX_BYTES
    ),
    readme:
      (await readCappedOrNull(
        sandbox,
        "README.md",
        DETECTION_README_MAX_BYTES
      )) ??
      (await readCappedOrNull(
        sandbox,
        "readme.md",
        DETECTION_README_MAX_BYTES
      )),
  };
  return { mcpjamYaml, detection };
}

/**
 * One process found holding the probed port.
 *
 * EVERY field here is a fact the box cannot forge: the kernel writes
 * `/proc/<pid>/stat`, and the socket-inode → pid mapping comes from
 * `/proc/net/tcp{,6}` plus `/proc/<pid>/fd`. Nothing is taken from something a
 * process WROTE, and nothing is inferred from `cmdline` — a PR's server chooses
 * its own argv, and an earlier revision of this module derived a "main module"
 * from it and then judged ownership on the result. That inference is gone; see
 * `judgeListeners` in resolve-and-start.ts for what replaced it.
 */
export type ListenerProcess = {
  pid: number;
  /** Ancestry, nearest first, up to (but not including) init. */
  ppids: number[];
  /** Process GROUP id, or null when `/proc/<pid>/stat` was unreadable. */
  pgrp: number | null;
};

export type ListenerReport = {
  processes: ListenerProcess[];
};

/**
 * The in-box `/proc` walk, as a node one-liner.
 *
 * It is asked ONE question — who holds this port, and what is their ancestry and
 * process group — and it is told NOTHING about who we expect. That asymmetry is
 * deliberate: the expected identity comes from the spawn (`SpawnIdentity` in
 * sandbox.ts) and is compared on THIS side of the boundary, so no part of the
 * comparison happens in a place PR code can reach.
 *
 * Written without `$`, backticks or template placeholders in the SCRIPT text:
 * it is handed to the box as `node -e "<json string>"`, and a shell that expands
 * one of those would rewrite our diagnostic. The one interpolation below is an
 * integer this module validated.
 */
export function listenerScript(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`refusing to inspect a non-port: ${port}`);
  }
  return [
    `const fs=require('fs');`,
    `const PORT=${port};`,
    `const out={processes:[]};`,
    // /proc/<pid>/stat: `pid (comm) state ppid pgrp …`. `comm` can contain
    // spaces and parentheses, so the split starts after the LAST ')'.
    `function stat(pid){try{const t=fs.readFileSync('/proc/'+pid+'/stat','utf8');` +
      `const i=t.lastIndexOf(')');const f=t.slice(i+2).split(' ');` +
      `return {ppid:Number(f[1]),pgrp:Number(f[2])};}catch(e){return null;}}`,
    // Listening sockets on PORT, by inode. st '0A' is TCP_LISTEN; column 1 is
    // the local address as HEX:HEXPORT; column 9 is the inode.
    `function inodes(){const s=new Set();` +
      `for(const f of ['/proc/net/tcp','/proc/net/tcp6']){let t='';` +
      `try{t=fs.readFileSync(f,'utf8');}catch(e){continue;}` +
      `const lines=t.split('\\n');` +
      `for(let i=1;i<lines.length;i++){const c=lines[i].trim().split(' ').filter(Boolean);` +
      `if(c.length<10)continue;if(c[3]!=='0A')continue;` +
      `const lp=c[1].split(':')[1];if(parseInt(lp,16)!==PORT)continue;s.add(c[9]);}}` +
      `return s;}`,
    // inode -> pid, by walking every readable /proc/<pid>/fd. A pid whose fd
    // directory we cannot read is SKIPPED, never guessed at: an unattributable
    // listener leaves `processes` short, and the caller reads that as "could not
    // tell" rather than as a pass.
    `function pidsFor(s){const out=[];let ds=[];try{ds=fs.readdirSync('/proc');}catch(e){return out;}` +
      `for(const d of ds){const n=Number(d);if(!Number.isInteger(n)||n<=0)continue;` +
      `let fds=[];try{fds=fs.readdirSync('/proc/'+d+'/fd');}catch(e){continue;}` +
      `for(const fd of fds){let l='';try{l=fs.readlinkSync('/proc/'+d+'/fd/'+fd);}catch(e){continue;}` +
      `if(l.indexOf('socket:[')!==0)continue;const ino=l.slice(8,l.length-1);` +
      `if(s.has(ino)){out.push(n);break;}}}return out;}`,
    `function describe(pid){const info={pid:pid,ppids:[],pgrp:null};` +
      `const st=stat(pid);if(st){info.pgrp=st.pgrp;}` +
      `let cur=st?st.ppid:0;let guard=0;` +
      `while(cur>1&&guard<64){info.ppids.push(cur);const s2=stat(cur);if(!s2)break;cur=s2.ppid;guard++;}` +
      `return info;}`,
    `for(const pid of pidsFor(inodes())){out.processes.push(describe(pid));}`,
    `console.log('${LISTENER_MARKER} '+JSON.stringify(out));`,
  ].join("");
}

/**
 * Parse the marker line. Returns null when the script produced nothing usable —
 * which is "could not tell", and the caller owns that as infrastructure.
 */
export function parseListenerReport(stdout: string): ListenerReport | null {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(`${LISTENER_MARKER} `)) continue;
    try {
      const parsed = JSON.parse(line.slice(LISTENER_MARKER.length + 1));
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      const processes = Array.isArray(record.processes)
        ? (record.processes as ListenerProcess[])
        : [];
      return { processes };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Who is holding `port` inside the box, and what are they running.
 *
 * Returns null for "could not tell" — the box refused the command, or printed
 * nothing we can read. That is OUR failure, and the caller must never let it
 * stand in for either a pass or a resolver miss.
 */
export async function inspectListener(
  sandbox: CheckSandbox,
  args: { port: number }
): Promise<ListenerReport | null> {
  const script = listenerScript(args.port);
  let stdout = "";
  try {
    const result = (await sandbox.commands.run(
      `node -e ${JSON.stringify(script)}`,
      { timeoutMs: INSPECT_TIMEOUT_MS }
    )) as { stdout?: unknown } | null;
    stdout = typeof result?.stdout === "string" ? result.stdout : "";
  } catch (error) {
    const exit = error as { stdout?: unknown };
    stdout = typeof exit?.stdout === "string" ? exit.stdout : "";
  }
  return parseListenerReport(stdout);
}
