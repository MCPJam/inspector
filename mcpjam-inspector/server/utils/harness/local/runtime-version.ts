import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { logger } from "../../logger.js";
import type { ResolvedRuntime } from "./runtime-identity.js";

const packageVersion = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/),
});
const vendorPackages = {
  "claude-code": "@anthropic-ai/claude-agent-sdk",
  codex: "@openai/codex",
} as const;

/** Read the selected, verified runtime tree, including a permitted older pack. */
export async function localRuntimeVersion(
  runtime: Pick<
    ResolvedRuntime,
    "source" | "harnessId" | "rootPath" | "vendorVersionLine"
  >,
): Promise<string | null> {
  if (runtime.source === "system-install")
    return runtime.vendorVersionLine?.trim() || null;
  try {
    const text = await readFile(
      join(
        runtime.rootPath,
        "node_modules",
        vendorPackages[runtime.harnessId],
        "package.json",
      ),
      "utf8",
    );
    return packageVersion.parse(JSON.parse(text)).version;
  } catch (error) {
    // Missing version evidence must not fabricate a version or stop an otherwise verified runtime.
    logger.debug("[local-harness] runtime version unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
