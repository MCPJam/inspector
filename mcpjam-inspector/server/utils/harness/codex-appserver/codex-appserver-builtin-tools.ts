/**
 * The actions this transport can attribute to Codex, as a display catalog.
 *
 * NOT an invented tool list, and not a copy of the exec transport's. Codex
 * app-server reports what the agent did as typed ITEMS; these are the items the
 * bridge turns into named tool calls, keyed by the name it emits. The catalog
 * and the translator are two views of one decision, which is why both read the
 * names from `shared/tool-names.ts`.
 *
 * The native names were MEASURED against the pinned CLI rather than assumed
 * (`.spike-codex-appserver/RESULTS.md`): app-server declares `exec_command`,
 * taking a shell STRING, where `codex exec` reports `shell`. Copying the old
 * transport's catalog would have put a name on the trace that never runs.
 *
 * `commonTool` is used wherever a cross-harness equivalent exists, so a Codex
 * `bash` lines up with Claude Code's and Cursor's in a comparison view. Its
 * type check enforces that our input schema accepts everything the standard
 * one does.
 */
import { commonTool, type HarnessV1BuiltinTool } from "@ai-sdk/harness";
import { tool, type FlexibleSchema } from "@ai-sdk/provider-utils";
import { z } from "zod/v4";
import { CODEX_APPSERVER_NATIVE_TOOL_NAMES } from "./shared/tool-names.js";

/**
 * Declare a builtin that has NO cross-harness equivalent but whose catalog key
 * differs from its native name.
 *
 * The framework offers `commonTool` for the common-name case and plain `tool()`
 * for the case where the key IS the native name. Neither fits a tool that needs
 * `nativeName` without a `commonName`, and spreading `tool()`'s result does not
 * typecheck on its own: `Tool` is a union of tool kinds, so the spread produces
 * a union that is not assignable to the `Tool & { nativeName }` intersection.
 * `commonTool` resolves exactly this with an internal cast; this is the same
 * cast, in one place, rather than at each call site.
 */
function nativeTool<TInput>(opts: {
  nativeName: string;
  toolUseKind?: "readonly" | "edit" | "bash";
  description?: string;
  inputSchema: FlexibleSchema<TInput>;
}): HarnessV1BuiltinTool<TInput> {
  return {
    ...tool({
      description: opts.description,
      inputSchema: opts.inputSchema as FlexibleSchema<TInput>,
    }),
    nativeName: opts.nativeName,
    toolUseKind: opts.toolUseKind,
    // Through `unknown`, because the spread's union and the target
    // intersection do not overlap enough for a direct assertion. This is the
    // same escape `commonTool` takes (it casts `as never`).
  } as unknown as HarnessV1BuiltinTool<TInput>;
}

/*
 * The keys are written as LITERALS rather than computed from
 * `CODEX_APPSERVER_TOOL_NAMES`, because a computed key erases the literal type
 * that `satisfies` needs to check each entry. The drift that invites — a
 * catalog key the translator never emits, or vice versa — is caught at runtime
 * instead, by a test that compares the two sets.
 */
export const CODEX_APPSERVER_BUILTIN_TOOLS = {
  bash: commonTool("bash", {
    nativeName: CODEX_APPSERVER_NATIVE_TOOL_NAMES.commandExecution,
    toolUseKind: "bash",
    description:
      "Run a shell command in a PTY. Codex classifies each command as read, " +
      "listFiles, search or unknown, and the classification travels with the call.",
    inputSchema: z.object({
      command: z.string(),
      cwd: z.string().optional(),
      commandActions: z.array(z.unknown()).optional(),
    }),
  }),
  webSearch: commonTool("webSearch", {
    nativeName: CODEX_APPSERVER_NATIVE_TOOL_NAMES.webSearch,
    toolUseKind: "readonly",
    description: "Search the web.",
    inputSchema: z.object({ query: z.string() }),
  }),
  // No common equivalent: Claude Code surfaces edits as Write/Edit tool calls,
  // while Codex reports a patch as one `fileChange` item covering every path it
  // touched. Keyed by its own name, per the `commonTool` contract.
  fileChange: nativeTool({
    nativeName: CODEX_APPSERVER_NATIVE_TOOL_NAMES.fileChange,
    toolUseKind: "edit",
    description: "Apply a patch to one or more files in the workspace.",
    inputSchema: z.object({
      changes: z
        .array(z.object({ path: z.string(), kind: z.string().optional() }))
        .optional(),
      reason: z.string().optional(),
      grantRoot: z.string().optional(),
    }),
  }),
} as const satisfies Record<string, HarnessV1BuiltinTool<any, any>>;
