import { describe, expect, it } from "vitest";
import { taskInputPrompt } from "../task-input-prompt";

const form = {
  method: "elicitation/create",
  params: {
    message: "Choose a city",
    requestedSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};
const url = {
  method: "elicitation/create",
  params: {
    mode: "url",
    message: "Connect your account",
    url: "https://example.test/connect?state=opaque",
  },
};

describe("Task input presentation", () => {
  it("uses form schema and skips keys already acknowledged", () => {
    const input = taskInputPrompt(
      { first: form, second: url },
      new Set(["first"]),
    );
    expect(input.next).toMatchObject({
      key: "second",
      mode: "url",
      url: url.params.url,
    });
    expect(input.unanswerableCount).toBe(0);
    expect(taskInputPrompt({ first: form }, new Set()).next).toMatchObject({
      mode: "form",
      schema: form.params.requestedSchema,
    });
  });
  it("accepts modern URL input without a legacy elicitation ID", () => {
    expect(taskInputPrompt({ consent: url }, new Set()).next).toEqual({
      key: "consent",
      mode: "url",
      message: url.params.message,
      url: url.params.url,
    });
  });
  it("counts malformed and unhandled requests without rendering them", () => {
    const input = taskInputPrompt(
      {
        invalid: {
          method: "elicitation/create",
          params: { mode: "url", message: "Broken", url: "bad-url" },
        },
        roots: { method: "roots/list", params: {} },
        missing: { method: "elicitation/create" },
        ready: form,
      },
      new Set(),
    );
    expect(input.next?.key).toBe("ready");
    expect(input.unanswerableCount).toBe(3);
  });
});
