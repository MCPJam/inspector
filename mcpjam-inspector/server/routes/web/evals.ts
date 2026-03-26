import { Hono } from "hono";
import { z } from "zod";
import { withEphemeralConnection } from "./auth.js";
import {
  GenerateNegativeTestsRequestSchema,
  GenerateTestsRequestSchema,
  RunEvalsRequestSchema,
  RunTestCaseRequestSchema,
  generateEvalTestsWithManager,
  generateNegativeEvalTestsWithManager,
  runEvalsWithManager,
  runEvalTestCaseWithManager,
} from "../shared/evals.js";

const evals = new Hono();

const hostedBatchSchema = z.object({
  workspaceId: z.string().min(1),
  serverIds: z.array(z.string().min(1)).min(1),
  clientCapabilities: z.record(z.string(), z.unknown()).optional(),
  oauthTokens: z.record(z.string(), z.string()).optional(),
  accessScope: z.enum(["workspace_member", "chat_v2"]).optional(),
  shareToken: z.string().min(1).optional(),
  sandboxToken: z.string().min(1).optional(),
});

const hostedRunEvalsSchema = RunEvalsRequestSchema.omit({
  workspaceId: true,
  serverIds: true,
}).extend(hostedBatchSchema.shape);

const hostedRunTestCaseSchema = RunTestCaseRequestSchema.omit({
  serverIds: true,
}).extend(hostedBatchSchema.shape);

const hostedGenerateTestsSchema = GenerateTestsRequestSchema.omit({
  serverIds: true,
}).extend(hostedBatchSchema.shape);

const hostedGenerateNegativeTestsSchema =
  GenerateNegativeTestsRequestSchema.omit({
    serverIds: true,
  }).extend(hostedBatchSchema.shape);

evals.post("/run", async (c) =>
  withEphemeralConnection(c, hostedRunEvalsSchema, (manager, body) =>
    runEvalsWithManager(manager, body),
  ),
);

evals.post("/run-test-case", async (c) =>
  withEphemeralConnection(c, hostedRunTestCaseSchema, (manager, body) =>
    runEvalTestCaseWithManager(manager, body),
  ),
);

evals.post("/generate-tests", async (c) =>
  withEphemeralConnection(c, hostedGenerateTestsSchema, (manager, body) =>
    generateEvalTestsWithManager(manager, body),
  ),
);

evals.post("/generate-negative-tests", async (c) =>
  withEphemeralConnection(
    c,
    hostedGenerateNegativeTestsSchema,
    (manager, body) => generateNegativeEvalTestsWithManager(manager, body),
  ),
);

export default evals;
