import type { Command } from "commander";

/** Use registered command names only: never echo arguments or credentials. */
export function installUsageHelp(program: Command): () => string {
  let failedCommand = program;
  const visit = (command: Command): void => {
    command.exitOverride((error) => {
      failedCommand = command;
      throw error;
    });
    for (const child of command.commands) visit(child);
  };
  visit(program);
  return () => {
    const names: string[] = [];
    for (let command: Command | null = failedCommand; command; command = command.parent) {
      names.unshift(command.name());
    }
    return `Run \`${names.join(" ")} --help\` for this command's arguments and options.`;
  };
}

export const EVAL_CREDIT_HELP = `
Usage and credits:
  Hosted runs can consume MCPJam product credits, separately from your agent
  provider's bill. Check the project's organization in MCPJam: Organizations >
  Billing shows its credit balance and plan. This CLI does not report the current
  credit balance or a guaranteed per-run cost estimate; missing data is not zero.
  --iterations controls repetitions per case, not credits or model-step limits.
  Rate limits, step limits, and platform-credit requirements are separate limits.
  If blocked, follow the specific error before retrying; keep your suite file.
`;

/** No role or plan is implied by a 403; the app supplies current eligibility. */
export const PLATFORM_FEE_HELP =
  "This is a platform-credit requirement, separate from iteration and model-step limits. " +
  "Check the project's organization in MCPJam under Organizations > Billing. " +
  "If you are the owner, review the balance and the recovery options available to your plan; top-ups may require an upgrade, and enterprise arrangements may require support. " +
  "If you are a member or cannot manage billing, ask the organization owner to resolve it. " +
  "Keep your suite and retry the original task only after the account issue is resolved. " +
  "This response does not establish the available balance or expected cost.";
