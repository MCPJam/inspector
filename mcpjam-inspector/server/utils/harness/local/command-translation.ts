/**
 * The one place an AI SDK `run`/`spawn` command STRING becomes something a
 * local machine actually does.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 * `Experimental_SandboxSession.run/spawn` takes `{ command: string }`, and the
 * installed adapters fill it with shell text: `mkdir -p a b`,
 * `pnpm --dir … install --frozen-lockfile`, `node …/bridge.mjs --workdir …`.
 * In a cloud sandbox that string is handed to a shell inside the box, and the
 * box is the boundary. On the user's own machine there is no box, so handing
 * it to a shell would make every adapter change — and anything that can steer
 * one — a host command-execution primitive.
 *
 * The plan offered two reviewed ways out. This is option 2: translate ONLY the
 * exact, manifest-pinned command shapes the pinned adapters emit into
 * structured operations, and reject everything else. There is deliberately NO
 * general shell parser and no `shell: true` anywhere on this path. An
 * `mkdir -p X Y` is not "parsed"; it is RECOGNIZED, and its operands are then
 * re-derived as paths and re-confined.
 *
 * ── Why a closed grammar is enough ────────────────────────────────────────
 * The grammar is small and finite because the adapters are pinned exactly
 * (`@ai-sdk/harness-claude-code@1.0.0-canary.9`,
 * `@ai-sdk/harness-codex@1.0.0-canary.9`) and every command they emit is a
 * template literal in their own source, not model- or repo-derived text. The
 * shapes are enumerated in `ADAPTER_COMMAND_SHAPES` below. An adapter upgrade
 * that changes one of them fails CLOSED — the session errors with the
 * offending string rather than guessing — and that failure is the signal to
 * re-review the manifest, which is exactly the review this design wants.
 *
 * ── Path remapping is part of the translation, not a detail ───────────────
 * The adapters hardcode `bootstrapDir = /tmp/harness/<harnessId>` and then
 * `pnpm install` a vendor CLI into it at session start. Both halves are
 * unacceptable on a host:
 *
 *   - `/tmp/harness/*` is a predictable path in a world-writable directory —
 *     a classic pre-created-symlink / TOCTOU target, and one any other process
 *     on the machine can populate before we look.
 *   - installing a package graph while starting a session is the runtime
 *     bootstrapping the plan forbids outright.
 *
 * So the translator REMAPS the adapter's bootstrap dir onto the verified,
 * read-only managed runtime bundle, and turns the install/verify commands into
 * explicit no-ops with a recorded reason. The bundle is what the adapter would
 * have built, except built in CI, digest-verified, and not writable by the
 * session. `run`'s contract is satisfied (exit 0, empty streams) without a
 * process existing at all.
 *
 * Session-scoped operands (`workDir`, `bridgeStateDir`, the synthetic home)
 * are re-confined to the session root by `confine`, so a shape that matches
 * still cannot address a path outside the grant.
 */
import { isAbsolute, normalize, sep } from "node:path";
import { assertArgvAllowed } from "./argv-policy.js";
import type { SupportedLocalHarnessId } from "./targets.js";

/** What a recognized command turns into. Every arm is something the supervisor
 *  can perform WITHOUT a shell. */
export type TranslatedCommand =
  /** Create directories (recursive, owner-only). Paths are already confined. */
  | { kind: "mkdir"; paths: readonly string[] }
  /** Answer on stdout with no process at all — the adapters' `$HOME` probe. */
  | { kind: "reply"; stdout: string }
  /** A command the managed runtime bundle already satisfies. No process runs;
   *  `reason` is recorded so an operator can see WHY nothing happened. */
  | { kind: "noop"; reason: string }
  /**
   * Launch an absolute executable with a structured argv, `shell: false`.
   *
   * Every path in `args` and `workingDirectory` has already been confined —
   * session paths to the granted roots, bundle paths to the verified bundle —
   * so the caller spawns what it is given without re-deriving anything.
   */
  | {
      kind: "exec";
      executable: string;
      args: readonly string[];
      workingDirectory: string;
    };

export class CommandTranslationError extends Error {
  readonly command: string;
  constructor(message: string, command: string) {
    super(message);
    this.name = "CommandTranslationError";
    this.command = command;
  }
}

/**
 * Everything the translator is allowed to know about a session. Supplied by
 * the supervisor, never by the adapter or the model.
 */
export interface CommandTranslationContext {
  harnessId: SupportedLocalHarnessId;
  /** The adapter's hardcoded bootstrap dir (e.g. `/tmp/harness/claude-code`),
   *  read from its manifest entry. Never touched on disk — only matched. */
  adapterBootstrapDir: string;
  /** Verified, read-only managed runtime bundle root that stands in for it. */
  managedBundleRoot: string;
  /** Absolute path to the Node launcher shipped/verified with the bundle. */
  nodeExecutable: string;
  /** Absolute canonical session root. Every writable operand must live under
   *  this, and it is the default working directory for `exec`. */
  sessionRoot: string;
  /** Synthetic HOME handed to the child; the answer to the `$HOME` probe. */
  syntheticHome: string;
  /**
   * Confine a path the command named to the session's writable area.
   *
   * Async, and the ONLY confinement on this path: an earlier draft did a cheap
   * synchronous string check here and left the real symlink-aware check to the
   * provider at the point of use. That left the bridge's own `--workdir` and
   * `--bridge-state-dir` arguments checked only by the weak half, because they
   * are consumed by the child rather than by a filesystem call we make. One
   * function, awaited everywhere, has no such seam.
   */
  confine: (path: string) => Promise<string>;
}

/**
 * The exact command shapes the pinned adapters emit, as literal documentation.
 * Kept as data so a test can assert the translator handles each one and
 * rejects a mutation of it — and so a reviewer diffing an adapter upgrade has
 * one list to compare against.
 */
export const ADAPTER_COMMAND_SHAPES: Readonly<
  Record<SupportedLocalHarnessId, readonly string[]>
> = {
  "claude-code": [
    'printf "%s" "$HOME"',
    "mkdir -p <bootstrapDir>",
    "mkdir -p <workDir> <bridgeStateDir>",
    "mkdir -p '<homeDir>'/.claude/skills",
    "pnpm --dir <bootstrapDir> install --frozen-lockfile --store-dir <bootstrapDir>/.pnpm-store",
    "cd <bootstrapDir> && if [ -f node_modules/@anthropic-ai/claude-code/install.cjs ]; " +
      "then node node_modules/@anthropic-ai/claude-code/install.cjs; fi && " +
      "./node_modules/.bin/claude --version",
    "node <bootstrapDir>/bridge.mjs --workdir <workDir> --bridge-state-dir <bridgeStateDir>",
  ],
  codex: [
    'printf "%s" "$HOME"',
    "mkdir -p <bootstrapDir>",
    "mkdir -p '<codexHomeDir>'",
    "mkdir -p '<rootDir>'",
    "mkdir -p <workDir> <bridgeStateDir>",
    "pnpm --dir <bootstrapDir> install --frozen-lockfile --store-dir <bootstrapDir>/.pnpm-store",
    "node <bootstrapDir>/bridge.mjs --workdir <workDir> --bridge-state-dir <bridgeStateDir> " +
      "--bootstrap-dir <bootstrapDir>",
  ],
};

/** The adapters' `$HOME` probe, byte for byte. */
const HOME_PROBE = 'printf "%s" "$HOME"';

/**
 * Split the operands of a recognized `mkdir -p` into paths.
 *
 * NOT a shell tokenizer. The adapters produce operands in exactly two forms:
 * a bare path with no spaces, or a POSIX single-quoted path (possibly with a
 * literal suffix, as in `'<home>'/.claude/skills`). Anything else — a double
 * quote, an unterminated quote, a `$`, a backslash escape — is unrecognized
 * and the whole command is rejected. Recognizing two forms is not the same as
 * implementing quoting rules, and the difference is the point: there is no
 * expansion step here for anything to hide in.
 */
function splitMkdirOperands(operands: string, command: string): string[] {
  const paths: string[] = [];
  let i = 0;
  while (i < operands.length) {
    if (operands[i] === " ") {
      i += 1;
      continue;
    }
    let token = "";
    while (i < operands.length && operands[i] !== " ") {
      if (operands[i] === "'") {
        const end = operands.indexOf("'", i + 1);
        if (end === -1) {
          throw new CommandTranslationError(
            "unterminated single quote in mkdir operands",
            command
          );
        }
        const inner = operands.slice(i + 1, end);
        // `shellQuote` escapes an embedded quote as `'\''`; the adapters only
        // ever quote paths they built from a `$HOME` we supplied, so an
        // embedded quote means the input is not what we think it is.
        if (inner.includes("\\")) {
          throw new CommandTranslationError(
            "backslash escape in a quoted mkdir operand",
            command
          );
        }
        token += inner;
        i = end + 1;
        continue;
      }
      token += operands[i];
      i += 1;
    }
    if (token.length > 0) paths.push(token);
  }
  if (paths.length === 0) {
    throw new CommandTranslationError("mkdir -p with no operands", command);
  }
  return paths;
}

/** Reject anything that could make an operand mean something other than the
 *  literal path it looks like. */
function assertPlainPathOperand(path: string, command: string): void {
  if (path.length === 0 || path.length > 4096) {
    throw new CommandTranslationError("implausible path operand", command);
  }
  if (/[\0\n\r"`$*?[\]{}\\|&;<>()!~]/.test(path)) {
    throw new CommandTranslationError(
      `path operand ${JSON.stringify(path)} contains a shell metacharacter or ` +
        `glob — the adapters emit literal paths, so this is not a shape we know`,
      command
    );
  }
  if (!isAbsolute(path)) {
    throw new CommandTranslationError(
      `path operand ${JSON.stringify(path)} is not absolute`,
      command
    );
  }
}

/**
 * Is `path` the adapter's bootstrap dir, or inside it?
 *
 * Compared on the NORMALIZED string, never resolved on disk: the whole reason
 * the bootstrap dir is remapped is that we refuse to touch `/tmp/harness/*`.
 * A `..` segment that normalizes out of the prefix therefore fails the check
 * and the command is rejected rather than silently remapped.
 */
function underBootstrapDir(path: string, bootstrapDir: string): boolean {
  const p = normalize(path);
  const root = normalize(bootstrapDir);
  return p === root || p.startsWith(root + "/");
}

function remapBootstrapPath(path: string, ctx: CommandTranslationContext): string {
  const root = normalize(ctx.adapterBootstrapDir);
  const normalizedPath = normalize(path);
  // Containment is checked on the NORMALIZED path before any slicing. Slicing
  // first would clamp `/tmp/harness/claude-code/../../etc` (which normalizes
  // to `/tmp/etc`) back onto the bundle root and swallow the traversal
  // silently; a path that tried to climb out is a signal, not something to
  // quietly correct.
  if (!underBootstrapDir(normalizedPath, root)) {
    throw new CommandTranslationError(
      `path ${JSON.stringify(path)} was given where a path inside the ` +
        `adapter bootstrap directory was expected`,
      path
    );
  }
  const rest = normalizedPath.slice(root.length).replace(/^\//, "");
  const mapped = rest
    ? `${ctx.managedBundleRoot}${sep}${rest.split("/").join(sep)}`
    : ctx.managedBundleRoot;
  // The remap must not be able to climb out of the bundle either.
  const normalized = normalize(mapped);
  if (
    normalized !== ctx.managedBundleRoot &&
    !normalized.startsWith(ctx.managedBundleRoot + sep)
  ) {
    throw new CommandTranslationError(
      `bootstrap path ${JSON.stringify(path)} escapes the managed bundle root`,
      path
    );
  }
  return normalized;
}

/** Translate a `mkdir -p …` command. */
async function translateMkdir(
  command: string,
  ctx: CommandTranslationContext
): Promise<TranslatedCommand> {
  const operands = command.slice("mkdir -p ".length);
  const raw = splitMkdirOperands(operands, command);
  const paths: string[] = [];
  for (const path of raw) {
    assertPlainPathOperand(path, command);
    if (underBootstrapDir(path, ctx.adapterBootstrapDir)) {
      // The bundle already exists and is read-only by design; creating it is
      // a no-op rather than an error so the adapter's bootstrap sequence
      // completes unchanged.
      continue;
    }
    paths.push(await ctx.confine(path));
  }
  if (paths.length === 0) {
    return {
      kind: "noop",
      reason: "mkdir targeted only the managed runtime bundle, which exists",
    };
  }
  return { kind: "mkdir", paths };
}

/**
 * The two bootstrap commands whose entire job is to materialize the vendor CLI
 * that the managed bundle already contains, matched as whole strings against
 * the pinned adapter templates.
 */
function matchBootstrapInstall(
  command: string,
  ctx: CommandTranslationContext
): TranslatedCommand | null {
  const b = ctx.adapterBootstrapDir;
  if (
    command ===
    `pnpm --dir ${b} install --frozen-lockfile --store-dir ${b}/.pnpm-store`
  ) {
    return {
      kind: "noop",
      reason:
        "vendor dependency graph is supplied by the digest-verified managed " +
        "runtime bundle; no package manager runs during a session",
    };
  }
  if (
    ctx.harnessId === "claude-code" &&
    command ===
      `cd ${b} && if [ -f node_modules/@anthropic-ai/claude-code/install.cjs ]; ` +
        `then node node_modules/@anthropic-ai/claude-code/install.cjs; fi && ` +
        `./node_modules/.bin/claude --version`
  ) {
    return {
      kind: "noop",
      reason:
        "vendor CLI is installed and version-verified in the managed runtime " +
        "bundle at build time; the session does not re-run its installer",
    };
  }
  return null;
}

/** Translate the adapters' `node <bootstrapDir>/bridge.mjs …` launch. */
async function matchBridgeLaunch(
  command: string,
  ctx: CommandTranslationContext
): Promise<TranslatedCommand | null> {
  const prefix = `node ${ctx.adapterBootstrapDir}/bridge.mjs `;
  if (!command.startsWith(prefix)) return null;
  const rest = command.slice(prefix.length);
  const tokens = rest.split(" ").filter((t) => t.length > 0);
  if (tokens.length % 2 !== 0) {
    throw new CommandTranslationError(
      "bridge launch arguments are not flag/value pairs",
      command
    );
  }
  // Flags the pinned bridges accept, and how each value is resolved. A flag
  // outside this map — or a repeated one — rejects the launch.
  const allowed: Record<string, "session" | "bundle"> = {
    "--workdir": "session",
    "--bridge-state-dir": "session",
    "--bootstrap-dir": "bundle",
  };
  const args: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i]!;
    const value = tokens[i + 1]!;
    const resolution = allowed[flag];
    if (resolution === undefined) {
      throw new CommandTranslationError(
        `unknown bridge flag ${JSON.stringify(flag)}`,
        command
      );
    }
    if (seen.has(flag)) {
      throw new CommandTranslationError(
        `repeated bridge flag ${JSON.stringify(flag)}`,
        command
      );
    }
    seen.add(flag);
    assertPlainPathOperand(value, command);
    args.push(
      flag,
      resolution === "bundle"
        ? remapBootstrapPath(value, ctx)
        : await ctx.confine(value)
    );
  }
  const bridge = remapBootstrapPath(
    `${ctx.adapterBootstrapDir}/bridge.mjs`,
    ctx
  );
  const argv = [bridge, ...args];
  assertArgvAllowed(argv);
  return {
    kind: "exec",
    executable: ctx.nodeExecutable,
    args: argv,
    workingDirectory: await ctx.confine(ctx.sessionRoot),
  };
}

/**
 * Translate one adapter command string, or throw.
 *
 * Order matters only for readability — the shapes are mutually exclusive. The
 * function is total: every path either returns a `TranslatedCommand` or
 * throws `CommandTranslationError`. There is no fall-through that runs a
 * shell, and adding one would be the single most damaging change possible to
 * this file.
 */
export async function translateAdapterCommand(
  command: string,
  ctx: CommandTranslationContext
): Promise<TranslatedCommand> {
  if (typeof command !== "string" || command.length === 0) {
    throw new CommandTranslationError("empty command", String(command));
  }
  if (command.length > 8192) {
    throw new CommandTranslationError(
      "command exceeds the length any pinned adapter shape can reach",
      `${command.slice(0, 120)}…`
    );
  }
  if (command !== command.trim()) {
    throw new CommandTranslationError(
      "command has leading or trailing whitespace, which no pinned shape has",
      command
    );
  }

  if (command === HOME_PROBE) {
    // Answered from the session's synthetic home. Running a real `$HOME` probe
    // would report the OS user's home, which is precisely the value the
    // synthetic config root exists to keep the vendor process away from.
    return { kind: "reply", stdout: ctx.syntheticHome };
  }

  const bootstrapNoop = matchBootstrapInstall(command, ctx);
  if (bootstrapNoop) return bootstrapNoop;

  const bridge = await matchBridgeLaunch(command, ctx);
  if (bridge) return bridge;

  if (command.startsWith("mkdir -p ")) {
    return translateMkdir(command, ctx);
  }

  throw new CommandTranslationError(
    `command is not one of the ${ctx.harnessId} adapter shapes this Inspector ` +
      `is pinned to translate. Local execution never falls back to a shell, so ` +
      `the session fails closed. If this arrived from an adapter upgrade, the ` +
      `compatibility manifest and conformance suite must be re-reviewed before ` +
      `the new shape is accepted.`,
    command
  );
}
