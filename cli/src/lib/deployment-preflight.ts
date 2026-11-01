/**
 * Every command that can contact MCPJam decides its server when it starts,
 * before it contacts anything: MCPJam, the MCP server under test, or a model.
 * So a refusal (two variables naming different servers, a saved login for
 * another server) always comes before the first request of any kind.
 *
 * "Can contact MCPJam" means the command accepts `--api-url`, or this
 * invocation asked to upload results (`--upload`, `--require-upload`). A
 * command that knows better says so with {@link declareMcpjamUse}: a login,
 * an upload that configured reporting implies, or a command that contacts no
 * server at all.
 */
import type { Command } from "commander";
import type { DeploymentCredential } from "@mcpjam/sdk/internal/deployment";
import { requestsUpload } from "./conformance-upload.js";
import { platformCredentialKind } from "./platform-auth.js";
import { resolveCliDeployment } from "./platform-client.js";
import { platformOptionsOf } from "./platform-command.js";

type CommandOptions = Record<string, unknown> & {
  apiKey?: string;
  apiUrl?: string;
  upload?: unknown;
  requireUpload?: unknown;
};

export type McpjamUse = {
  /** Whether this invocation contacts MCPJam, when the default rule is wrong. */
  when?: (options: CommandOptions) => boolean;
  /** Defaults to the key or saved login the command would send. */
  credential?: DeploymentCredential;
};

const declaredUses = new WeakMap<Command, McpjamUse>();

export function declareMcpjamUse<T extends Command>(
  command: T,
  use: McpjamUse
): T {
  declaredUses.set(command, use);
  return command;
}

function acceptsApiUrl(command: Command): boolean {
  for (let current: Command | null = command; current; current = current.parent) {
    if (current.options.some((option) => option.long === "--api-url")) {
      return true;
    }
  }
  return false;
}

function useOf(command: Command, options: CommandOptions): McpjamUse | null {
  const declared = declaredUses.get(command);
  if (declared?.when) return declared.when(options) ? declared : null;
  if (acceptsApiUrl(command)) return declared ?? {};
  // Uploads send an API key; no upload command signs in with a saved login.
  return requestsUpload(options) ? { credential: "api-key" } : null;
}

export function installDeploymentPreflight(program: Command): void {
  program.hook("preAction", (_program, actionCommand) => {
    const options = platformOptionsOf<CommandOptions>(actionCommand);
    const use = useOf(actionCommand, options);
    if (!use) return;
    resolveCliDeployment({
      apiUrl: options.apiUrl,
      credential: use.credential ?? platformCredentialKind(options, process.env),
    });
  });
}
