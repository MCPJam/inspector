import { z } from "zod";

/**
 * What an eval answers when a server asks a question mid-run: a mock's case
 * step, or a real server that elicits. A case carries a list; the first
 * entry whose fields all fit the question answers. Pure, so the SDK, the
 * Inspector and the backend's hand-mirrored validator agree on one rule.
 */

export const MAX_INPUT_ANSWERS = 20;
export const MAX_INPUT_ANSWER_MESSAGE_CHARS = 500;
export const MAX_INPUT_ANSWER_CONTENT_CHARS = 4000;

const contentValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

/** One reply. A field left out matches anything; an entry with none is a default reply. */
export const inputAnswerSchema = z
  .object({
    /** The server's name, as the suite names it. Exact. */
    server: z.string().min(1).max(200).optional(),
    /** The tool whose call asked. Exact. Known where the question rides in the call's result (2026-07-28) or a mock names it; a question on an older revision carries none. */
    tool: z.string().min(1).max(256).optional(),
    /** Text the question's message contains, case-sensitive. */
    message: z.string().min(1).max(MAX_INPUT_ANSWER_MESSAGE_CHARS).optional(),
    action: z.enum(["accept", "decline", "cancel"]),
    /** The form's values, only with `accept`. A URL question has none. */
    content: z.record(z.string(), contentValueSchema).optional(),
  })
  .strict()
  .superRefine((answer, ctx) => {
    if (answer.content !== undefined && answer.action !== "accept") {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message:
          'A reply with content must have action "accept". Remove the content, or accept.',
      });
    }
    if (
      answer.content !== undefined &&
      JSON.stringify(answer.content).length > MAX_INPUT_ANSWER_CONTENT_CHARS
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: `A reply's content may be ${MAX_INPUT_ANSWER_CONTENT_CHARS} characters at most. Shorten the values.`,
      });
    }
  });
export type InputAnswer = z.infer<typeof inputAnswerSchema>;

export const inputAnswersSchema = z
  .array(inputAnswerSchema)
  .max(MAX_INPUT_ANSWERS);

/** A question a server asked, as far as the asker knows it. */
export interface InputQuestion {
  server?: string;
  tool?: string;
  message: string;
}

export interface MatchedInputAnswer {
  index: number;
  answer: InputAnswer;
}

/**
 * The first reply whose listed fields all fit the question. A field the
 * question lacks (`tool` on an older revision) fits only an entry that does
 * not list it.
 */
export function matchInputAnswer(
  answers: readonly InputAnswer[] | undefined,
  question: InputQuestion
): MatchedInputAnswer | undefined {
  const index = (answers ?? []).findIndex(
    (answer) =>
      (answer.server === undefined || answer.server === question.server) &&
      (answer.tool === undefined || answer.tool === question.tool) &&
      (answer.message === undefined ||
        question.message.includes(answer.message))
  );
  return index < 0 ? undefined : { index, answer: answers![index]! };
}

/** The result a client sends back for a question: the reply, or a decline when none was set. */
export function inputAnswerResult(answer: InputAnswer | undefined): {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
} {
  if (!answer) return { action: "decline" };
  return {
    action: answer.action,
    ...(answer.content !== undefined && { content: answer.content }),
  };
}
