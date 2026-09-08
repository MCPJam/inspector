import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import type { GenerationState } from "./eval-workspace";

export function evalChatGuidance(
  scope: EvalAgentScope,
  generation?: GenerationState,
) {
  if (scope.caseId) {
    if (
      scope.hasCaseContent === false ||
      (scope.hasCaseContent === undefined && scope.caseId.startsWith("draft:"))
    )
      return {
        title: "What behavior should this case verify?",
        description:
          "Describe the user’s request and what a successful response should do. I’ll turn that into steps and checks.",
        placeholder: "Describe a behavior and the expected outcome…",
        suggestions: [
          {
            label: "Help me choose a behavior",
            prompt:
              "Read this suite’s tools and help me choose one useful behavior to test. Ask me a focused question about the expected outcome before drafting the case.",
          },
          {
            label: "Suggest a case from the tools",
            prompt:
              "Read this suite’s connected tools and draft one focused, discovery-backed case with steps and checks. Avoid invented workspace data.",
          },
        ],
      };
    return {
      title: "What would you like to improve?",
      description:
        "I can adjust this case’s prompts, tool calls, or checks while preserving its intended behavior.",
      placeholder: "Describe a change to this case…",
      suggestions: [
        {
          label: "Make checks more precise",
          prompt:
            "Read this case and make its checks more precise while preserving its intended behavior.",
        },
        {
          label: "Remove brittle assumptions",
          prompt:
            "Read this case and replace brittle fixture assumptions with discovery-backed steps.",
        },
        {
          label: "Simplify the steps",
          prompt:
            "Read this case and simplify its steps without removing prerequisites or weakening its checks.",
        },
      ],
    };
  }
  if (generation?.status === "running")
    return {
      title: "Drafting cases from your connected servers…",
      description:
        "Cases will appear as they’re generated. Additional coverage instructions will guide the next generation pass.",
      placeholder: "Guide the next generation pass…",
      suggestions: [
        {
          label: "Focus on read-only behavior",
          prompt:
            "For the next generation pass, focus on read-only behavior. Do not restart the current generation job.",
        },
        {
          label: "Include error handling",
          prompt:
            "For the next generation pass, include error handling supported by the server’s tool contract. Do not restart the current job.",
        },
      ],
    };
  if (generation?.drafts.length)
    return {
      title: "What should we refine?",
      description:
        "Review the generated drafts. Name a case to refine, or ask for a change across the batch.",
      placeholder: "Name a draft or describe a batch improvement…",
      suggestions: [
        {
          label: "Find coverage gaps",
          prompt:
            "Read the generated drafts and identify meaningful coverage gaps. Suggest additions without generating another batch yet.",
        },
        {
          label: "Find overlapping cases",
          prompt:
            "Read the generated drafts and identify overlapping cases, explaining which ones could be combined.",
        },
        {
          label: "Strengthen the checks",
          prompt:
            "Read the generated drafts and strengthen their checks while preserving each case’s intended behavior. Refine existing drafts; do not generate duplicates.",
        },
      ],
    };
  return {
    title: "What coverage should we add?",
    description:
      "Generate cases from your connected servers, or describe the behavior you want to cover.",
    placeholder: "Describe the coverage you want…",
    suggestions: [
      {
        label: "Generate read-only cases",
        prompt:
          "Read the current suite context and generate discovery-backed, read-only test cases. Stage them for review without saving or running them.",
      },
      {
        label: "Cover multi-step workflows",
        prompt:
          "Read the current suite context and generate focused multi-step cases, preserving discovery prerequisites. Stage them for review without saving or running them.",
      },
    ],
  };
}
