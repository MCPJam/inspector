import { describe, expect, it } from "vitest";
import { z } from "zod";
import { explainMissingArguments } from "../src/tools/missingArguments.js";
import { withListedInputSchema } from "../src/tools/listedInputSchema.js";

const schema = z.object({
  project: z.string().min(1).optional().describe("Project name or ID."),
  runId: z
    .string()
    .min(1)
    .describe("Eval run ID, as returned by run_eval_suite or list_eval_suite_runs."),
  filter: z.object({ status: z.string().describe("Run status to keep.") }).optional(),
});

describe("withListedInputSchema validation messages", () => {
  it("names a missing argument by its description", async () => {
    const result = await withListedInputSchema(schema)["~standard"].validate({
      project: "Dogfood",
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: ["runId"],
        message:
          "required. Eval run ID, as returned by run_eval_suite or list_eval_suite_runs.",
      }),
    ]);
  });

  it("leaves a wrong value's own message alone", async () => {
    const result = await withListedInputSchema(schema)["~standard"].validate({
      runId: "",
    });
    expect(result.issues?.[0]?.message).not.toMatch(/^required/);
  });

  it("follows a missing argument into a nested object", async () => {
    const result = await withListedInputSchema(schema)["~standard"].validate({
      runId: "r1",
      filter: {},
    });
    expect(result.issues).toEqual([
      expect.objectContaining({
        path: ["filter", "status"],
        message: "required. Run status to keep.",
      }),
    ]);
  });

  it("passes a valid call through untouched", async () => {
    expect(
      await withListedInputSchema(schema)["~standard"].validate({ runId: "r1" })
    ).toEqual({ value: { runId: "r1" } });
  });
});

describe("explainMissingArguments", () => {
  it("says only 'required.' when the parameter has no description", () => {
    expect(
      explainMissingArguments(
        [{ message: "Invalid input", path: ["x"] }],
        {},
        { type: "object", properties: { x: { type: "string" } } }
      )
    ).toEqual([{ message: "required.", path: ["x"] }]);
  });

  it("keeps an issue about the whole input", () => {
    const issue = { message: "Pass name, isDefault: true, or both." };
    expect(explainMissingArguments([issue], {}, {})).toEqual([issue]);
  });
});
