import { useEffect } from "react";
import {
  isTasksToolCheck,
  MCP_TASKS_TOOL_CHECK_IDS,
  type MCPTasksCheckId,
} from "@mcpjam/sdk/browser";
import {
  CheckToolField,
  ConformanceProbeField,
  TaskAnswersField,
  type ProbeTools,
} from "./ConformanceProbeField";
import type {
  ConformanceProbe,
  ConformanceProbes,
} from "@/hooks/use-conformance-probes";

const UPDATE = "tasks-update-ack-shape";
const HINTS: Partial<Record<MCPTasksCheckId, string>> = {
  "tasks-result-type-discipline":
    "Choose a tool that creates a task when Tasks support is declared.",
  "tasks-ttl-shape":
    "Choose a task whose lifetime and timestamps can be inspected.",
  "tasks-ttl-integer-shape":
    "Checks the task's numeric fields across its observed states.",
  "tasks-mcp-name-routing":
    "Checks that task requests include the task ID in the routing header.",
  "tasks-undeclared-capability-rejected":
    "Uses a separate task to try methods without their capability declarations.",
  "tasks-undeclared-capability-names-requirements":
    "Checks that rejected methods name their required capabilities.",
  "tasks-inline-result":
    "Choose a task that finishes successfully to check its completed result.",
  "tasks-status-payload-shape":
    "Checks the states this task reaches; states it never reaches are not tested.",
  "tasks-update-ack-shape":
    "Choose a task that waits for input, then supply the answers below.",
  "tasks-cancel-ack-shape":
    "Choose a task that stays running long enough to receive cancellation.",
  "tasks-undeclared-creation-refused":
    "Calls the tool without declaring Tasks support.",
};
interface SettingsProps {
  tools: ProbeTools;
  probes: ConformanceProbes;
  onChange: (probes: ConformanceProbes) => void;
}
export function TasksSuiteDefaults({
  tools,
  probes,
  onChange,
  selected,
  onValidChange,
}: SettingsProps & {
  selected?: MCPTasksCheckId[];
  onValidChange: (valid: boolean) => void;
}) {
  if (selected && !selected.some(isTasksToolCheck)) return null;
  return (
    <div className="my-3 space-y-2">
      <p className="text-sm font-medium">Tasks suite default</p>
      <ConformanceProbeField
        probeKey="tasksProbe"
        tools={tools}
        probe={probes.tasksProbe}
        onChange={(probe) => {
          const next = { ...probes };
          if (probe) next.tasksProbe = probe;
          else delete next.tasksProbe;
          onChange(next);
        }}
        onValidChange={onValidChange}
      />
    </div>
  );
}

export function TasksCheckOverride({
  checkId,
  checkTitle,
  picked,
  tools,
  probes,
  onChange,
  onValidChange,
}: SettingsProps & {
  checkId: string;
  /** The row's title, so its dropdown has its own accessible name. */
  checkTitle?: string;
  picked: boolean;
  onValidChange: (part: string, valid: boolean) => void;
}) {
  if (!picked || !isTasksToolCheck(checkId)) return null;
  return (
    <SelectedTaskOverride
      checkId={checkId}
      checkTitle={checkTitle}
      tools={tools}
      probes={probes}
      onChange={onChange}
      onValidChange={onValidChange}
    />
  );
}
function SelectedTaskOverride({
  checkId,
  checkTitle,
  tools,
  probes,
  onChange,
  onValidChange,
}: SettingsProps & {
  checkId: (typeof MCP_TASKS_TOOL_CHECK_IDS)[number];
  checkTitle?: string;
  onValidChange: (part: string, valid: boolean) => void;
}) {
  const override = probes.tasksOverrides?.[checkId];
  const effective = override ?? probes.tasksProbe;
  const setOverride = (probe?: ConformanceProbe) => {
    const tasksOverrides = { ...probes.tasksOverrides };
    if (probe) tasksOverrides[checkId] = probe;
    else delete tasksOverrides[checkId];
    onChange({ ...probes, tasksOverrides });
  };
  useEffect(
    () => () => onValidChange(`${checkId}:answers`, true),
    [checkId],
  );
  return (
    <div className="space-y-2">
      <CheckToolField
        probeKey="tasksProbe"
        tools={tools}
        inherited={probes.tasksProbe}
        override={override}
        inheritLabel="Use suite default"
        checkTitle={checkTitle}
        hint={HINTS[checkId]}
        keepAnswers={checkId === UPDATE}
        onOverrideChange={setOverride}
        onValidChange={(valid) => onValidChange(checkId, valid)}
      />
      {checkId === UPDATE && effective?.toolName ? (
        <TaskAnswersField
          key={`${override ? "custom" : "default"}:${effective.toolName}`}
          probe={effective}
          onChange={(probe) =>
            override
              ? setOverride(probe)
              : onChange({ ...probes, tasksProbe: probe })
          }
          onInvalidChange={(invalid) =>
            onValidChange(`${checkId}:answers`, !invalid)
          }
        />
      ) : null}
    </div>
  );
}
