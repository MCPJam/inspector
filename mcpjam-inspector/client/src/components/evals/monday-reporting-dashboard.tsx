import { Fragment, useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
} from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { EvalDualSparkline, EvalSparkline } from "./eval-sparkline";

type Range = "7d" | "30d" | "90d";
type JourneyStageId =
  | "connection"
  | "discovery"
  | "selection"
  | "call"
  | "response"
  | "value";
type JourneyStageState = "ok" | "warn" | "fail" | "none";

interface JourneyStageOutput {
  state: Exclude<JourneyStageState, "none">;
  observation: string;
  meta: string;
}

interface EvalCaseReport {
  id: string;
  title: string;
  accuracy: number;
  p50: number;
  p95: number;
  brokenStage: JourneyStageId | null;
  diagnosis: string;
  stages: Partial<Record<JourneyStageId, JourneyStageOutput>>;
}

interface EvalSuiteReport {
  name: string;
  errorRate: string;
  topError: string;
  latency: string;
  calls: string;
  tokens: string;
  cases: EvalCaseReport[];
}

const JOURNEY_STAGES: ReadonlyArray<{
  id: JourneyStageId;
  num: string;
  title: string;
  question: string;
}> = [
  {
    id: "connection",
    num: "01",
    title: "Connection",
    question: "Could the configured client establish a session?",
  },
  {
    id: "discovery",
    num: "02",
    title: "Discovery",
    question: "Did the client receive usable primitives and metadata?",
  },
  {
    id: "selection",
    num: "03",
    title: "Selection",
    question: "Did the agent choose an appropriate primitive?",
  },
  {
    id: "call",
    num: "04",
    title: "Tool call",
    question: "Were the arguments valid and faithful to intent?",
  },
  {
    id: "response",
    num: "05",
    title: "Tool response",
    question: "Did the server return an honest, usable result?",
  },
  {
    id: "value",
    num: "06",
    title: "User value",
    question: "Did the configured system complete the original task?",
  },
];

const evalSuites: EvalSuiteReport[] = [
  {
    name: "Item lifecycle",
    errorRate: "1.2%",
    topError: "change_item_column_values · 2 errors",
    latency: "400 ms / 720 ms",
    calls: "1.4",
    tokens: "2.1k",
    cases: [
      {
        id: "create-bug-status",
        title: "Create a bug item with a status column",
        accuracy: 10,
        p50: 420,
        p95: 610,
        brokenStage: null,
        diagnosis: "The requested item and status landed cleanly in every run.",
        stages: {
          discovery: {
            state: "ok",
            observation:
              "create_item exposed the complete status-column schema.",
            meta: "10 of 10 iterations",
          },
          selection: {
            state: "ok",
            observation: "create_item was chosen on the first attempt.",
            meta: "10 of 10 iterations",
          },
          call: {
            state: "ok",
            observation:
              "The status label was passed as a structured column value.",
            meta: "10 of 10 iterations",
          },
          response: {
            state: "ok",
            observation: "Every tool response completed without an error.",
            meta: "10 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "The item was created with the requested status.",
            meta: "10 of 10 iterations",
          },
        },
      },
      {
        id: "create-assign",
        title: "Create item and assign to teammate",
        accuracy: 10,
        p50: 450,
        p95: 700,
        brokenStage: null,
        diagnosis: "Creation and assignment both held across the full run set.",
        stages: {
          selection: {
            state: "ok",
            observation:
              "The agent used create_item followed by one people-column update.",
            meta: "10 of 10 iterations",
          },
          call: {
            state: "ok",
            observation:
              "The teammate was resolved to a Monday user id before mutation.",
            meta: "10 of 10 iterations",
          },
          response: {
            state: "ok",
            observation: "No tool errors were observed.",
            meta: "10 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "The new item was assigned to the requested teammate.",
            meta: "10 of 10 iterations",
          },
        },
      },
      {
        id: "status-done",
        title: "Update item status to Done",
        accuracy: 9,
        p50: 380,
        p95: 920,
        brokenStage: null,
        diagnosis:
          "One transient server error added friction, but retries preserved user value.",
        stages: {
          call: {
            state: "ok",
            observation: "Done was resolved from the board's status labels.",
            meta: "10 of 10 iterations",
          },
          response: {
            state: "warn",
            observation: "One 500 response retried successfully.",
            meta: "1 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "The item reached Done in every iteration.",
            meta: "10 of 10 iterations",
          },
        },
      },
      {
        id: "add-tag",
        title: "Add a tag to an existing item",
        accuracy: 10,
        p50: 350,
        p95: 540,
        brokenStage: null,
        diagnosis: "The agent reused the existing tag correctly in every run.",
        stages: {
          discovery: {
            state: "ok",
            observation: "The tag catalog returned stable ids.",
            meta: "10 of 10 iterations",
          },
          call: {
            state: "ok",
            observation:
              "The existing tag id was reused instead of creating a duplicate.",
            meta: "10 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "The requested tag appeared on the target item.",
            meta: "10 of 10 iterations",
          },
        },
      },
      {
        id: "post-update",
        title: "Post an update on an item",
        accuracy: 10,
        p50: 400,
        p95: 580,
        brokenStage: null,
        diagnosis:
          "The update body remained intact and visible after every call.",
        stages: {
          call: {
            state: "ok",
            observation:
              "Monday markup was passed through without being rewritten.",
            meta: "10 of 10 iterations",
          },
          response: {
            state: "ok",
            observation: "No tool errors were observed.",
            meta: "10 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "The update was visible on the item.",
            meta: "10 of 10 iterations",
          },
        },
      },
    ],
  },
  {
    name: "Search and retrieval",
    errorRate: "4.0%",
    topError: "get_board_items_by_name · 4 errors",
    latency: "510 ms / 1.2 s",
    calls: "1.8",
    tokens: "3.4k",
    cases: [
      {
        id: "find-assignee",
        title: "Find items assigned to a user",
        accuracy: 9,
        p50: 520,
        p95: 1100,
        brokenStage: null,
        diagnosis:
          "Name-based matching was slightly brittle, but the correct items usually surfaced.",
        stages: {
          call: {
            state: "warn",
            observation:
              "The assignee was matched by display name instead of user id.",
            meta: "3 of 10 iterations",
          },
          response: {
            state: "ok",
            observation: "The result set returned complete.",
            meta: "10 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "The correct assigned items surfaced.",
            meta: "9 of 10 iterations",
          },
        },
      },
      {
        id: "search-keyword",
        title: "Search items by keyword",
        accuracy: 8,
        p50: 610,
        p95: 1400,
        brokenStage: "response",
        diagnosis:
          "The response is the earliest break: truncated results were presented as complete.",
        stages: {
          selection: {
            state: "ok",
            observation:
              "The targeted search tool was chosen over listing every board.",
            meta: "10 of 10 iterations",
          },
          response: {
            state: "fail",
            observation:
              "The result set was truncated without a cursor or total.",
            meta: "4 of 10 iterations · can fix",
          },
          value: {
            state: "warn",
            observation: "Two iterations reported partial results as complete.",
            meta: "2 of 10 iterations",
          },
        },
      },
      {
        id: "list-board-items",
        title: "List items on a board",
        accuracy: 10,
        p50: 480,
        p95: 760,
        brokenStage: null,
        diagnosis: "Board scoping and result completeness held in every run.",
        stages: {
          discovery: {
            state: "ok",
            observation: "The board was resolved before listing its items.",
            meta: "10 of 10 iterations",
          },
          response: {
            state: "ok",
            observation: "The full page returned under the server limit.",
            meta: "10 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "Every item on the board was listed.",
            meta: "10 of 10 iterations",
          },
        },
      },
      {
        id: "fetch-item-id",
        title: "Fetch item by id",
        accuracy: 10,
        p50: 300,
        p95: 450,
        brokenStage: null,
        diagnosis: "The direct lookup path was both fast and reliable.",
        stages: {
          call: {
            state: "ok",
            observation: "The identifier was passed through verbatim.",
            meta: "10 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "The correct item returned.",
            meta: "10 of 10 iterations",
          },
        },
      },
      {
        id: "filter-tag-status",
        title: "Filter items by tag and status",
        accuracy: 7,
        p50: 650,
        p95: 1600,
        brokenStage: "call",
        diagnosis:
          "The tool-call contract breaks first when tag and status filters are combined.",
        stages: {
          selection: {
            state: "warn",
            observation:
              "Agents fell back to client-side filtering after a broad list.",
            meta: "4 of 10 iterations",
          },
          call: {
            state: "fail",
            observation:
              "The combined tag and status filter was rejected as invalid params.",
            meta: "3 of 10 iterations · can fix",
          },
          value: {
            state: "warn",
            observation: "Three iterations returned an unfiltered set.",
            meta: "3 of 10 iterations",
          },
        },
      },
    ],
  },
  {
    name: "Boards and groups",
    errorRate: "3.2%",
    topError: "create_update · 3 errors",
    latency: "470 ms / 1.0 s",
    calls: "2.1",
    tokens: "3.9k",
    cases: [
      {
        id: "create-board-timeline",
        title: "Create a board with a timeline column",
        accuracy: 9,
        p50: 540,
        p95: 890,
        brokenStage: null,
        diagnosis:
          "Server coercion covered a weak argument shape without losing the outcome.",
        stages: {
          call: {
            state: "warn",
            observation:
              "The timeline was sent as a plain date pair and coerced server-side.",
            meta: "2 of 10 iterations",
          },
          response: {
            state: "ok",
            observation: "No tool errors were observed.",
            meta: "10 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "The board was created with the requested timeline.",
            meta: "9 of 10 iterations",
          },
        },
      },
      {
        id: "move-current-sprint",
        title: "Move item into the current sprint group",
        accuracy: 8,
        p50: 470,
        p95: 1050,
        brokenStage: null,
        diagnosis:
          "The workflow works, but guessing the active group weakens the outcome.",
        stages: {
          discovery: {
            state: "ok",
            observation: "The group list was fetched before the move.",
            meta: "10 of 10 iterations",
          },
          selection: {
            state: "warn",
            observation: "The active group was guessed instead of verified.",
            meta: "3 of 10 iterations",
          },
          value: {
            state: "warn",
            observation: "Two iterations moved the item into the wrong group.",
            meta: "2 of 10 iterations",
          },
        },
      },
      {
        id: "board-status-update",
        title: "Post a board status update",
        accuracy: 7,
        p50: 590,
        p95: 1300,
        brokenStage: "response",
        diagnosis:
          "Repeated create_update failures are the first clear break in the chain.",
        stages: {
          call: {
            state: "ok",
            observation: "The health value came from documented status labels.",
            meta: "10 of 10 iterations",
          },
          response: {
            state: "fail",
            observation: "create_update returned 500 on repeated posts.",
            meta: "3 of 10 iterations · can fix",
          },
          value: {
            state: "fail",
            observation: "Three iterations left no update on the board.",
            meta: "3 of 10 iterations",
          },
        },
      },
      {
        id: "list-groups",
        title: "List groups on a board",
        accuracy: 10,
        p50: 340,
        p95: 520,
        brokenStage: null,
        diagnosis:
          "Board resolution and ordered group retrieval held throughout.",
        stages: {
          discovery: {
            state: "ok",
            observation: "The board was resolved before groups were requested.",
            meta: "10 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "All groups returned in the expected order.",
            meta: "10 of 10 iterations",
          },
        },
      },
      {
        id: "archive-board",
        title: "Archive a completed board",
        accuracy: 9,
        p50: 430,
        p95: 780,
        brokenStage: null,
        diagnosis:
          "The archive succeeded, though one run skipped the completion check.",
        stages: {
          call: {
            state: "warn",
            observation:
              "Archive was attempted before completion was confirmed.",
            meta: "1 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "The completed board was archived.",
            meta: "9 of 10 iterations",
          },
        },
      },
    ],
  },
  {
    name: "Multi-step flows",
    errorRate: "8.4%",
    topError: "change_item_column_values · 7 errors",
    latency: "1.3 s / 3.2 s",
    calls: "4.6",
    tokens: "9.8k",
    cases: [
      {
        id: "search-update-board",
        title: "Search then update a board",
        accuracy: 7,
        p50: 1240,
        p95: 2900,
        brokenStage: "response",
        diagnosis:
          "Tool response is the earliest hard break and the best place to fix first.",
        stages: {
          discovery: {
            state: "ok",
            observation:
              "Both search and update tools were available to the agent.",
            meta: "10 of 10 iterations",
          },
          selection: {
            state: "warn",
            observation: "Agents retried broad search instead of narrowing it.",
            meta: "4 of 10 iterations",
          },
          call: {
            state: "warn",
            observation:
              "An item id was guessed after a truncated search result.",
            meta: "3 of 10 iterations · can fix",
          },
          response: {
            state: "fail",
            observation:
              "change_item_column_values returned 500 on 7 of 40 calls.",
            meta: "3 of 10 iterations · can fix",
          },
          value: {
            state: "warn",
            observation: "Three iterations ended without the board updated.",
            meta: "3 of 10 iterations",
          },
        },
      },
      {
        id: "create-link-board",
        title: "Create item, then link to a board",
        accuracy: 9,
        p50: 980,
        p95: 1700,
        brokenStage: null,
        diagnosis:
          "The extra call costs time, but the linked item usually lands.",
        stages: {
          call: {
            state: "warn",
            observation:
              "The link was issued as a second call instead of at creation.",
            meta: "4 of 10 iterations",
          },
          response: {
            state: "ok",
            observation: "No tool errors were observed.",
            meta: "10 of 10 iterations",
          },
          value: {
            state: "ok",
            observation: "The item was created and linked.",
            meta: "9 of 10 iterations",
          },
        },
      },
      {
        id: "triage-inbox",
        title: "Triage inbox into groups",
        accuracy: 8,
        p50: 1520,
        p95: 3300,
        brokenStage: null,
        diagnosis:
          "Good selection discipline is undermined by an ambiguous partial-success response.",
        stages: {
          selection: {
            state: "ok",
            observation:
              "The target group was confirmed before moving anything.",
            meta: "10 of 10 iterations",
          },
          response: {
            state: "warn",
            observation:
              "Bulk move returned partial success without per-item detail.",
            meta: "3 of 10 iterations · can fix",
          },
          value: {
            state: "warn",
            observation: "Two iterations left part of the inbox untriaged.",
            meta: "2 of 10 iterations",
          },
        },
      },
      {
        id: "bulk-status",
        title: "Bulk update three item statuses",
        accuracy: 6,
        p50: 1810,
        p95: 4100,
        brokenStage: "response",
        diagnosis:
          "Rate limiting without a retry hint is the first hard failure.",
        stages: {
          selection: {
            state: "warn",
            observation:
              "Without a bulk primitive, agents looped one call per item.",
            meta: "10 of 10 iterations",
          },
          call: {
            state: "warn",
            observation: "The third call was sent before the second resolved.",
            meta: "4 of 10 iterations",
          },
          response: {
            state: "fail",
            observation:
              "The server rate-limited after the second update with no retry hint.",
            meta: "4 of 10 iterations · can fix",
          },
          value: {
            state: "fail",
            observation:
              "Four iterations left the status set only partly applied.",
            meta: "4 of 10 iterations",
          },
        },
      },
      {
        id: "duplicate-check",
        title: "Duplicate check before creating",
        accuracy: 8,
        p50: 1100,
        p95: 2200,
        brokenStage: "discovery",
        diagnosis:
          "The missing duplicate-check primitive breaks the chain at discovery.",
        stages: {
          discovery: {
            state: "fail",
            observation:
              "No primitive exposes a duplicate check, so agents improvised search.",
            meta: "10 of 10 iterations · can fix",
          },
          selection: {
            state: "warn",
            observation: "Two agents created the item without searching first.",
            meta: "2 of 10 iterations",
          },
          value: {
            state: "warn",
            observation: "Two iterations created a duplicate item.",
            meta: "2 of 10 iterations",
          },
        },
      },
    ],
  },
];

const RANGE_DATA: Record<
  Range,
  {
    label: string;
    runs: string;
    success: string;
    delta: string;
    reliability: string;
    latency: string;
    tokens: string;
    chart: number[];
  }
> = {
  "7d": {
    label: "Last 7 days",
    runs: "284",
    success: "94.1%",
    delta: "+2.3 pts",
    reliability: "98.2%",
    latency: "2.1s",
    tokens: "7.2k",
    chart: [88, 90, 89, 92, 91, 93, 94],
  },
  "30d": {
    label: "Last 30 days",
    runs: "1,248",
    success: "81%",
    delta: "+4.6 pts",
    reliability: "97.5%",
    latency: "2.3s",
    tokens: "7.5k",
    chart: [76, 79, 81, 80, 84, 86, 87, 89, 88, 91, 92, 93],
  },
  "90d": {
    label: "Last 90 days",
    runs: "3,614",
    success: "89.6%",
    delta: "+8.1 pts",
    reliability: "96.8%",
    latency: "2.5s",
    tokens: "7.8k",
    chart: [61, 65, 68, 67, 72, 75, 74, 80, 83, 85, 88, 90],
  },
};

const clients = [
  { name: "Copilot", success: 94.5, runs: 624, color: "#6161ff" },
  { name: "ChatGPT", success: 91.1, runs: 624, color: "#00a67e" },
];

function MondayMark() {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-black/5 dark:bg-white/95">
      <div className="flex -rotate-[32deg] items-end gap-0.5">
        <span className="h-4 w-1.5 rounded-full bg-[#f62b54]" />
        <span className="h-3 w-1.5 rounded-full bg-[#ffcb00]" />
        <span className="h-2 w-1.5 rounded-full bg-[#00c875]" />
      </div>
    </div>
  );
}

function SuccessChart({ values }: { values: number[] }) {
  const width = 680;
  const height = 170;
  const padding = 12;
  const min = 55;
  const max = 100;
  const point = (value: number, index: number) => ({
    x: padding + (index * (width - padding * 2)) / (values.length - 1),
    y: padding + ((max - value) * (height - padding * 2)) / (max - min),
  });
  const points = values.map(point);
  const line = points.map(({ x, y }) => `${x},${y}`).join(" ");

  return (
    <div className="relative mt-4 h-[170px] w-full">
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between text-[10px] text-muted-foreground/70">
        {[100, 85, 70, 55].map((value) => (
          <div key={value} className="flex items-center gap-2">
            <span className="w-7 tabular-nums">{value}%</span>
            <span className="h-px flex-1 bg-border/60" />
          </div>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="absolute inset-y-0 left-9 h-full w-[calc(100%-2.25rem)] overflow-visible"
        aria-label="Task success improved throughout the selected period"
        role="img"
      >
        <polyline
          points={line}
          fill="none"
          stroke="#6161ff"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {points.map(({ x, y }, index) => (
          <circle
            key={`${x}-${y}`}
            cx={x}
            cy={y}
            r={index === points.length - 1 ? 5 : 2.5}
            fill={index === points.length - 1 ? "#6161ff" : "white"}
            stroke="#6161ff"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-card p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </p>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

const STAGE_TONE: Record<JourneyStageState, string> = {
  ok: "border-emerald-300/45 bg-emerald-400/15 text-emerald-50",
  warn: "border-amber-300/55 bg-amber-400/15 text-amber-50",
  fail: "border-rose-300/60 bg-rose-500/20 text-rose-50",
  none: "border-white/15 bg-white/[0.045] text-zinc-300",
};

const STAGE_DOT: Record<JourneyStageState, string> = {
  ok: "bg-emerald-300",
  warn: "bg-amber-300",
  fail: "bg-rose-300",
  none: "bg-zinc-500",
};

function stageStateLabel(state: JourneyStageState) {
  if (state === "ok") return "held";
  if (state === "warn") return "warning";
  if (state === "fail") return "failed";
  return "no finding";
}

function firstRelevantStage(testCase: EvalCaseReport): JourneyStageId {
  if (testCase.brokenStage) return testCase.brokenStage;
  return (
    JOURNEY_STAGES.find((stage) => testCase.stages[stage.id])?.id ??
    "connection"
  );
}

type EvalClientKey = "copilot" | "chatgpt";

interface EvalClientResult {
  passCount: number;
  totalCount: number;
  p50: number;
  p95: number;
  tokens: number;
  toolCalls: number;
}

const EVAL_CLIENTS: ReadonlyArray<{
  id: EvalClientKey;
  name: string;
  color: string;
}> = [
  { id: "copilot", name: "Copilot", color: "#6161ff" },
  { id: "chatgpt", name: "ChatGPT", color: "#00a67e" },
];

function parseCompactNumber(value: string): number {
  const amount = Number.parseFloat(value);
  return value.endsWith("k") ? amount * 1_000 : amount;
}

function buildClientResult(
  testCase: EvalCaseReport,
  suite: EvalSuiteReport,
  client: EvalClientKey
): EvalClientResult {
  const isCopilot = client === "copilot";
  const passAdjustment = isCopilot
    ? testCase.accuracy < 10
      ? 1
      : 0
    : testCase.accuracy <= 8
    ? -1
    : 0;
  const passCount = Math.max(
    0,
    Math.min(10, testCase.accuracy + passAdjustment)
  );
  const latencyMultiplier = isCopilot ? 0.92 : 1.08;
  const costMultiplier = isCopilot ? 0.94 : 1.08;

  return {
    passCount,
    totalCount: 10,
    p50: Math.round(testCase.p50 * latencyMultiplier),
    p95: Math.round(testCase.p95 * (isCopilot ? 0.95 : 1.12)),
    tokens: Math.round(parseCompactNumber(suite.tokens) * costMultiplier),
    toolCalls: Number(
      (Number.parseFloat(suite.calls) * (isCopilot ? 0.95 : 1.08)).toFixed(1)
    ),
  };
}

function formatMetricLatency(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)}s` : `${value}ms`;
}

function formatMetricTokens(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
}

const CLIENT_TREND_FACTORS: Record<
  EvalClientKey,
  {
    latency: number[];
    tokens: number[];
    toolCalls: number[];
  }
> = {
  copilot: {
    latency: [1.16, 1.12, 1.09, 1.05, 1.03, 1],
    tokens: [1.11, 1.09, 1.06, 1.04, 1.02, 1],
    toolCalls: [1.08, 1.12, 1.04, 1.07, 1.02, 1],
  },
  chatgpt: {
    latency: [1.07, 1.14, 1.1, 1.08, 1.03, 1],
    tokens: [1.03, 1.09, 1.07, 1.11, 1.04, 1],
    toolCalls: [1.12, 1.06, 1.14, 1.09, 1.04, 1],
  },
};

function scaledTrend(
  latest: number,
  factors: number[],
  precision: number
): number[] {
  return factors.map((factor) => Number((latest * factor).toFixed(precision)));
}

function ClientResultCell({
  result,
  client,
}: {
  result: EvalClientResult;
  client: EvalClientKey;
}) {
  const rate = Math.round((result.passCount / result.totalCount) * 100);
  const tone =
    result.passCount === result.totalCount
      ? {
          label: "Pass",
          dot: "bg-emerald-500",
          text: "text-emerald-600 dark:text-emerald-400",
        }
      : rate >= 70
      ? {
          label: "Partial",
          dot: "bg-amber-500",
          text: "text-amber-600 dark:text-amber-400",
        }
      : {
          label: "Fail",
          dot: "bg-rose-500",
          text: "text-rose-600 dark:text-rose-400",
        };
  const factors = CLIENT_TREND_FACTORS[client];
  const pointLabels = factors.latency.map((_, index) => `Run ${index + 1}`);
  const latencyP50Series = scaledTrend(result.p50, factors.latency, 0);
  const latencyP95Series = scaledTrend(result.p95, factors.latency, 0);
  const tokenSeries = scaledTrend(result.tokens, factors.tokens, 0);
  const toolCallSeries = scaledTrend(result.toolCalls, factors.toolCalls, 1);

  return (
    <div
      className="min-h-[11.5rem] px-4 py-3"
      data-testid={`monday-client-result-${client}`}
    >
      <div className="flex items-center gap-2">
        <span className={cn("size-1.5 rounded-full", tone.dot)} />
        <span className={cn("text-xs font-semibold", tone.text)}>
          {tone.label}
        </span>
        <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">
          {result.passCount}/{result.totalCount}
        </span>
        <span className="ml-auto text-sm font-semibold tabular-nums">
          {rate}%
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full", tone.dot)}
          style={{ width: `${rate}%` }}
        />
      </div>
      <div className="mt-3 grid grid-cols-3 divide-x divide-border/60">
        <div className="min-w-0 pr-2">
          <p className="text-[8px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Latency
          </p>
          <p className="mt-1 truncate text-[10px] font-semibold tabular-nums">
            P50 {formatMetricLatency(result.p50)}
          </p>
          <p className="mt-0.5 truncate text-[8px] text-muted-foreground">
            P95 {formatMetricLatency(result.p95)}
          </p>
          <div className="mt-2">
            <EvalDualSparkline
              primary={latencyP50Series}
              secondary={latencyP95Series}
              pointLabels={pointLabels}
              formatPrimary={formatMetricLatency}
              formatSecondary={formatMetricLatency}
              testId={`monday-client-latency-chart-${client}`}
              height={28}
              tooltipPlacement="above"
            />
          </div>
        </div>
        <div className="min-w-0 px-2">
          <p className="text-[8px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Tokens
          </p>
          <p className="mt-1 truncate text-[11px] font-semibold tabular-nums">
            {formatMetricTokens(result.tokens)}
          </p>
          <p className="mt-0.5 truncate text-[8px] text-muted-foreground">
            per iteration
          </p>
          <div className="mt-2">
            <EvalSparkline
              points={tokenSeries}
              pointLabels={pointLabels}
              formatValue={formatMetricTokens}
              testId={`monday-client-tokens-chart-${client}`}
              height={28}
              tooltipPlacement="above"
            />
          </div>
        </div>
        <div className="min-w-0 pl-2">
          <p className="text-[8px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Tool calls
          </p>
          <p className="mt-1 truncate text-[11px] font-semibold tabular-nums">
            {result.toolCalls.toFixed(1)}
          </p>
          <p className="mt-0.5 truncate text-[8px] text-muted-foreground">
            per iteration
          </p>
          <div className="mt-2">
            <EvalSparkline
              points={toolCallSeries}
              pointLabels={pointLabels}
              formatValue={(value) => value.toFixed(1)}
              testId={`monday-client-tool-calls-chart-${client}`}
              height={28}
              tooltipPlacement="above"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ValueChainInspector({
  testCase,
  selectedStage,
  onSelectStage,
}: {
  testCase: EvalCaseReport;
  selectedStage: JourneyStageId;
  onSelectStage: (stage: JourneyStageId) => void;
}) {
  const stage = JOURNEY_STAGES.find(
    (candidate) => candidate.id === selectedStage
  )!;
  const output = testCase.stages[selectedStage];
  const state = output?.state ?? "none";
  const diagnosisTitle = testCase.brokenStage
    ? JOURNEY_STAGES.find((candidate) => candidate.id === testCase.brokenStage)!
        .title
    : "Held";

  return (
    <article
      className="overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-950 text-zinc-50 shadow-[0_18px_44px_-28px_rgba(0,0,0,0.85)]"
      data-testid="monday-value-chain"
    >
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
        <div>
          <p className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-[#a7a7ff]">
            User value chain
          </p>
          <h4 className="mt-1.5 text-base font-semibold tracking-tight">
            {testCase.title}
          </h4>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-zinc-400">
            Follow the evaluated output from connection through delivered user
            value.
          </p>
        </div>
        <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[9px] text-zinc-400">
          10 iterations · select a stage
        </span>
      </header>

      <div className="px-5 py-4">
        <ol
          className="grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 xl:grid-cols-6"
          role="tablist"
          aria-label="User value chain stages"
        >
          {JOURNEY_STAGES.map((journeyStage) => {
            const stageOutput = testCase.stages[journeyStage.id];
            const stageState = stageOutput?.state ?? "none";
            const selected = journeyStage.id === selectedStage;
            return (
              <li key={journeyStage.id}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`monday-stage-output-${testCase.id}`}
                  onClick={() => onSelectStage(journeyStage.id)}
                  className={cn(
                    "flex min-h-[6.2rem] w-full flex-col rounded-xl border p-3 text-left transition-[background-color,border-color,box-shadow,transform] hover:-translate-y-0.5 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a7a7ff] focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950",
                    STAGE_TONE[stageState],
                    selected &&
                      "border-[#a7a7ff] shadow-[0_0_0_2px_rgba(167,167,255,0.2)]"
                  )}
                >
                  <span className="flex items-center justify-between">
                    <span className="font-mono text-[9px] tracking-wider opacity-60">
                      {journeyStage.num}
                    </span>
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        STAGE_DOT[stageState]
                      )}
                    />
                  </span>
                  <span className="mt-auto text-xs font-semibold">
                    {journeyStage.title}
                  </span>
                  <span className="mt-1 font-mono text-[8px] font-bold uppercase tracking-wider opacity-60">
                    {stageStateLabel(stageState)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(240px,0.7fr)]">
          <section
            id={`monday-stage-output-${testCase.id}`}
            role="tabpanel"
            aria-label={`${stage.title} output`}
            className="rounded-xl border border-white/10 bg-white/[0.045] p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-[8px] font-bold uppercase tracking-[0.15em] text-[#a7a7ff]">
                  Evaluated output
                </p>
                <h5 className="mt-2 text-base font-semibold">{stage.title}</h5>
              </div>
              <span className="rounded-full border border-white/10 px-2 py-1 font-mono text-[8px] uppercase tracking-wider text-zinc-400">
                {stageStateLabel(state)}
              </span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
              {stage.question}
            </p>
            {output ? (
              <div className="mt-4 border-t border-white/10 pt-4">
                <p className="text-sm font-semibold leading-relaxed">
                  {output.observation}
                </p>
                <p className="mt-1 font-mono text-[10px] text-zinc-500">
                  {output.meta}
                </p>
              </div>
            ) : (
              <p className="mt-4 border-t border-white/10 pt-4 text-xs italic leading-relaxed text-zinc-400">
                No finding landed on this stage. This is not evidence that the
                stage passed.
              </p>
            )}
          </section>

          <aside className="rounded-xl border border-[#a7a7ff]/25 bg-[#a7a7ff] p-4 text-zinc-950">
            <p className="font-mono text-[8px] font-bold uppercase tracking-[0.15em] text-zinc-700/80">
              Case read
            </p>
            <h5 className="mt-2 text-base font-semibold">{diagnosisTitle}</h5>
            <p className="mt-2 text-xs leading-relaxed text-zinc-800">
              {testCase.diagnosis}
            </p>
            <p className="mt-5 border-t border-zinc-950/15 pt-3 text-[10px] leading-relaxed text-zinc-700">
              Diagnosis starts at the earliest stage with clear failure
              evidence.
            </p>
          </aside>
        </div>

        <div
          className="mt-4 grid gap-1.5 border-t border-white/10 pt-3 text-[9px] text-zinc-500 sm:grid-cols-2 xl:grid-cols-4"
          aria-label="Value chain state legend"
        >
          <span className="flex items-center gap-2">
            <i className="size-1.5 rounded-full bg-emerald-300" />
            Held · positive evidence
          </span>
          <span className="flex items-center gap-2">
            <i className="size-1.5 rounded-full bg-amber-300" />
            Warning · friction or weak outcome
          </span>
          <span className="flex items-center gap-2">
            <i className="size-1.5 rounded-full bg-rose-300" />
            Failed · clear break
          </span>
          <span className="flex items-center gap-2">
            <i className="size-1.5 rounded-full bg-zinc-500" />
            No finding · do not infer pass
          </span>
        </div>
      </div>
    </article>
  );
}

function EvalCasesReport() {
  const [openCaseId, setOpenCaseId] = useState<string | null>(
    "search-update-board"
  );
  const [selectedStage, setSelectedStage] =
    useState<JourneyStageId>("response");

  const toggleCase = (testCase: EvalCaseReport) => {
    if (openCaseId === testCase.id) {
      setOpenCaseId(null);
      return;
    }
    setOpenCaseId(testCase.id);
    setSelectedStage(firstRelevantStage(testCase));
  };

  return (
    <section
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
      aria-labelledby="monday-eval-cases-title"
    >
      <header className="flex flex-wrap items-end justify-between gap-3 border-b px-5 py-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6161ff]">
            Reliability evidence
          </p>
          <h3
            id="monday-eval-cases-title"
            className="mt-1 text-sm font-semibold"
          >
            Eval test cases
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Latest case results across clients, with the user value chain under
            each test
          </p>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          20 cases · 2 clients · 10 iterations each
        </span>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] table-fixed border-collapse">
          <colgroup>
            <col className="w-[300px]" />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b bg-muted/30 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              <th className="border-r px-5 py-3 text-left align-bottom">
                Case <span className="ml-1 font-mono">20</span>
              </th>
              {EVAL_CLIENTS.map((client) => (
                <th
                  key={client.id}
                  className="border-r px-5 py-3 text-center align-bottom last:border-r-0"
                >
                  <span className="inline-flex items-center gap-2">
                    <i
                      className="size-2 rounded-full"
                      style={{ backgroundColor: client.color }}
                    />
                    {client.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          {evalSuites.map((suite) => (
            <tbody
              key={suite.name}
              className="divide-y divide-border/50 border-b last:border-b-0"
            >
              <tr>
                <th colSpan={3} className="bg-muted/[0.14] px-5 py-3 text-left">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-baseline gap-3">
                      <h4 className="text-sm font-semibold">{suite.name}</h4>
                      <span className="font-mono text-[9px] font-normal uppercase tracking-wide text-muted-foreground">
                        {suite.cases.length} cases · {suite.cases.length * 20}{" "}
                        iterations
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-[9px] font-normal text-muted-foreground">
                      <span>
                        <b className="font-semibold text-foreground">
                          {suite.errorRate}
                        </b>{" "}
                        tool errors
                      </span>
                      <span>
                        <b className="font-semibold text-foreground">
                          {suite.latency}
                        </b>{" "}
                        p50 / p95
                      </span>
                      <span>
                        <b className="font-semibold text-foreground">
                          {suite.calls}
                        </b>{" "}
                        calls
                      </span>
                      <span>
                        <b className="font-semibold text-foreground">
                          {suite.tokens}
                        </b>{" "}
                        tokens
                      </span>
                    </div>
                  </div>
                </th>
              </tr>
              {suite.cases.map((testCase) => {
                const open = openCaseId === testCase.id;
                const clientResults = EVAL_CLIENTS.map((client) => ({
                  client,
                  result: buildClientResult(testCase, suite, client.id),
                }));
                const rates = clientResults.map(
                  ({ result }) =>
                    result.passCount / Math.max(result.totalCount, 1)
                );
                const diverges = rates[0] !== rates[1];

                return (
                  <Fragment key={testCase.id}>
                    <tr
                      className={cn(
                        "group align-top",
                        diverges && "bg-amber-500/[0.035]"
                      )}
                      data-testid={`monday-eval-row-${testCase.id}`}
                    >
                      <td
                        className={cn(
                          "border-r align-top",
                          diverges && "border-l-2 border-l-amber-500"
                        )}
                      >
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={`monday-value-chain-${testCase.id}`}
                          onClick={() => toggleCase(testCase)}
                          className="flex min-h-[11.5rem] w-full flex-col px-5 py-3 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#6161ff]"
                        >
                          <span className="flex w-full items-start gap-2">
                            {open ? (
                              <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#6161ff]" />
                            ) : (
                              <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                            )}
                            <span className="text-xs font-semibold leading-snug">
                              {testCase.title}
                            </span>
                          </span>
                          <span className="mt-auto pl-5 font-mono text-[9px] tabular-nums text-muted-foreground">
                            aggregate {testCase.accuracy}/10 · p50{" "}
                            {formatMetricLatency(testCase.p50)}
                          </span>
                          {diverges ? (
                            <span className="mt-1 pl-5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
                              Client results diverge
                            </span>
                          ) : null}
                        </button>
                      </td>
                      {clientResults.map(({ client, result }) => (
                        <td
                          key={client.id}
                          className="border-r align-top last:border-r-0"
                        >
                          <ClientResultCell
                            result={result}
                            client={client.id}
                          />
                        </td>
                      ))}
                    </tr>
                    {open ? (
                      <tr id={`monday-value-chain-${testCase.id}`}>
                        <td colSpan={3} className="bg-muted/[0.08] px-5 py-4">
                          <ValueChainInspector
                            testCase={testCase}
                            selectedStage={selectedStage}
                            onSelectStage={setSelectedStage}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

export function MondayReportingDashboard() {
  const [range, setRange] = useState<Range>("30d");
  const data = RANGE_DATA[range];
  const exportReport = () => {
    const evalRows = evalSuites.flatMap((suite) =>
      suite.cases.flatMap((testCase) =>
        EVAL_CLIENTS.map((client) => {
          const result = buildClientResult(testCase, suite, client.id);
          return [
            suite.name,
            testCase.title,
            client.name,
            `${result.passCount}/${result.totalCount}`,
            `${Math.round((result.passCount / result.totalCount) * 100)}%`,
            `${result.p50} ms`,
            `${result.p95} ms`,
            String(result.tokens),
            result.toolCalls.toFixed(1),
            testCase.brokenStage
              ? JOURNEY_STAGES.find(
                  (stage) => stage.id === testCase.brokenStage
                )!.title
              : "Held",
            testCase.diagnosis,
          ];
        })
      )
    );
    const rows = [
      ["Monday.com reliability report", data.label],
      ["Metric", "Value"],
      ["Task success", data.success],
      ["Tool reliability", data.reliability],
      ["Evaluated runs", data.runs],
      ["Latency p50", data.latency],
      ["Tokens per run", data.tokens],
      [],
      [
        "Eval suite",
        "Test case",
        "Client",
        "Passed",
        "Pass rate",
        "Latency p50",
        "Latency p95",
        "Tokens",
        "Tool calls",
        "Earliest break",
        "User value chain read",
      ],
      ...evalRows,
    ];
    const csv = rows
      .map((row) =>
        row
          .map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`)
          .join(",")
      )
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `monday-reliability-report-${range}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-border/70 bg-muted/10"
      data-testid="monday-reporting-dashboard"
    >
      <div className="mx-auto max-w-[1500px] space-y-4 p-5">
        <section className="relative overflow-hidden rounded-2xl border bg-card px-5 py-4 shadow-sm">
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <MondayMark />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold tracking-tight">
                    Monday.com reliability report
                  </h2>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Production readiness across 40 workflows · updated 12 minutes
                  ago
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg border bg-background p-0.5">
                {(["7d", "30d", "90d"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setRange(option)}
                    className={cn(
                      "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                      range === option
                        ? "bg-foreground text-background shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    aria-pressed={range === option}
                  >
                    {option}
                  </button>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
                onClick={exportReport}
              >
                <Download className="h-3.5 w-3.5" />
                Export
              </Button>
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard
            label="Task success"
            value={data.success}
            detail={
              <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                <ArrowUpRight className="h-3.5 w-3.5" />
                {data.delta} vs prior period
              </span>
            }
          />
          <MetricCard
            label="Tool reliability"
            value={data.reliability}
            detail="2.5% tool-call error rate"
          />
          <MetricCard
            label="Evaluated runs"
            value={data.runs}
            detail={`${data.label.toLowerCase()} · 2 clients`}
          />
          <MetricCard
            label="Latency p50"
            value={data.latency}
            detail="p95 5.4s · within target"
          />
          <MetricCard
            label="Tokens / run"
            value={data.tokens}
            detail="−8.2% since prompt update"
          />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold">
                  Task success over time
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Weekly pass rate across Copilot and ChatGPT
                </p>
              </div>
              <div className="text-right">
                <p className="text-lg font-semibold tabular-nums">
                  {data.success}
                </p>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  current
                </p>
              </div>
            </div>
            <SuccessChart values={data.chart} />
            <div className="ml-9 mt-2 flex justify-between text-[10px] text-muted-foreground">
              <span>Jul 28</span>
              <span>Aug 4</span>
              <span>Aug 11</span>
              <span>Aug 18</span>
              <span>Aug 25</span>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <h3 className="text-sm font-semibold">Client readiness</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Same workflows, evaluated by client
            </p>
            <div className="mt-5 space-y-5">
              {clients.map((client) => (
                <div key={client.name}>
                  <div className="mb-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: client.color }}
                      />
                      <span className="text-sm font-medium">{client.name}</span>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-semibold tabular-nums">
                        {client.success}%
                      </span>
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {client.runs} runs
                      </span>
                    </div>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${client.success}%`,
                        backgroundColor: client.color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <EvalCasesReport />

        <section>
          <div className="rounded-xl border bg-card p-5 shadow-sm">
            <h3 className="text-sm font-semibold">Release recommendation</h3>
            <div className="mt-4 flex items-center gap-3 rounded-lg bg-emerald-500/[0.08] p-3 ring-1 ring-inset ring-emerald-500/20">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              <div>
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                  Ready for controlled rollout
                </p>
                <p className="text-[11px] text-emerald-700/75 dark:text-emerald-300/75">
                  Core workflows meet the 90% launch threshold
                </p>
              </div>
            </div>
            <div className="mt-5 space-y-4">
              <div className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-[10px] font-bold text-emerald-600">
                  1
                </span>
                <div>
                  <p className="text-xs font-medium">
                    Ship board and item workflows
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    98% combined success with stable latency.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-[10px] font-bold text-amber-600">
                  2
                </span>
                <div>
                  <p className="text-xs font-medium">
                    Guard advanced automations
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    Keep behind a feature flag until success exceeds 85%.
                  </p>
                </div>
              </div>
              <div className="flex gap-3">
                <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                <div>
                  <p className="text-xs font-medium">
                    Re-evaluate after schema fix
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                    Next scheduled suite run: Aug 27 at 9:00 AM.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
