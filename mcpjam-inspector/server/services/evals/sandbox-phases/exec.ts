/**
 * Run one setup or cleanup script, or one code evaluator, in an eval box
 * (EFTW-90), streaming its output into a fixed-size tail.
 *
 * The earlier attempt buffered everything a script printed and clipped it
 * afterwards; a script that prints forever then held the server's memory.
 * Here the output never accumulates: E2B streams it to `onStdout`/`onStderr`
 * with `retainOutput: false`, and only the last 8 KB is kept. The process is
 * killed at its deadline, so a hung script costs its limit and no more.
 *
 * The interpreter comes from the file extension. Evaluators run in a clean
 * environment (amendment P7): `env -i` with a fresh `HOME`, a fixed `PATH`,
 * isolated Python and no inherited Node options, so nothing the image's
 * profile or a copied file sets can change how the grader runs.
 */
import type { CommandHandle, Sandbox } from "e2b";
import { CommandExitError } from "e2b";
import { shellQuote } from "../../../utils/harness/shell-quote.js";

/** The last bytes of output kept per script or evaluator. */
export const OUTPUT_TAIL_CHARS = 8 * 1024;

/** The default template's PATH (`templates/computer/e2b.Dockerfile`). */
export const CLEAN_PATH =
  "/opt/npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export type PhaseSandbox = Pick<Sandbox, "commands" | "files">;

export type PhaseRunResult = {
  /** `exited` with a code, `timeout` when killed at the deadline, `error` when it never ran. */
  status: "exited" | "timeout" | "error";
  exitCode?: number;
  /** The combined stdout and stderr tail, at most {@link OUTPUT_TAIL_CHARS}. */
  output: string;
  durationMs: number;
  error?: string;
};

/**
 * The newest {@link OUTPUT_TAIL_CHARS} characters of a stream, kept without
 * ever holding more than twice that.
 */
export class OutputTail {
  private text = "";
  constructor(private readonly limit = OUTPUT_TAIL_CHARS) {}
  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.limit * 2) {
      this.text = this.text.slice(-this.limit);
    }
  }
  value(): string {
    return this.text.length > this.limit
      ? this.text.slice(-this.limit)
      : this.text;
  }
}

/** The command that runs a file with this name, or `undefined` for an unknown extension. */
export function interpreterFor(fileName: string): string[] | undefined {
  const extension = /\.([a-z]+)$/.exec(fileName)?.[1];
  switch (extension) {
    case "sh":
      return ["bash", "--noprofile", "--norc"];
    case "py":
      return ["python3", "-I"];
    case "ts":
    case "js":
      return ["node"];
    default:
      return undefined;
  }
}

export type RunPhaseScriptArgs = {
  sandbox: PhaseSandbox;
  /** Where the script is written before it runs. */
  scriptPath: string;
  script: string;
  /** Decides the interpreter; setup and cleanup scripts are `.sh`. */
  fileName: string;
  /** `MCPJAM_*` variables. Never a secret: they may be visible to the process tree. */
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /**
   * Run under `env -i` with this as `HOME` (created first), the fixed
   * {@link CLEAN_PATH} and nothing inherited. Evaluators only: setup and
   * cleanup scripts prepare the agent's own home.
   */
  cleanHome?: string;
};

function commandFor(args: RunPhaseScriptArgs, interpreter: string[]): string {
  const run = [...interpreter, args.scriptPath].map(shellQuote).join(" ");
  if (!args.cleanHome) return run;
  const env = {
    HOME: args.cleanHome,
    PATH: CLEAN_PATH,
    LANG: "C.UTF-8",
    // A CA path, not an option: brokered requests on a networked grading box
    // go through the egress proxy's certificate.
    NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
    ...args.env,
  };
  const assignments = Object.entries(env)
    .map(([key, value]) => shellQuote(`${key}=${value}`))
    .join(" ");
  return `mkdir -p ${shellQuote(args.cleanHome)} && exec env -i ${assignments} ${run}`;
}

/**
 * Write `script` to `scriptPath` and run it, returning its exit code and
 * output tail. Never throws for the script's own failure; an infrastructure
 * failure (the write, the connection) comes back as `status: "error"`.
 */
export async function runPhaseScript(
  args: RunPhaseScriptArgs,
): Promise<PhaseRunResult> {
  const startedAt = Date.now();
  const tail = new OutputTail();
  const done = (result: Omit<PhaseRunResult, "durationMs" | "output">) => ({
    ...result,
    output: tail.value(),
    durationMs: Date.now() - startedAt,
  });
  const interpreter = interpreterFor(args.fileName);
  if (!interpreter) {
    return done({
      status: "error",
      error: `No interpreter for ${args.fileName}. Use .sh, .py, .ts or .js.`,
    });
  }
  let handle: CommandHandle<undefined>;
  try {
    await args.sandbox.files.write(args.scriptPath, args.script);
    handle = await args.sandbox.commands.run(commandFor(args, interpreter), {
      background: true,
      cwd: args.cwd,
      ...(args.cleanHome ? {} : { envs: args.env }),
      onStdout: (data: string) => tail.push(data),
      onStderr: (data: string) => tail.push(data),
      retainOutput: false,
      // The stream outlives the deadline below, which is what kills it.
      timeoutMs: args.timeoutMs + 30_000,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (error) {
    return done({ status: "error", error: describe(error) });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), args.timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      handle.wait().then(
        (result) => ({ exitCode: result.exitCode }),
        (error: unknown) =>
          error instanceof CommandExitError
            ? { exitCode: error.exitCode }
            : { error },
      ),
      deadline,
    ]);
    if (outcome === "timeout") {
      await handle.kill().catch(() => false);
      return done({ status: "timeout" });
    }
    if ("error" in outcome) {
      return done({ status: "error", error: describe(outcome.error) });
    }
    return done({ status: "exited", exitCode: outcome.exitCode });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The last line of an output tail, for a one-line reason. */
export function lastOutputLine(output: string, max = 200): string {
  const line =
    output
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
