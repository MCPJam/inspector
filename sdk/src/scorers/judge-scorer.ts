/**
 * The LLM judge scorer.
 *
 * Advisory by default — the hosted stance ("never mutates the run's `passed`")
 * applies here too, because a stochastic grader is an insight layer, not a
 * release gate. An author who wants one to gate must say so, and then the
 * fail-closed policies apply: a judge outage fails the iteration rather than
 * silently vanishing from the verdict.
 *
 * Not browser-safe (it reaches the model factory), which is why it lives in the
 * main entry rather than in `@mcpjam/sdk/contract`.
 */

import { generateObject } from "ai";
import { z } from "zod";
import { createModelFromString } from "../model-factory.js";
import type { CreateModelOptions } from "../model-factory.js";
import { canonicalDigest, sha256Hex } from "../contract/canonical.js";
import type {
  ScoreDefinition,
  ScoreRawOutcome,
  ScorerContextV1,
  ScorerErrorPolicy,
  ScorerRole,
} from "../contract/types.js";
import { DEFAULT_SCORER_TIMEOUT_MS, type Scorer } from "./types.js";

/**
 * Version of the prompt TEMPLATE this file renders. Distinct from the author's
 * rubric or instruction, which is hashed separately: changing how we frame the
 * task changes what the judge does even when the author changed nothing, and
 * both must reach the evaluation config hash.
 */
export const JUDGE_TEMPLATE_VERSION = "1";

/** The hosted default (`judgeConfig.ts`), kept identical so verdicts agree. */
export const DEFAULT_JUDGE_THRESHOLD = 0.7;

/** What a judge is asked to return. `passed` is deliberately NOT requested. */
const judgeOutputSchema = z.object({
  score: z
    .number()
    .min(0)
    .max(1)
    .describe("Overall quality from 0 (worst) to 1 (best)."),
  reason: z.string().describe("One or two sentences explaining the score."),
  rubricHits: z
    .array(z.string())
    .optional()
    .describe("Rubric criteria that were satisfied."),
});

export type JudgeScorerOptions = {
  /**
   * REQUIRED. Judges are always explicit-id: they are the scorers most likely
   * to be gated and tracked across runs, and a positional id would silently
   * detach that history the first time a scorer is inserted above them.
   */
  id: string;
  /** `provider/model`, e.g. `"anthropic/claude-sonnet-4-6"`. */
  model: string;
  apiKey: string;
  baseUrls?: CreateModelOptions["baseUrls"];
  customProviders?: CreateModelOptions["customProviders"];
  /** Criteria to grade against. Mutually exclusive with {@link prompt}. */
  rubric?: string[];
  /** A full custom instruction. Mutually exclusive with {@link rubric}. */
  prompt?: string;
  /** Defaults to {@link DEFAULT_JUDGE_THRESHOLD}. */
  threshold?: number;
  /** Judges are advisory unless the author says otherwise. */
  role?: ScorerRole;
  onError?: ScorerErrorPolicy;
  onSkipped?: ScorerErrorPolicy;
  /** Its OWN bound, not the iteration timeout. Default 60s. */
  timeoutMs?: number;
  label?: string;
  scorerVersion?: string;
};

function renderTranscript(context: ScorerContextV1): string {
  const lines: string[] = [];
  lines.push(`# Scenario\n${context.scenario.title}`);
  if (context.scenario.isNegativeTest) {
    lines.push(
      "This is a NEGATIVE test: the correct behavior is to REFUSE or avoid the action."
    );
  }
  if (context.expectedOutput) {
    lines.push(`# Expected output\n${context.expectedOutput}`);
  }
  if (context.expectedToolCalls?.length) {
    lines.push(
      `# Expected tool calls\n${context.expectedToolCalls
        .map((call) => `- ${call.toolName}`)
        .join("\n")}`
    );
  }

  const toolCalls = context.transcript.toolCalls ?? [];
  lines.push(
    `# Tool calls actually made\n${
      toolCalls.length === 0
        ? "(none)"
        : toolCalls
            .map(
              (call) =>
                `- ${call.toolName}(${JSON.stringify(call.arguments ?? {})})`
            )
            .join("\n")
    }`
  );

  const toolErrors = context.transcript.toolErrors ?? [];
  if (toolErrors.length > 0) {
    lines.push(
      `# Tool failures\n${toolErrors
        .map(
          (error) =>
            `- ${error.toolName ?? "(unknown)"} [${error.kind}] ${error.message ?? ""}`
        )
        .join("\n")}`
    );
  }

  const messages = context.trace.messages ?? [];
  lines.push(
    `# Conversation\n${
      messages.length === 0
        ? "(empty)"
        : messages
            .map(
              (message) =>
                `${message.role}: ${
                  typeof message.content === "string"
                    ? message.content
                    : JSON.stringify(message.content)
                }`
            )
            .join("\n")
    }`
  );

  if (context.transcript.finalAssistantMessage) {
    lines.push(
      `# Final assistant message\n${context.transcript.finalAssistantMessage}`
    );
  }
  return lines.join("\n\n");
}

function renderInstruction(options: JudgeScorerOptions): string {
  if (options.prompt) return options.prompt;
  const criteria = (options.rubric ?? [])
    .map((criterion, index) => `${index + 1}. ${criterion}`)
    .join("\n");
  return (
    "You are grading an AI agent's transcript against a rubric.\n" +
    "Score 0 to 1, where 1 means every criterion is fully satisfied.\n" +
    "Judge only what the transcript shows; do not assume unstated behavior.\n\n" +
    `# Rubric\n${criteria}`
  );
}

export function judgeScorer(options: JudgeScorerOptions): Scorer {
  const id = options.id?.trim();
  if (!id) {
    throw new Error("judgeScorer requires an explicit, non-empty `id`.");
  }
  const hasRubric = (options.rubric?.length ?? 0) > 0;
  const hasPrompt = Boolean(options.prompt?.trim());
  if (hasRubric === hasPrompt) {
    throw new Error(
      "judgeScorer requires exactly one of `rubric` or `prompt` " +
        `(got ${hasRubric && hasPrompt ? "both" : "neither"}).`
    );
  }

  const role = options.role ?? "advisory";
  const timeoutMs = options.timeoutMs ?? DEFAULT_SCORER_TIMEOUT_MS;
  const instruction = renderInstruction(options);

  const definition: ScoreDefinition = {
    scorerId: id,
    idSource: "explicit",
    scorerVersion: options.scorerVersion ?? "1",
    // Both halves of "what this judge does": the author's rubric/prompt AND the
    // template that frames it. Either one changing must change the config hash.
    implementationHash: canonicalDigest({
      templateVersion: JUDGE_TEMPLATE_VERSION,
      instruction,
      model: options.model,
    }),
    ...(options.label ? { label: options.label } : {}),
    deterministic: false,
    passThreshold: options.threshold ?? DEFAULT_JUDGE_THRESHOLD,
    role,
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.onSkipped ? { onSkipped: options.onSkipped } : {}),
    model: options.model,
  };

  return {
    definition,
    timeoutMs,
    async score(context, signal): Promise<ScoreRawOutcome> {
      const rendered = `${instruction}\n\n${renderTranscript(context)}`;
      // The judge's own bound. The runner races too, but a local timer is what
      // actually cancels the in-flight HTTP request; the race alone would leave
      // it running against the provider.
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error(`judge timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      if (signal) {
        if (signal.aborted) controller.abort(signal.reason);
        else
          signal.addEventListener("abort", () => controller.abort(signal.reason), {
            once: true,
          });
      }

      try {
        const { object } = await generateObject({
          model: createModelFromString(options.model, {
            apiKey: options.apiKey,
            baseUrls: options.baseUrls,
            customProviders: options.customProviders,
          }),
          schema: judgeOutputSchema,
          prompt: rendered,
          abortSignal: controller.signal,
        });

        return {
          kind: "scored",
          value: object.score,
          rationale: object.reason,
          ...(object.rubricHits?.length
            ? { evidence: object.rubricHits }
            : {}),
          model: options.model,
          promptHash: sha256Hex(rendered),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
