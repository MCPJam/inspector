/**
 * Starter scripts for the Code method (EFTW-90). Each one works as written:
 * it reads the iteration from `$MCPJAM_ITERATION`, checks the agent's tool
 * calls in `transcript.toolCalls`, and writes `{"score", "reason"}` to
 * `$MCPJAM_RESULT`. The grading box runs `.py` with `python3 -I`, `.ts` with
 * Node (which strips the types), and `.sh` with bash; it has no `jq`.
 */
export type CodeEvaluatorStarter = {
  language: "Python" | "TypeScript" | "Bash";
  fileName: string;
  script: string;
};

const PYTHON = `import json
import os

# Reads the iteration from $MCPJAM_ITERATION and writes
# {"score": 0 to 1, "reason": "..."} to $MCPJAM_RESULT.
# Passes when the agent called a tool and never repeated a call with the
# same arguments. Change the checks below to grade what you need.
with open(os.environ["MCPJAM_ITERATION"]) as f:
    iteration = json.load(f)

calls = iteration["transcript"]["toolCalls"]
count = f"{len(calls)} tool call{'' if len(calls) == 1 else 's'}"
print(f"Read {count}")

seen = set()
repeated = set()
for call in calls:
    key = (call["toolName"], json.dumps(call.get("arguments", {}), sort_keys=True))
    if key in seen:
        repeated.add(call["toolName"])
    seen.add(key)

if not calls:
    result = {"score": 0, "reason": "The agent made no tool calls."}
elif repeated:
    names = ", ".join(sorted(repeated))
    result = {"score": 0, "reason": f"Repeated a call with the same arguments: {names}."}
else:
    result = {"score": 1, "reason": f"Made {count}, none repeated."}

with open(os.environ["MCPJAM_RESULT"], "w") as f:
    json.dump(result, f)
`;

const TYPESCRIPT = `import { readFileSync, writeFileSync } from "node:fs";

// Reads the iteration from $MCPJAM_ITERATION and writes
// {"score": 0 to 1, "reason": "..."} to $MCPJAM_RESULT.
// Scores the share of tool calls that weren't a repeat of an earlier call
// with the same arguments, so at the default passing score of 1 any repeat
// fails. Change the checks below to grade what you need.
type ToolCall = { toolName: string; arguments?: Record<string, unknown> };

const iteration = JSON.parse(
  readFileSync(process.env.MCPJAM_ITERATION as string, "utf8"),
);
const calls: ToolCall[] = iteration.transcript.toolCalls;
const count = \`\${calls.length} tool call\${calls.length === 1 ? "" : "s"}\`;
console.log(\`Read \${count}\`);

const seen = new Set<string>();
let repeats = 0;
for (const call of calls) {
  const key = \`\${call.toolName} \${JSON.stringify(call.arguments ?? {})}\`;
  if (seen.has(key)) repeats += 1;
  seen.add(key);
}

const result =
  calls.length === 0
    ? { score: 0, reason: "The agent made no tool calls." }
    : {
        score: (calls.length - repeats) / calls.length,
        reason: \`Repeated \${repeats} of \${count}.\`,
      };

writeFileSync(process.env.MCPJAM_RESULT as string, JSON.stringify(result));
`;

const BASH = `#!/usr/bin/env bash
# Reads the iteration from $MCPJAM_ITERATION and writes
# {"score": 0 to 1, "reason": "..."} to $MCPJAM_RESULT.
# Passes when the agent made at least one tool call and no more than
# max_calls. Change the checks below to grade what you need.
set -euo pipefail

max_calls=10
# The grading box has node and python3 to read JSON, but not jq.
calls=$(node -e 'const iteration = JSON.parse(require("fs").readFileSync(process.env.MCPJAM_ITERATION, "utf8")); console.log(iteration.transcript.toolCalls.length)')
if [ "$calls" -eq 1 ]; then count="1 tool call"; else count="$calls tool calls"; fi
echo "Read $count"

if [ "$calls" -eq 0 ]; then
  score=0
  reason="The agent made no tool calls."
elif [ "$calls" -gt "$max_calls" ]; then
  score=0
  reason="Made $count, more than $max_calls."
else
  score=1
  reason="Made $count, no more than $max_calls."
fi
printf '{"score": %s, "reason": "%s"}\\n' "$score" "$reason" > "$MCPJAM_RESULT"
`;

export const CODE_EVALUATOR_STARTERS: readonly CodeEvaluatorStarter[] = [
  { language: "Python", fileName: "check_tool_calls.py", script: PYTHON },
  {
    language: "TypeScript",
    fileName: "check_tool_calls.ts",
    script: TYPESCRIPT,
  },
  { language: "Bash", fileName: "check_tool_calls.sh", script: BASH },
];

/** True when the script holds something a starter would overwrite. */
export function isEditedScript(script: string): boolean {
  return (
    script.trim() !== "" &&
    !CODE_EVALUATOR_STARTERS.some((starter) => starter.script === script)
  );
}

/**
 * The file name after picking a starter: a valid name keeps its stem and
 * takes the starter's extension, so `check_totals.py` becomes
 * `check_totals.ts`; anything else takes the starter's own name.
 */
export function fileNameForStarter(
  fileName: string,
  starter: CodeEvaluatorStarter,
): string {
  const stem = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.(?:py|ts|js|sh)$/.exec(
    fileName.trim(),
  )?.[1];
  const extension = starter.fileName.slice(starter.fileName.lastIndexOf("."));
  return stem ? `${stem}${extension}` : starter.fileName;
}
