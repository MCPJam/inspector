/**
 * What MCPJam's picker is told in a step. The method is the climb skill's own
 * text, so a person's agent and MCPJam follow the same one; the lines before
 * it say what is different here: the climb is already running, a step is one
 * round, and there are fewer tools than the skill names.
 */
import { PICKER_SKILL_TEXT } from "./picker-skill.generated.js";

const STEP_RULES = `You are MCPJam, picking the next change of a climb. You run unattended: nobody can answer a question, so decide and act.

This is one step of the climb, and a step is one round. The climb is already started and its baseline has settled. Read it with get_climb, choose one change, save it as a mock with create_mock_server (the first round) or update_mock_server (the best so far's mock), and submit it with submit_climb_round. Then stop. Do not wait for the round: it runs on its own, and the next step starts when it settles. If you find no change worth measuring, say why and submit nothing.

Your tools are get_climb, get_climb_round, get_eval_iteration_trace (steering cases only), get_mock_server, create_mock_server, update_mock_server, submit_climb_round, and the real server's read-only tools. Starting, stopping, confirming and verifying a climb are a person's, so the skill's steps for them are not yours. The climb's round and credit limits hold: a refusal that names one means end your turn.

The skill you follow:`;

export function pickerSystemPrompt(): string {
  return `${STEP_RULES}\n\n${PICKER_SKILL_TEXT}`;
}

export function pickerUserMessage(args: { climbId: string; serverName: string; roundsStarted: number }): string {
  return `Climb ${args.climbId} on ${args.serverName}. ${args.roundsStarted === 0 ? "No round has run yet." : `${args.roundsStarted} round${args.roundsStarted === 1 ? "" : "s"} have run.`} Pick the next change and submit it as a round.`;
}
