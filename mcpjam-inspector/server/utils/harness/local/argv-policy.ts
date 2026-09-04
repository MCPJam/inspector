/**
 * Argv policy — what a supervised local harness process is allowed to be
 * launched with.
 *
 * Two independent jobs, both fail-closed:
 *
 *  1. STRUCTURE. Nothing that reaches `spawn` may look like shell syntax, a
 *     NUL, a newline, or an unbounded blob. The supervisor already spawns with
 *     `shell: false`, so a `;` in an argument is inert — but an argument that
 *     WANTS to be shell syntax is evidence the caller built it from a string,
 *     and that caller is the bug. Rejecting the shape keeps the mistake from
 *     ever compiling into a launch.
 *
 *  2. CAPABILITY. Vendor CLIs ship flags whose entire purpose is to switch off
 *     the permission controls native mode depends on
 *     (`--dangerously-skip-permissions`, `--sandbox danger-full-access`, …).
 *     Native mode's guarantee is "the vendor's own controls are on"; a flag
 *     that turns them off deletes the guarantee. They are DENIED here rather
 *     than merely "not passed", because the check must also catch a flag that
 *     arrives from an adapter change, a manifest edit, or a future caller.
 *
 * This is a denylist over a CLOSED argv set, not over user input: every
 * argument the supervisor ever sees is product-authored or manifest-pinned
 * (see `command-translation.ts`). A denylist would be the wrong tool against
 * open input; here it is a second fence behind a whitelist.
 */

/** Longest single argument the supervisor will pass. Bridge argv carries
 *  paths, not payloads. */
const MAX_ARG_LENGTH = 4096;
/** Most arguments any launch may carry. */
const MAX_ARG_COUNT = 64;

/**
 * Flags that disable a vendor harness's permission/sandbox controls.
 *
 * Matched case-insensitively against the whole argument AND against the part
 * before `=`, so `--sandbox=danger-full-access` is caught alongside
 * `--sandbox danger-full-access`. Values are matched too (a bare `--sandbox`
 * is legitimate; `danger-full-access` never is).
 *
 * Exported so a test can lock the list: adding an entry is free, REMOVING one
 * is a security-sensitive change that must show up in review.
 */
/**
 * Flag/value pairs denied in their SEPARATED form (`--flag value`).
 *
 * The single-argument denylist below catches `--flag=value`, but the same
 * request spelled as two argv entries would slip past it: neither
 * `--ask-for-approval` nor `never` is denied on its own, yet together they are
 * exactly the bypass being refused. Checked across adjacent entries in
 * `assertArgvAllowed`.
 */
export const DENIED_ARGV_FLAG_VALUES: Readonly<
  Record<string, readonly string[]>
> = {
  "--ask-for-approval": ["never"],
  "--sandbox": ["danger-full-access"],
  "--sandbox-mode": ["danger-full-access"],
  "--permission-mode": ["bypasspermissions"],
  "--approval-policy": ["never"],
};

export const DENIED_ARGV_CAPABILITIES: readonly string[] = [
  // Claude Code
  "--dangerously-skip-permissions",
  "--dangerously-allow-browser",
  "--permission-mode=bypasspermissions",
  "bypasspermissions",
  // Codex / OpenAI
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--full-auto",
  "danger-full-access",
  "--ask-for-approval=never",
  // Generic shapes seen across vendor CLIs
  "--no-sandbox",
  "--disable-sandbox",
  "--skip-permissions",
  "--allow-all",
  "--trust-all",
];

/** Characters that must never appear in an argument the supervisor passes.
 *  NUL truncates in the syscall layer; the rest are shell metacharacters whose
 *  presence means a caller built this from a command string. */
const FORBIDDEN_ARG_CHARS = /[\0\n\r;|&`$<>]/;

export class ArgvPolicyViolation extends Error {
  readonly argument: string;
  readonly rule: "structure" | "capability" | "count";
  constructor(
    message: string,
    rule: "structure" | "capability" | "count",
    argument: string,
  ) {
    super(message);
    this.name = "ArgvPolicyViolation";
    this.rule = rule;
    this.argument = argument;
  }
}

function normalizeForCapabilityCheck(arg: string): string[] {
  const lower = arg.toLowerCase();
  const eq = lower.indexOf("=");
  // Check the whole argument, and — for `--flag=value` — the flag and the
  // value separately, so a denied value cannot hide behind an allowed flag.
  return eq === -1 ? [lower] : [lower, lower.slice(0, eq), lower.slice(eq + 1)];
}

/**
 * Validate one argument. Throws `ArgvPolicyViolation` rather than returning a
 * boolean: every caller of this is on a launch path, and a launch that ignores
 * a policy failure is exactly the bug this module exists to make impossible.
 */
export function assertArgumentAllowed(arg: string): void {
  if (typeof arg !== "string") {
    throw new ArgvPolicyViolation(
      "argv entries must be strings",
      "structure",
      String(arg),
    );
  }
  if (arg.length === 0) {
    throw new ArgvPolicyViolation("empty argv entry", "structure", arg);
  }
  if (arg.length > MAX_ARG_LENGTH) {
    throw new ArgvPolicyViolation(
      `argv entry exceeds ${MAX_ARG_LENGTH} characters`,
      "structure",
      `${arg.slice(0, 64)}…`,
    );
  }
  const forbidden = FORBIDDEN_ARG_CHARS.exec(arg);
  if (forbidden) {
    throw new ArgvPolicyViolation(
      `argv entry contains shell metacharacter ${JSON.stringify(
        forbidden[0],
      )} ` +
        `— the supervisor never uses a shell, so this argument was built from ` +
        `a command string rather than structured input`,
      "structure",
      arg,
    );
  }
  // `--flag=value` is checked against the flag/value table as well: an entry
  // there is denied in BOTH spellings, so a vendor cannot slip past the
  // separated-form check simply by using an equals sign.
  const eq = arg.indexOf("=");
  if (eq !== -1) {
    const flag = arg.slice(0, eq).toLowerCase();
    const value = arg.slice(eq + 1).toLowerCase();
    if (DENIED_ARGV_FLAG_VALUES[flag]?.includes(value)) {
      throw new ArgvPolicyViolation(
        `argv entry ${JSON.stringify(
          arg,
        )} requests a value that disables the ` +
          `vendor permission controls local execution depends on`,
        "capability",
        arg,
      );
    }
  }

  const candidates = normalizeForCapabilityCheck(arg);
  for (const denied of DENIED_ARGV_CAPABILITIES) {
    if (candidates.includes(denied)) {
      throw new ArgvPolicyViolation(
        `argv entry ${JSON.stringify(arg)} requests ${JSON.stringify(
          denied,
        )}, ` +
          `which disables the vendor permission controls local execution ` +
          `depends on`,
        "capability",
        arg,
      );
    }
  }
}

/** Validate a whole argv vector. Returns it unchanged so call sites can write
 *  `spawn(exe, assertArgvAllowed(args))` and cannot forget the check. */
export function assertArgvAllowed(args: readonly string[]): readonly string[] {
  if (args.length > MAX_ARG_COUNT) {
    throw new ArgvPolicyViolation(
      `argv has ${args.length} entries (max ${MAX_ARG_COUNT})`,
      "count",
      "",
    );
  }
  for (const arg of args) assertArgumentAllowed(arg);
  // Then the separated `--flag value` spelling, which no single-entry check
  // can see.
  for (let i = 0; i < args.length - 1; i += 1) {
    const flag = args[i]!.toLowerCase();
    const denied = DENIED_ARGV_FLAG_VALUES[flag];
    if (denied && denied.includes(args[i + 1]!.toLowerCase())) {
      throw new ArgvPolicyViolation(
        `argv requests ${JSON.stringify(`${args[i]} ${args[i + 1]}`)}, which ` +
          `disables the vendor permission controls local execution depends on`,
        "capability",
        args[i]!,
      );
    }
  }
  return args;
}
