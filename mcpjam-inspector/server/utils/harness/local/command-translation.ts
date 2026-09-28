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
 * The grammar is small and finite because the framework and adapters are
 * pinned exactly (`@ai-sdk/harness@1.0.96`,
 * `@ai-sdk/harness-claude-code@1.0.100`, `@ai-sdk/harness-codex@1.0.98`) and
 * every command they emit is a literal in their own source, not model- or
 * repo-derived text. The shapes are enumerated in `ADAPTER_COMMAND_SHAPES`
 * below. An adapter upgrade that changes one of them fails CLOSED — the
 * session errors with the offending string rather than guessing — and that
 * failure is the signal to re-review the manifest.
 *
 * That is not hypothetical: this module was first written against the
 * `1.0.0-canary.9` adapters, and the move to the stable line changed almost
 * every shape — the bootstrap directory went from an absolute `/tmp` path to
 * one relative to the working directory, operands became shell-quoted, Codex
 * swapped `--bootstrap-dir` for `--cli-shim-dir`, and the framework moved two
 * of its own `mkdir`s onto environment-variable indirection. The pin caught
 * it, which is the whole point of having one.
 *
 * ── Path remapping is part of the translation, not a detail ───────────────
 * The adapters declare `bootstrapDir = .harness-bootstrap/<harnessId>`, which
 * the framework resolves against the session's default working directory — for
 * us, the user's granted workspace — and then `pnpm install` a vendor CLI into
 * it at session start. Both halves are unacceptable on a host:
 *
 *   - a vendor CLI's whole dependency graph does not belong inside somebody's
 *     checkout, where it lands in their working tree and their VCS status;
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
// `posix` for every string the ADAPTER wrote, `normalize`/`sep` for every
// path this module composes for the OS. The adapters emit POSIX text on every
// platform — `posix.resolve`, forward slashes, `shellQuote` — because in their
// model the sandbox is a remote Linux machine; on Windows the provider presents
// the session's roots in that shape too (`adapter-path.ts`). So an operand is
// judged as POSIX text everywhere, and the host's own path flavour only enters
// when a result is mapped onto the managed bundle or the session overlay.
import { normalize, posix, sep } from "node:path";
import { assertArgvAllowed } from "./argv-policy.js";
import type { SupportedLocalHarnessId } from "./targets.js";

/** What a recognized command turns into. Every arm is something the supervisor
 *  can perform WITHOUT a shell. */
export type TranslatedCommand =
  /** Create directories (recursive, owner-only). Paths are already confined. */
  | { kind: "mkdir"; paths: readonly string[] }
  /** Answer on stdout with no process at all — the framework's `pwd` probe. */
  | { kind: "reply"; stdout: string; exitCode?: number }
  /** The framework's skills writer, which runs on EVERY prompt turn even with
   *  zero skills. All three operate ONLY inside the synthetic home; an operand
   *  naming anything else is refused rather than confined. */
  | { kind: "rename"; from: string; to: string }
  | { kind: "remove"; paths: readonly string[] }
  | { kind: "probe-absent"; path: string }
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
  /**
   * The adapter's declared bootstrap directory as the framework resolves it —
   * `<defaultWorkingDirectory>/.harness-bootstrap/<harnessId>`. Never touched
   * on disk: it is matched, and every reference to it is remapped onto the
   * verified managed bundle.
   */
  adapterBootstrapDir: string;
  /** Verified, read-only managed runtime bundle root that stands in for it. */
  managedBundleRoot: string;
  /**
   * The pinned adapter's declared bootstrap files, relative to
   * `adapterBootstrapDir`. Straight from the manifest — an adapter cannot
   * widen its own list.
   */
  adapterBootstrapFiles: readonly string[];
  /**
   * Session-owned directory that stands in for the writable half of the
   * bootstrap directory: the framework's `.bootstrap-<identity>.ok` marker,
   * and nothing else. Owner-only, disposable, and outside the user's checkout.
   */
  bootstrapOverlayDir: string;
  /** Absolute path to the Node launcher shipped/verified with the bundle. */
  nodeExecutable: string;
  /**
   * The script the bridge launch actually runs, when the pack ships a launcher
   * wrapper in front of the verbatim `bridge.mjs`.
   *
   * The adapters' bridges bind `0.0.0.0`, and the provider byte-compares the
   * recipe's `bridge.mjs` against the pack's copy — so the loopback constraint
   * cannot be applied by editing the bridge. The pack's `launcher.mjs` forces
   * every listener onto loopback and then imports the unmodified bridge.
   *
   * Optional: a pack without a launcher launches the remapped `bridge.mjs`
   * itself, and the exposure probe is what refuses it.
   */
  bridgeLauncherPath?: string;
  /** Absolute canonical session root: the granted workspace, and the session's
   *  `defaultWorkingDirectory`. Every writable operand must live under it or
   *  under the session state directory, and it is the default cwd for `exec`. */
  sessionRoot: string;
  /** Synthetic HOME handed to the child. */
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
  Record<SupportedLocalHarnessId | "framework", readonly string[]>
> = {
  // Issued by `@ai-sdk/harness` itself, for every adapter. The two `mkdir`s
  // pass their path through the environment rather than the command string,
  // which is why those two shapes have no interpolation to inspect.
  framework: [
    'mkdir -p "$BOOTSTRAP_DIR"',
    'mkdir -p "$WORK_DIR"',
    "pwd",
    // `resolveSandboxHomeDir` probes the child's home with this exact string
    // before every bridge start. It was missing from the grammar, so every
    // local session failed closed at translation before it ever launched.
    'printf "%s" "$HOME"',
    // `writeSkills` runs on EVERY prompt turn, even with zero skills, and
    // issues these three shapes against `$HOME/.claude/skills`. None were
    // translated before, so no local turn could complete.
    "mv -f '<manifest>.tmp' '<manifest>'",
    "test ! -e '<skillDir>'",
    "rm -rf -- '<skillDir>' …",
  ],
  "claude-code": [
    "pnpm install --frozen-lockfile --store-dir .pnpm-store",
    "./node_modules/.bin/claude --version",
    "mkdir -p '<workDir>' '<bridgeStateDir>'",
    "node '<bootstrapDir>/bridge.mjs' --workdir '<workDir>' --bridge-state-dir '<bridgeStateDir>'",
  ],
  codex: [
    "pnpm install --frozen-lockfile --store-dir .pnpm-store",
    "mkdir -p '<workDir>' '<bridgeStateDir>'",
    "node '<bootstrapDir>/bridge.mjs' --workdir '<workDir>' --bridge-state-dir " +
      "'<bridgeStateDir>' --cli-shim-dir '<cliShimDir>'",
  ],
};

/**
 * The framework's working-directory probe. Only issued when a session does not
 * expose `defaultWorkingDirectory` — ours does, so in practice this never
 * arrives. Answered from the session root regardless, because running a real
 * `pwd` would mean starting a shell to learn a value we already hold.
 */
const PWD_PROBE = "pwd";
/** The framework's home-directory probe (`resolveSandboxHomeDir`). */
const HOME_PROBE = 'printf "%s" "$HOME"';

/**
 * The framework's two environment-indirected `mkdir`s. The path travels in
 * `env`, not in the command string, so these are matched as whole literals and
 * their operand is read from the environment the caller passed.
 */
const ENV_MKDIR_SHAPES: Readonly<Record<string, string>> = {
  'mkdir -p "$BOOTSTRAP_DIR"': "BOOTSTRAP_DIR",
  'mkdir -p "$WORK_DIR"': "WORK_DIR",
};

/**
 * Split the operands of a recognized `mkdir -p` into paths.
 *
 * NOT a shell tokenizer. The pinned code produces operands in exactly two
 * forms: a bare token with no spaces, or a POSIX single-quoted string (the
 * `shellQuote` the adapters apply to every path). Anything else — a double
 * quote, an unterminated quote, a `$`, a backslash escape — is unrecognized
 * and the whole command is rejected. Recognizing two forms is not the same as
 * implementing quoting rules, and the difference is the point: there is no
 * expansion step here for anything to hide in.
 */
function splitQuotedTokens(operands: string, command: string): string[] {
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
            command,
          );
        }
        const inner = operands.slice(i + 1, end);
        // `shellQuote` escapes an embedded quote as `'\''`; the adapters only
        // ever quote paths they built from a `$HOME` we supplied, so an
        // embedded quote means the input is not what we think it is.
        if (inner.includes("\\")) {
          throw new CommandTranslationError(
            "backslash escape in a quoted mkdir operand",
            command,
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
      `path operand ${JSON.stringify(
        path,
      )} contains a shell metacharacter or ` +
        `glob — the adapters emit literal paths, so this is not a shape we know`,
      command,
    );
  }
  if (!posix.isAbsolute(path)) {
    throw new CommandTranslationError(
      `path operand ${JSON.stringify(path)} is not absolute`,
      command,
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
  const p = posix.normalize(path);
  const root = posix.normalize(bootstrapDir);
  return p === root || p.startsWith(root + "/");
}

function remapBootstrapPath(
  path: string,
  ctx: CommandTranslationContext,
): string {
  const root = posix.normalize(ctx.adapterBootstrapDir);
  const normalizedPath = posix.normalize(path);
  // Containment is checked on the NORMALIZED path before any slicing. Slicing
  // first would clamp `/tmp/harness/claude-code/../../etc` (which normalizes
  // to `/tmp/etc`) back onto the bundle root and swallow the traversal
  // silently; a path that tried to climb out is a signal, not something to
  // quietly correct.
  if (!underBootstrapDir(normalizedPath, root)) {
    throw new CommandTranslationError(
      `path ${JSON.stringify(path)} was given where a path inside the ` +
        `adapter bootstrap directory was expected`,
      path,
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
      path,
    );
  }
  return normalized;
}

/**
 * The framework's per-identity bootstrap marker: `.bootstrap-<identity>.ok`,
 * a direct child of the bootstrap directory. Identities are adapter-derived
 * slugs, so the character class is deliberately narrow — a marker name is not
 * a place to accept arbitrary text.
 */
const BOOTSTRAP_MARKER = /^\.bootstrap-[A-Za-z0-9._-]{1,128}\.ok$/;

/**
 * Where a file operation on a path inside the adapter's bootstrap directory
 * must actually go.
 *
 * `run` is not the only way the bootstrap recipe reaches the machine: the
 * framework applies the recipe's FILES by calling `writeTextFile` on the
 * session. Translating the commands but letting the writes through would put
 * the adapter's `package.json`, `pnpm-lock.yaml` and `bridge.mjs` into the
 * user's checkout — dead files, since every reference to them is remapped onto
 * the managed bundle, and visible in their VCS status. So the same closed
 * grammar applies to file paths.
 */
export type BootstrapFileTarget =
  /** Not a bootstrap path. The caller proceeds with its normal confinement. */
  | { kind: "workspace" }
  /** A declared adapter asset the verified bundle already provides. */
  | { kind: "bundle-asset"; bundlePath: string; relativePath: string }
  /** The framework's own bootstrap marker, kept in session-owned state. */
  | { kind: "session-overlay"; overlayPath: string };

/**
 * Classify a file path the adapter or framework named.
 *
 * Fails closed: a path under the bootstrap directory that is neither a
 * declared asset nor the marker is rejected rather than written somewhere
 * plausible, because an unrecognized bootstrap file means the recipe changed
 * and the manifest has not been re-reviewed.
 */
export function classifyBootstrapPath(
  path: string,
  ctx: CommandTranslationContext,
): BootstrapFileTarget {
  const root = posix.normalize(ctx.adapterBootstrapDir);
  const normalized = posix.normalize(path);
  if (!underBootstrapDir(normalized, root)) return { kind: "workspace" };

  const relative = normalized.slice(root.length).replace(/^\//, "");
  if (relative.length === 0) {
    throw new CommandTranslationError(
      `the adapter bootstrap directory itself is not a file`,
      path,
    );
  }
  if (BOOTSTRAP_MARKER.test(relative)) {
    return {
      kind: "session-overlay",
      overlayPath: `${ctx.bootstrapOverlayDir}${sep}${relative}`,
    };
  }
  if (ctx.adapterBootstrapFiles.includes(relative)) {
    return {
      kind: "bundle-asset",
      bundlePath: remapBootstrapPath(normalized, ctx),
      relativePath: relative,
    };
  }
  throw new CommandTranslationError(
    `file ${JSON.stringify(relative)} is not part of the pinned ` +
      `${ctx.harnessId} bootstrap recipe, so this session will not create it. ` +
      `An adapter upgrade that adds a bootstrap file needs a manifest review.`,
    path,
  );
}

// Every skills-write operand must live inside the synthetic home — that is the
// only place the pinned framework writes skills. A shape naming anything else
// is refused even though `confine` would happily accept it: the narrower rule
// is what makes an adapter change visible instead of silently honoured.
function assertUnderSyntheticHome(
  path: string,
  ctx: CommandTranslationContext,
  command: string,
): void {
  const home = posix.normalize(ctx.syntheticHome);
  const p = posix.normalize(path);
  if (p === home || !p.startsWith(home + "/")) {
    throw new CommandTranslationError(
      `path operand ${JSON.stringify(path)} is outside the session's synthetic ` +
        `home; the skills-write shapes are only honoured there`,
      command,
    );
  }
}

async function translateSkillsMove(
  command: string,
  ctx: CommandTranslationContext,
): Promise<TranslatedCommand> {
  const ops = splitQuotedTokens(command.slice("mv -f ".length), command);
  if (ops.length !== 2) {
    throw new CommandTranslationError("mv -f needs exactly two operands", command);
  }
  for (const p of ops) {
    assertPlainPathOperand(p, command);
    assertUnderSyntheticHome(p, ctx, command);
  }
  return {
    kind: "rename",
    from: await ctx.confine(ops[0]!),
    to: await ctx.confine(ops[1]!),
  };
}

async function translateSkillsProbe(
  command: string,
  ctx: CommandTranslationContext,
): Promise<TranslatedCommand> {
  const ops = splitQuotedTokens(command.slice("test ! -e ".length), command);
  if (ops.length !== 1) {
    throw new CommandTranslationError("test ! -e needs exactly one operand", command);
  }
  assertPlainPathOperand(ops[0]!, command);
  assertUnderSyntheticHome(ops[0]!, ctx, command);
  return { kind: "probe-absent", path: await ctx.confine(ops[0]!) };
}

async function translateSkillsRemove(
  command: string,
  ctx: CommandTranslationContext,
): Promise<TranslatedCommand> {
  const ops = splitQuotedTokens(command.slice("rm -rf -- ".length), command);
  if (ops.length === 0) {
    throw new CommandTranslationError("rm -rf -- with no operands", command);
  }
  const paths: string[] = [];
  for (const p of ops) {
    assertPlainPathOperand(p, command);
    assertUnderSyntheticHome(p, ctx, command);
    paths.push(await ctx.confine(p));
  }
  return { kind: "remove", paths };
}

/** Translate a `mkdir -p …` command. */
async function translateMkdir(
  command: string,
  ctx: CommandTranslationContext,
): Promise<TranslatedCommand> {
  const raw = splitQuotedTokens(command.slice("mkdir -p ".length), command);
  if (raw.length === 0) {
    throw new CommandTranslationError("mkdir -p with no operands", command);
  }
  const paths: string[] = [];
  for (const path of raw) {
    assertPlainPathOperand(path, command);
    if (underBootstrapDir(path, posix.normalize(ctx.adapterBootstrapDir))) {
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
 * Commands whose entire job is to materialize the vendor CLI that the managed
 * bundle already contains.
 *
 * The stable line runs these with `workingDirectory` set to the bootstrap
 * directory, so they carry no path in the command string at all — which is
 * why they are matched as exact literals and the working directory is checked
 * separately by the caller.
 */
function matchBootstrapInstall(
  command: string,
  ctx: CommandTranslationContext,
): TranslatedCommand | null {
  if (command === "pnpm install --frozen-lockfile --store-dir .pnpm-store") {
    return {
      kind: "noop",
      reason:
        "vendor dependency graph is supplied by the digest-verified managed " +
        "runtime bundle; no package manager runs during a session",
    };
  }
  if (
    ctx.harnessId === "claude-code" &&
    command === "./node_modules/.bin/claude --version"
  ) {
    return {
      kind: "noop",
      reason:
        "vendor CLI is installed and version-verified in the managed runtime " +
        "bundle at build time; the session does not re-run its version probe",
    };
  }
  return null;
}

/** Translate the adapters' `node '<bootstrapDir>/bridge.mjs' …` launch. */
async function matchBridgeLaunch(
  command: string,
  ctx: CommandTranslationContext,
): Promise<TranslatedCommand | null> {
  if (!command.startsWith("node ")) return null;
  const tokens = splitQuotedTokens(command.slice("node ".length), command);

  // The EXACT flag vector each pinned adapter emits, in order. Matching a
  // subset, a permutation, or another harness's flags would let an adapter
  // change slip through as a valid launch — the opposite of the fail-closed
  // behaviour this module promises. Codex carries `--cli-shim-dir`; Claude
  // Code does not.
  const expected: Readonly<Record<SupportedLocalHarnessId, readonly string[]>> =
    {
      "claude-code": ["--workdir", "--bridge-state-dir"],
      codex: ["--workdir", "--bridge-state-dir", "--cli-shim-dir"],
    };
  const flags = expected[ctx.harnessId];

  if (tokens.length !== 1 + flags.length * 2) {
    throw new CommandTranslationError(
      `the ${ctx.harnessId} bridge launch must be the bridge path followed by ` +
        `exactly ${flags.join(", ")}, but ${tokens.length} tokens were given`,
      command,
    );
  }

  const bridgeToken = tokens[0]!;
  assertPlainPathOperand(bridgeToken, command);
  const expectedBridge = `${ctx.adapterBootstrapDir}/bridge.mjs`;
  if (posix.normalize(bridgeToken) !== posix.normalize(expectedBridge)) {
    throw new CommandTranslationError(
      `bridge launch names ${JSON.stringify(bridgeToken)}, but the only ` +
        `bridge this session may run is the one in its managed bundle`,
      command,
    );
  }

  const args: string[] = [
    ctx.bridgeLauncherPath ?? remapBootstrapPath(expectedBridge, ctx),
  ];
  for (let i = 0; i < flags.length; i += 1) {
    const flag = tokens[1 + i * 2]!;
    const value = tokens[2 + i * 2]!;
    if (flag !== flags[i]) {
      throw new CommandTranslationError(
        `expected bridge flag ${JSON.stringify(flags[i])} at position ` +
          `${i + 1}, found ${JSON.stringify(flag)}`,
        command,
      );
    }
    assertPlainPathOperand(value, command);
    args.push(flag, await ctx.confine(value));
  }
  assertArgvAllowed(args);
  return {
    kind: "exec",
    executable: ctx.nodeExecutable,
    args,
    workingDirectory: await ctx.confine(ctx.sessionRoot),
  };
}

/**
 * Translate one framework/adapter command, or throw.
 *
 * Takes the whole `SandboxProcessOptions` shape, not just the string: the
 * stable line carries meaning in all three fields — the bootstrap commands are
 * identified by running in the bootstrap directory, and two of the framework's
 * `mkdir`s pass their operand through `env` rather than the command text.
 *
 * The function is total: every path either returns a `TranslatedCommand` or
 * throws `CommandTranslationError`. There is no fall-through that runs a
 * shell, and adding one would be the single most damaging change possible to
 * this file.
 */
export async function translateAdapterCommand(
  invocation: {
    command: string;
    workingDirectory?: string | undefined;
    env?: Readonly<Record<string, string>> | undefined;
  },
  ctx: CommandTranslationContext,
): Promise<TranslatedCommand> {
  const { command } = invocation;
  if (typeof command !== "string" || command.length === 0) {
    throw new CommandTranslationError("empty command", String(command));
  }
  if (command.length > 8192) {
    throw new CommandTranslationError(
      "command exceeds the length any pinned adapter shape can reach",
      `${command.slice(0, 120)}…`,
    );
  }
  if (command !== command.trim()) {
    throw new CommandTranslationError(
      "command has leading or trailing whitespace, which no pinned shape has",
      command,
    );
  }

  if (command === PWD_PROBE) {
    return { kind: "reply", stdout: ctx.sessionRoot };
  }
  // Answered from the synthetic home we handed the child, with no process at
  // all — same reasoning as `pwd` above.
  if (command === HOME_PROBE) {
    return { kind: "reply", stdout: ctx.syntheticHome };
  }

  // The framework's environment-indirected mkdirs. The operand never appears
  // in the command text, so it is read from the environment the caller passed
  // and confined like any other path.
  const envVar = ENV_MKDIR_SHAPES[command];
  if (envVar !== undefined) {
    const target = invocation.env?.[envVar];
    if (typeof target !== "string" || target.length === 0) {
      throw new CommandTranslationError(
        `${command} was issued without a ${envVar} value to create`,
        command,
      );
    }
    assertPlainPathOperand(target, command);
    if (underBootstrapDir(target, posix.normalize(ctx.adapterBootstrapDir))) {
      return {
        kind: "noop",
        reason:
          "mkdir targeted the adapter bootstrap directory, which is served by " +
          "the read-only managed runtime bundle",
      };
    }
    return { kind: "mkdir", paths: [await ctx.confine(target)] };
  }

  const bootstrapNoop = matchBootstrapInstall(command, ctx);
  if (bootstrapNoop) {
    // These are identified partly by WHERE they run: the framework sets the
    // bootstrap directory as their working directory, and the same string
    // arriving from anywhere else is not the shape we reviewed.
    const cwd = invocation.workingDirectory;
    if (
      cwd !== undefined &&
      posix.normalize(cwd) !== posix.normalize(ctx.adapterBootstrapDir)
    ) {
      throw new CommandTranslationError(
        `a bootstrap command was issued from ${JSON.stringify(cwd)} rather ` +
          `than the adapter's bootstrap directory`,
        command,
      );
    }
    return bootstrapNoop;
  }

  const bridge = await matchBridgeLaunch(command, ctx);
  if (bridge) return bridge;

  if (command.startsWith("mkdir -p ")) {
    return translateMkdir(command, ctx);
  }
  // The skills-write shapes (see `ADAPTER_COMMAND_SHAPES.framework`).
  if (command.startsWith("mv -f ")) return translateSkillsMove(command, ctx);
  if (command.startsWith("test ! -e ")) return translateSkillsProbe(command, ctx);
  if (command.startsWith("rm -rf -- ")) return translateSkillsRemove(command, ctx);

  throw new CommandTranslationError(
    `command is not one of the ${ctx.harnessId} adapter shapes this Inspector ` +
      `is pinned to translate. Local execution never falls back to a shell, so ` +
      `the session fails closed. If this arrived from an adapter upgrade, the ` +
      `compatibility manifest and conformance suite must be re-reviewed before ` +
      `the new shape is accepted.`,
    command,
  );
}
