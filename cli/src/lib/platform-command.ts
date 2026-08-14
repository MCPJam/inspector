/**
 * The shared runner for every `mcpjam <group>` command that talks to the
 * platform API.
 *
 * Extracted from nine per-command copies that had already drifted three ways:
 * `eval` had grown a `webOrigin` in the execute context, `projects` an
 * external abort signal, and the other seven were byte-identical modulo
 * formatting. This is the superset — the context always carries `webOrigin`
 * (it is a pure string transform of the base URL) and the external signal is
 * optional — so a command file declares nothing and ignores what it does not
 * use.
 */
import type { Command } from "commander";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import {
  buildPlatformClient,
  toCliError,
  webOriginForApiBaseUrl,
} from "./platform-client.js";

export type PlatformOptions = {
  apiKey?: string;
  apiUrl?: string;
};

export function addPlatformOptions(command: Command): Command {
  return command
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)"
    );
}

export async function runPlatformCommand<TOutput>(
  options: PlatformOptions,
  timeoutMs: number,
  execute: (context: {
    client: ReturnType<typeof buildPlatformClient>["client"];
    signal: AbortSignal;
    /** App origin matching the API base this call went to. */
    webOrigin: string;
  }) => Promise<TOutput>,
  /**
   * Cancels the request from outside its own deadline — today that is Ctrl-C
   * during a poll. Without it the only way out of an in-flight request is the
   * timeout, so a user who interrupted a watch still waits the better part of
   * `timeoutMs` for the terminal to come back.
   */
  externalSignal?: AbortSignal
): Promise<TOutput> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort(
      new PlatformApiError(
        `Request timed out after ${timeoutMs}ms`,
        "TIMEOUT",
        {
          status: 0,
        }
      )
    );
  }, timeoutMs);
  timeoutHandle.unref?.();

  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const { client, baseUrl } = buildPlatformClient({ ...options, timeoutMs });
    return await execute({
      client,
      signal: controller.signal,
      webOrigin: webOriginForApiBaseUrl(baseUrl),
    });
  } catch (error) {
    // When OUR deadline fired, surface the armed TIMEOUT error: depending
    // on the fetch implementation, the rejection may be a bare AbortError
    // that would otherwise map to INTERNAL_ERROR.
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof PlatformApiError
    ) {
      throw toCliError(controller.signal.reason);
    }
    throw toCliError(error);
  } finally {
    clearTimeout(timeoutHandle);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
