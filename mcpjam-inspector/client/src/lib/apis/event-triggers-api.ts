/**
 * MCP Events triggers (contract C6): Convex function references the Triggers
 * tab calls directly, all project-member checked server-side. Triggers exist
 * only in the hosted registry, because they run on MCPJam's hosted runner.
 */
import { makeFunctionReference } from "convex/server";

export type EventTriggerApprovalPolicy = "deny_writes" | "auto_deny";

export interface EventTriggerRow {
  _id: string;
  projectId: string;
  environmentId?: string;
  subscriptionId: string;
  name: string;
  instructions: string;
  enabled: boolean;
  revision: number;
  modelId?: string;
  approvalPolicy: EventTriggerApprovalPolicy;
  maxSteps: number;
  rateLimitPerHour: number;
  spendCapMicrosPerDay: number;
  spendMicrosToday?: number;
  createdAt: number;
  updatedAt: number;
}

export type EventTriggerRunStatus =
  "pending" | "running" | "completed" | "failed" | "parked" | "skipped";

export interface EventTriggerRunRow {
  _id: string;
  triggerId: string;
  subscriptionId: string;
  namespace: string;
  eventId: string;
  status: EventTriggerRunStatus | string;
  step?: number;
  /** A failed or skipped run's reason (`skipped`: the admission refusal). */
  error?: string;
  parkedReason?: string;
  costMicros?: number;
  chatSessionId?: string;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
}

export interface EventTriggerRunCall {
  callId: string;
  operation: string;
  status: "pending" | "completed" | string;
  replayable: boolean;
  result?: unknown;
}

/** `eventTriggerRuns:get`: the run, its frozen input and its call journal. */
export interface EventTriggerRunDetail {
  run: EventTriggerRunRow;
  input: {
    trigger?: Record<string, unknown>;
    event?: {
      eventId?: string;
      name?: string;
      timestamp?: string | null;
      data?: unknown;
      origin?: string;
      namespace?: string;
    };
    subscription?: Record<string, unknown>;
  } | null;
  messages: unknown;
  result: unknown;
  calls: EventTriggerRunCall[];
}

// A type alias, not an interface: Convex function args need an index signature.
export type EventTriggerFields = {
  name: string;
  instructions: string;
  environmentId?: string;
  modelId?: string;
  approvalPolicy: EventTriggerApprovalPolicy;
  maxSteps: number;
  rateLimitPerHour: number;
  spendCapMicrosPerDay: number;
};

export const EVENT_TRIGGERS_API = {
  list: makeFunctionReference<
    "query",
    { projectId: string },
    EventTriggerRow[]
  >("eventTriggers:list"),
  create: makeFunctionReference<
    "mutation",
    EventTriggerFields & {
      projectId: string;
      subscriptionId: string;
      enabled?: boolean;
    },
    string
  >("eventTriggers:create"),
  update: makeFunctionReference<
    "mutation",
    Partial<Omit<EventTriggerFields, "environmentId" | "modelId">> & {
      triggerId: string;
      environmentId?: string | null;
      modelId?: string | null;
    },
    EventTriggerRow
  >("eventTriggers:update"),
  setEnabled: makeFunctionReference<
    "mutation",
    { triggerId: string; enabled: boolean },
    null
  >("eventTriggers:setEnabled"),
  remove: makeFunctionReference<"mutation", { triggerId: string }, null>(
    "eventTriggers:remove",
  ),
};

export const EVENT_TRIGGER_RUNS_API = {
  listForTrigger: makeFunctionReference<
    "query",
    { triggerId: string; limit?: number },
    EventTriggerRunRow[]
  >("eventTriggerRuns:listForTrigger"),
  get: makeFunctionReference<
    "query",
    { runId: string },
    EventTriggerRunDetail | null
  >("eventTriggerRuns:get"),
};

/** Dollars (as typed) to the micros the budget is stored in. */
export function dollarsToMicros(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

export function microsToDollars(micros: number): number {
  return micros / 1_000_000;
}

/** Defaults the backend applies (`EVENT_TRIGGER_DEFAULTS`). */
export const EVENT_TRIGGER_DEFAULTS = {
  maxSteps: 8,
  rateLimitPerHour: 30,
  spendCapMicrosPerDay: 2_000_000,
  approvalPolicy: "deny_writes" as EventTriggerApprovalPolicy,
};

/** Backend bounds (`eventTriggers.ts` validateFields). */
export const EVENT_TRIGGER_LIMITS = {
  maxSteps: 32,
  rateLimitPerHour: 120,
  spendCapMicrosPerDay: 1_000_000_000,
};
