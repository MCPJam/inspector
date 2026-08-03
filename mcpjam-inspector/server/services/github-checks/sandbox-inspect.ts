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
 *   2. SETTLING WHAT ACTUALLY LISTENS. `ResolvedRecipe.ownershipProof` labels
 *      which candidates still owe proof that they run checkout code, and the
 *      install-hook rounds established that a rogue listener can answer our
 *      probe while the validated start command never binds. Both questions have
 *      exactly one source of ground truth: the process holding the port. That
 *      is what `inspectListener` goes and looks at.
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
  SERVER_PID_PATH,
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

/** Single-quote for `bash -lc`, so a path can never inject. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Read at most `cap` bytes of one checkout file, or `null` if it is absent.
 *
 * `cap + 1` bytes are requested, deliberately. The detector IGNORES a file that
 * exceeds its cap (`withinCap` in detect.ts, `MCPJAM_YAML_MAX_BYTES` in
 * mcpjamYaml.ts) rather than parsing a prefix of it, and reading exactly `cap`
 * bytes would hand it a TRUNCATED file that fits the cap perfectly — a lockfile
 * cut mid-object parses as absent (harmless) but a README cut mid-sentence still
 * yields port/path hints from whatever survived. So the extra byte is what lets
 * this function tell "the file is at the limit" from "the file is over it", and
 * an over-cap file is reported as absent, exactly as if it had been read whole
 * and rejected.
 */
async function readCapped(
  sandbox: CheckSandbox,
  relativePath: string,
  cap: number
): Promise<string | null> {
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
  if (result.exitCode === MISSING_FILE_EXIT) return null;
  if (result.exitCode !== 0) {
    // An unreadable file is not a missing one, but the difference does not
    // change what the detector can do with it, and a read failure of ours must
    // not fail somebody's PR. Treated as absent, which biases toward suppression.
    return null;
  }
  if (Buffer.byteLength(result.stdout, "utf8") > cap) return null;
  return result.stdout;
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
  mcpjamYaml: string | null;
  detection: DetectionInputs;
}> {
  const mcpjamYaml = await readCapped(
    sandbox,
    "mcpjam.yaml",
    MCPJAM_YAML_MAX_BYTES
  );
  const detection: DetectionInputs = {
    repoFiles: await readRepoFiles(sandbox),
    packageJson: await readCapped(sandbox, "package.json", DETECTION_MAX_BYTES),
    packageLockJson: await readCapped(
      sandbox,
      "package-lock.json",
      DETECTION_MAX_BYTES
    ),
    pnpmLockYaml: await readCapped(
      sandbox,
      "pnpm-lock.yaml",
      DETECTION_MAX_BYTES
    ),
    yarnLock: await readCapped(sandbox, "yarn.lock", DETECTION_MAX_BYTES),
    pyprojectToml: await readCapped(
      sandbox,
      "pyproject.toml",
      DETECTION_MAX_BYTES
    ),
    uvLock: await readCapped(sandbox, "uv.lock", DETECTION_MAX_BYTES),
    serverJson: await readCapped(sandbox, "server.json", DETECTION_MAX_BYTES),
    readme:
      (await readCapped(sandbox, "README.md", DETECTION_README_MAX_BYTES)) ??
      (await readCapped(sandbox, "readme.md", DETECTION_README_MAX_BYTES)),
  };
  return { mcpjamYaml, detection };
}

/** The pid the start command wrote before `exec`ing itself, or null. */
export async function readStartPid(
  sandbox: CheckSandbox
): Promise<number | null> {
  const result = await runInBox(
    sandbox,
    `bash -lc ${shellQuote(`cat ${SERVER_PID_PATH} 2>/dev/null || true`)}`,
    READ_TIMEOUT_MS
  );
  const pid = Number(result.stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** One process found holding the probed port. */
export type ListenerProcess = {
  pid: number;
  /** Ancestry, nearest first, up to (but not including) init. */
  ppids: number[];
  /** Process GROUP id, or null when `/proc/<pid>/stat` was unreadable. */
  pgrp: number | null;
  cwd: string | null;
  /**
   * The `realpath` of the file this process is running: the first cmdline
   * argument that resolves to a regular file, falling back to `/proc/<pid>/exe`.
   * `realpath` rather than the argument as written, because a symlink is exactly
   * the case where the path text lies about where the code lives.
   */
  mainModule: string | null;
  /** True when `mainModule` came from `/proc/<pid>/exe`, not from an argument. */
  mainModuleFromExe: boolean;
};

export type ListenerReport = {
  /** The pid we spawned, as `/proc` sees it now. */
  expected: { pid: number; alive: boolean; pgrp: number | null } | null;
  processes: ListenerProcess[];
};

/**
 * The in-box `/proc` walk, as a node one-liner.
 *
 * Written without `$`, backticks or template placeholders in the SCRIPT text:
 * it is handed to the box as `node -e "<json string>"`, and a shell that expands
 * one of those would rewrite our diagnostic. Both interpolations below are
 * integers this module validated.
 */
export function listenerScript(port: number, expectedPid: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`refusing to inspect a non-port: ${port}`);
  }
  if (!Number.isInteger(expectedPid) || expectedPid < 0) {
    throw new Error(`refusing to inspect a non-pid: ${expectedPid}`);
  }
  return [
    `const fs=require('fs');const p=require('path');`,
    `const PORT=${port};const EXPECT=${expectedPid};`,
    `const out={expected:null,processes:[]};`,
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
    `function describe(pid){const info={pid:pid,ppids:[],pgrp:null,cwd:null,mainModule:null,mainModuleFromExe:false};` +
      `const st=stat(pid);if(st){info.pgrp=st.pgrp;}` +
      `let cur=st?st.ppid:0;let guard=0;` +
      `while(cur>1&&guard<64){info.ppids.push(cur);const s2=stat(cur);if(!s2)break;cur=s2.ppid;guard++;}` +
      `try{info.cwd=fs.realpathSync('/proc/'+pid+'/cwd');}catch(e){}` +
      `let args=[];try{args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\u0000').filter(Boolean);}catch(e){}` +
      `for(let i=1;i<args.length;i++){const a=args[i];if(a.charAt(0)==='-')continue;` +
      `let abs=a;if(!p.isAbsolute(a)){if(!info.cwd)continue;abs=p.resolve(info.cwd,a);}` +
      `try{if(fs.statSync(abs).isFile()){info.mainModule=fs.realpathSync(abs);break;}}catch(e){}}` +
      `if(!info.mainModule){try{info.mainModule=fs.realpathSync('/proc/'+pid+'/exe');info.mainModuleFromExe=true;}catch(e){}}` +
      `return info;}`,
    `if(EXPECT>0){const s=stat(EXPECT);out.expected={pid:EXPECT,alive:!!s,pgrp:s?s.pgrp:null};}`,
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
      return {
        expected: (record.expected as ListenerReport["expected"]) ?? null,
        processes,
      };
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
  args: { port: number; expectedPid: number | null }
): Promise<ListenerReport | null> {
  const script = listenerScript(args.port, args.expectedPid ?? 0);
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
