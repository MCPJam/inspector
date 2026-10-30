import {
  connectionLabels,
  type OAuthConnection,
} from "@/shared/oauth-connections";
import type { TrackedTask } from "./task-tracker";
import type { TaskPanelTarget } from "./task-panel-api";

export interface TaskAccountOption {
  id: string;
  label: string;
  target?: TaskPanelTarget;
}

export function taskAccountOptions(
  serverId: string,
  scope: string,
  accounts: OAuthConnection[],
  tasks: TrackedTask[],
): TaskAccountOption[] {
  const options: TaskAccountOption[] = [
    { id: "current", label: "Current connection" },
  ];
  const labels = connectionLabels(accounts);
  const add = (connectionId: string | undefined, label: string) => {
    const wires = [
      ...new Set(
        tasks
          .filter((task) => task.connectionId === connectionId)
          .map((task) => task.wire),
      ),
    ];
    const values = wires.length ? wires : [undefined];
    for (const wire of values) {
      const id = JSON.stringify([connectionId ?? null, wire ?? null]);
      if (options.some((option) => option.id === id)) continue;
      options.push({
        id,
        label:
          wires.length > 1
            ? `${label} (${wire === "extension" ? "2026" : "2025"})`
            : label,
        target: { serverId, scope, connectionId, wire },
      });
    }
  };
  accounts.forEach((account, index) =>
    add(account.connectionId, labels[index]),
  );
  const missing = [...new Set(tasks.map((task) => task.connectionId))].filter(
    (id) =>
      id !== undefined &&
      !accounts.some((account) => account.connectionId === id),
  );
  missing.forEach((id, index) => add(id, `Disconnected account ${index + 1}`));
  if (!accounts.length || tasks.some((task) => task.connectionId === undefined))
    add(undefined, "Saved tasks");
  return options;
}
