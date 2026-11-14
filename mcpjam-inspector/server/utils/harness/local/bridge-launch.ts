/**
 * The bridge launch, `node '<bootstrapDir>/bridge.mjs' …`, as the closed
 * grammar in `command-translation.ts` recognizes it: the exact flag vector a
 * runtime's pinned adapter emits, each operand re-derived and confined.
 *
 * For a runtime started through the AI SDK's ACP bridge (`LocalRuntime.acp`)
 * the implementation directory is the session's own, with a descriptor that
 * starts the vendor CLI from the verified pack (`acpImplementation` below).
 */
import { normalize, posix, sep } from "node:path";
import { assertArgvAllowed } from "./argv-policy.js";
import {
  assertPlainPathOperand,
  CommandTranslationError,
  remapBootstrapPath,
  splitQuotedTokens,
  type CommandTranslationContext,
  type TranslatedCommand,
} from "./command-translation.js";
import { localRuntime } from "./runtimes/index.js";

/** Translate the adapters' `node '<bootstrapDir>/bridge.mjs' …` launch. */
export async function matchBridgeLaunch(
  command: string,
  ctx: CommandTranslationContext,
): Promise<TranslatedCommand | null> {
  if (!command.startsWith("node ")) return null;
  const tokens = splitQuotedTokens(command.slice("node ".length), command);

  // The EXACT flag vector the pinned adapter emits, in order. Matching a
  // subset, a permutation, or another runtime's flags would let an adapter
  // change slip through as a valid launch — the opposite of the fail-closed
  // behaviour this module promises.
  const runtime = localRuntime(ctx.harnessId);
  const { bridgeFlags: flags, sessionStateFlags, literalFlags } = runtime.commands;
  const files: Array<{ path: string; content: string }> = [];

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
    ctx.bridgeLauncherPath ??
      (ctx.layerRoot !== undefined
        ? `${ctx.layerRoot}${sep}bridge.mjs`
        : remapBootstrapPath(expectedBridge, ctx)),
    // The launcher's own argument, never the bridge's: only where a launcher
    // is in front, and only the verified pack.
    ...(ctx.bridgeLauncherPath !== undefined && ctx.launcherVendorRoot !== undefined
      ? ["--mcpjam-vendor-root", ctx.launcherVendorRoot]
      : []),
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
    const literal = literalFlags?.[flag];
    if (literal !== undefined) {
      if (value !== literal) {
        throw new CommandTranslationError(
          `${flag} must be ${JSON.stringify(literal)}, found ${JSON.stringify(value)}`,
          command,
        );
      }
      args.push(flag, value);
      continue;
    }
    assertPlainPathOperand(value, command);
    if (runtime.acp !== undefined && flag === runtime.acp.implementationDirFlag) {
      const implementation = acpImplementation(value, ctx, command);
      files.push(implementation.file);
      args.push(flag, implementation.directory);
      continue;
    }
    if (flag === "--bootstrap-dir") {
      // Exactly the adapter's bootstrap directory. In a sandbox it holds
      // everything; locally it is SPLIT along the two trusted sources: the
      // vendor half (Codex's `bin/codex.js` and platform package) is the
      // digest-verified pack, and the MCPJam half (the host-tools MCP
      // entrypoint Codex spawns) is the Inspector layer.
      if (
        posix.normalize(value) !== posix.normalize(ctx.adapterBootstrapDir)
      ) {
        throw new CommandTranslationError(
          `--bootstrap-dir names ${JSON.stringify(value)}, but the only ` +
            `bootstrap this session may load is its managed bundle`,
          command,
        );
      }
      if (ctx.layerRoot !== undefined) {
        args.push(
          "--vendor-dir",
          remapBootstrapPath(value, ctx),
          "--layer-dir",
          ctx.layerRoot,
        );
      } else {
        args.push(flag, remapBootstrapPath(value, ctx));
      }
      continue;
    }
    if (sessionStateFlags.includes(flag)) {
      // Runtime state (Codex's rollouts, CODEX_HOME, the relay credential)
      // stays in the session's own directory, never in the user's checkout.
      args.push(flag, await (ctx.confineToSessionState ?? ctx.confine)(value));
      continue;
    }
    args.push(flag, await ctx.confine(value));
  }
  assertArgvAllowed(args);
  return {
    kind: "exec",
    executable: ctx.nodeExecutable,
    args,
    workingDirectory: await ctx.confine(ctx.sessionRoot),
    ...(files.length > 0 ? { files } : {}),
  };
}

/**
 * Exactly the directory the adapter would install the CLI into. Locally the
 * CLI is the verified pack's, so the bridge reads a descriptor from the
 * session's own state that starts it from there, with no private home: the
 * session's synthetic home is the CLI's.
 */
function acpImplementation(
  value: string,
  ctx: CommandTranslationContext,
  command: string,
): { directory: string; file: { path: string; content: string } } {
  const acp = localRuntime(ctx.harnessId).acp!;
  const expected = `${ctx.adapterBootstrapDir}/implementation`;
  if (posix.normalize(value) !== posix.normalize(expected)) {
    throw new CommandTranslationError(
      `${acp.implementationDirFlag} names ${JSON.stringify(value)}, but the only implementation ` +
        `this session may start is the one in its managed bundle`,
      command,
    );
  }
  const directory = `${ctx.bootstrapOverlayDir}${sep}implementation`;
  const agent = acp.agent(
    (...segments) => normalize([ctx.managedBundleRoot, ...segments].join(sep)),
    ctx.platform ?? process.platform,
  );
  const descriptor = { executablePath: agent.executable, args: [...agent.args], privateHome: false, envKeys: [] };
  return {
    directory,
    file: { path: `${directory}${sep}implementation.json`, content: `${JSON.stringify(descriptor, null, 2)}\n` },
  };
}
