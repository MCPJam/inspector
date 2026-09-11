import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import type { GenerationState } from "./eval-workspace";

export function evalChatGuidance(
  _scope: EvalAgentScope,
  _generation?: GenerationState,
) {
  return {
    title: "What do you want to test?",
    description: "Describe a behavior. I’ll fill in the steps and checks.",
    placeholder:
      "Describe a user prompt or workflow you'd like to test e.g. find my open tickets and summarize them.",
    suggestions: [
      {
        label: "Suggest a test from my tools",
        prompt:
          "Suggest one focused test from this suite’s tool metadata, with discovery-backed steps and checks. Prepare a proposal for me to create.",
      },
    ],
  };
}
