/**
 * A test plan's shape, for a request body or a tool input that carries one.
 *
 * Structure only, and strict, so a misspelled key is refused rather than
 * stored. What a plan means, and its limits, are `validateDirectoryTestPlan`'s
 * to judge, so that wording stays in one place.
 */
import { z } from "zod";
import {
  DIRECTORY_TEST_EXCLUSION_REASONS,
  DIRECTORY_TEST_PLAN_SCHEMA_VERSION,
  DIRECTORY_TOOL_EFFECTS,
  DIRECTORY_TOOL_PLAN_ACTIONS,
  type DirectoryTestPlan,
} from "../directory-readiness/test-plan/types.js";

/** Call arguments. `{ "$fixture": id, "value": name }` anywhere stands for a fixture's value. */
const callArguments = z.record(z.string(), z.unknown());

const fixture = z.strictObject({
  id: z.string(),
  description: z.string(),
  origin: z.enum(["existing", "created"]),
  values: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  capture: z.record(z.string(), z.string()).optional(),
});

const toolPlan = z.strictObject({
  tool: z.string(),
  effect: z.enum(DIRECTORY_TOOL_EFFECTS),
  openWorld: z.boolean(),
  action: z.enum(DIRECTORY_TOOL_PLAN_ACTIONS),
  exclusion: z
    .strictObject({
      reason: z.enum(DIRECTORY_TEST_EXCLUSION_REASONS),
      note: z.string().optional(),
    })
    .optional(),
  writes: z.array(z.string()),
});

const testCase = z.strictObject({
  id: z.string(),
  tool: z.string(),
  kind: z.enum(["valid", "negative"]),
  arguments: callArguments.optional(),
  expectedError: z.enum(["any", "invalid-arguments", "tool-error"]).optional(),
  expectation: z.string().optional(),
  creates: z.array(z.string()).optional(),
});

export const directoryTestPlanSchema = z.strictObject({
  schemaVersion: z.literal(DIRECTORY_TEST_PLAN_SCHEMA_VERSION),
  fixtures: z.array(fixture),
  tools: z.array(toolPlan),
  cases: z.array(testCase),
  budget: z.strictObject({
    maxCalls: z.number(),
    concurrency: z.number(),
    callTimeoutMs: z.number(),
  }),
  cleanup: z.array(
    z.strictObject({
      fixture: z.string(),
      tool: z.string(),
      arguments: callArguments,
    })
  ),
}) satisfies z.ZodType<DirectoryTestPlan>;
