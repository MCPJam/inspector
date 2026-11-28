import { z } from "zod";
import { logger } from "../logger.js";
import { HARNESS_BAKE_HOME, HARNESS_STATE_DIRECTORY_NAME } from "./harness-bake.js";
import { shellQuote } from "./shell-quote.js";

const READ_AHEAD_TIMEOUT_MS = 5_000;
const observation = z.object({
  outcome: z.enum(["read", "cached", "skipped"]),
  reason: z.enum(["platform", "missing", "scope", "budget", "io"]).optional(),
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});

// Read immutable installed files only. No vendor process, configuration, hooks,
// network access or turn authority is involved. Missing layouts use normal startup.
const SCRIPT = String.raw`
import os,sys,pathlib,platform,shutil,stat,time,json,mmap,ctypes,concurrent.futures
start=time.monotonic()
def result(outcome,reason=None,count=0):
    row=dict(outcome=outcome,bytes=count,durationMs=round((time.monotonic()-start)*1000))
    if reason: row['reason']=reason
    print(json.dumps(row),flush=True)
def main():
    if platform.system()!='Linux' or platform.machine()!='x86_64':
        result('skipped','platform'); return
    root=pathlib.Path(sys.argv[1]).resolve(strict=True)
    if sys.argv[2]=='claude-code':
        package=(root/'claude-code/node_modules/@anthropic-ai/claude-agent-sdk').resolve(strict=True)
        binary=package.parent/'claude-agent-sdk-linux-x64/claude'
    elif sys.argv[2]=='codex':
        package=(root/'codex-appserver/node_modules/@openai/codex').resolve(strict=True)
        binary=package.parent/'codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
    elif sys.argv[2]=='copilot-cli':
        package=(root/'copilot-cli/node_modules/@github/copilot').resolve(strict=True)
        binary=package.parent/'copilot-linux-x64/copilot'
    elif sys.argv[2]=='opencode':
        binary=root/'opencode/node_modules/opencode-ai/bin/opencode.exe'
    else:
        result('skipped','missing'); return
    binary=binary.resolve(strict=True)
    if not binary.is_relative_to(root):
        result('skipped','scope'); return
    files=[binary]
    if sys.argv[2] in ('claude-code','codex'):
        # Node first: the bridge starts on node at once; the agent's binary runs only at dispatch.
        files.insert(0,pathlib.Path(shutil.which('node') or '/usr/local/bin/node').resolve(strict=True))
    fds=[]; jobs=[]; total=0; chunk=4*1024*1024
    libc=ctypes.CDLL(None,use_errno=True)
    libc.mincore.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_void_p]
    libc.mincore.restype=ctypes.c_int
    page=os.sysconf('SC_PAGE_SIZE')
    try:
        for path in files:
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK); fds.append(fd)
            info=os.fstat(fd); size=info.st_size; total+=size
            if not stat.S_ISREG(info.st_mode) or size==0 or total>512*1024*1024:
                result('skipped','budget'); return
            with mmap.mmap(fd,0,access=mmap.ACCESS_COPY) as mapping:
                address=ctypes.addressof(ctypes.c_char.from_buffer(mapping))
                resident=(ctypes.c_ubyte*((size+page-1)//page))()
                if libc.mincore(address,size,resident)!=0: raise OSError('residency unavailable')
                for offset in range(0,size,chunk):
                    length=min(chunk,size-offset)
                    if any(not resident[i]&1 for i in range(offset//page,(offset+length+page-1)//page)):
                        jobs.append((fd,offset,length))
        def read(job):
            fd,offset,length=job
            data=os.pread(fd,length,offset)
            if len(data)!=length: raise OSError('short immutable read')
            return len(data)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            count=sum(pool.map(read,jobs))
        result('read' if jobs else 'cached',count=count)
    finally:
        for fd in fds: os.close(fd)
try: main()
except FileNotFoundError: result('skipped','missing')
except (OSError,ValueError):
    # This optional page-cache hint cannot replace or weaken normal startup.
    result('skipped','io')
`;

export function runtimeReadAheadCommand(
  harnessId: string,
): string | undefined {
  if (!["claude-code", "codex", "copilot-cli", "opencode"].includes(harnessId)) return undefined;
  const root = `${HARNESS_BAKE_HOME}/${HARNESS_STATE_DIRECTORY_NAME}/.harness-bootstrap`;
  return `python3 -c ${shellQuote(SCRIPT)} ${shellQuote(root)} ${shellQuote(harnessId)}`;
}

type RunReadAhead = (
  command: string,
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string }>;

export async function readAheadRuntime(
  run: RunReadAhead,
  { harnessId, resuming }: { harnessId?: string; resuming?: boolean },
  signal?: AbortSignal,
): Promise<void> {
  // Even a cache-residency check costs a remote command. Resume already has
  // a loaded runtime; keep that path free of this cold-start-only hint.
  if (resuming || !harnessId) return;
  const command = runtimeReadAheadCommand(harnessId);
  if (!command) return;
  signal?.throwIfAborted();
  const start = performance.now();
  try {
    const result = await run(command, {
      timeoutMs: READ_AHEAD_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const parsed = observation.parse(JSON.parse(result.stdout));
    const callerMs = Math.round(performance.now() - start);
    logger.info(`[harness][read-ahead] outcome=${parsed.outcome} bytes=${parsed.bytes} readMs=${parsed.durationMs} callerMs=${callerMs}`, {
      harness: harnessId,
      ...parsed,
      callerMs,
    });
  } catch (error) {
    signal?.throwIfAborted();
    // A failed read-only hint falls back to the existing install/start checks.
    // Never copy command output or file paths into diagnostics.
    logger.warn("[harness][read-ahead] using normal startup", {
      harness: harnessId,
      outcome: "fallback",
      reason: error instanceof Error ? error.name : "unknown",
      callerMs: Math.round(performance.now() - start),
    });
  }
}
