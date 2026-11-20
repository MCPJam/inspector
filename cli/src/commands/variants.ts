/**
 * `mcpjam cloud variants`: server variants, in beta. A variant is a saved
 * server's live tools with edited descriptions under a server id of its own,
 * so an eval can compare it with its base without changing the base.
 *
 *   mcpjam cloud variants create --server my-server --edits @edits.json
 */
import type { Command } from "commander";
import {
  createVariantServerOperation,
  type CreateVariantServerInput,
} from "@mcpjam/sdk/platform";
import { JsonInputContext } from "../lib/json-input.js";
import { usageError } from "../lib/output.js";
import {
  addProjectOption,
  bindOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";

type CreateOptions = PlatformOptions & {
  project?: string;
  server: string;
  edits: string;
  label?: string;
};

const EDITS_SHAPE =
  '[{"feature": "tools.description", "target": "<tool>", "op": "set", "value": "<description>"}]';

/** The operation's input, checked against its own schema before anything is sent. */
export function createVariantInput(
  options: CreateOptions,
  json = new JsonInputContext(),
): CreateVariantServerInput {
  const { project, server, label } = options;
  const edits = json.parseJsonInputValue(options.edits, "--edits");
  const parsed = createVariantServerOperation.inputSchema.safeParse({ project, server, edits, label });
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "input";
  const reason = (issue?.message ?? "is not valid").replace(/\.$/, "");
  throw usageError(`${where}: ${reason}. Pass --edits as a JSON array like ${EDITS_SHAPE}.`);
}

export function registerVariantsCommands(cloud: Command): void {
  const variants = cloud
    .command("variants")
    .description("Server variants (beta): a saved server's live tools with edited descriptions");
  const create = variants
    .command("create")
    .description("Create a variant of a saved HTTP server, or get the one with the same edits")
    .requiredOption("--server <id-or-name>", "The base server's ID or name")
    .requiredOption("--edits <json>", `Edits as JSON, @file or - for stdin: ${EDITS_SHAPE}`)
    .option("--label <text>", "A name for the variant");
  bindOperation(addProjectOption(create), createVariantServerOperation, (options: CreateOptions) =>
    createVariantInput(options),
  );
}
