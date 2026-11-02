import { useMemo, useState, useSyncExternalStore } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Button } from "@mcpjam/design-system/button";
import { TasksTab, type TasksTabProps } from "./TasksTab";
import { useHostedOAuthConnections } from "@/hooks/use-hosted-oauth-connections";
import {
  getApiContextRevision,
  subscribeApiContext,
  tryResolveProjectServer,
} from "@/lib/apis/web/context";
import { getOwnedTaskScope, getTrackedTasks } from "@/lib/task-tracker";
import { isBoundTask } from "@/lib/task-tracker-scope";
import { subscribeTaskBookmarks } from "@/lib/task-tracker-events";
import {
  taskAccountOptions,
  type TaskAccountOption,
} from "@/lib/task-account-options";

export function TaskAccountsTab(props: TasksTabProps) {
  useSyncExternalStore(subscribeApiContext, getApiContextRevision);
  const scope = getOwnedTaskScope();
  const server = props.serverName
    ? tryResolveProjectServer(props.serverName)
    : null;
  if (!scope || !server) return <TasksTab {...props} />;
  return (
    <TaskAccountPanel
      key={JSON.stringify([scope, server.serverId])}
      {...props}
      scope={scope}
      projectId={server.projectId}
      serverId={server.serverId}
    />
  );
}

function TaskAccountPanel(
  props: TasksTabProps & { scope: string; projectId: string; serverId: string },
) {
  const { connections, error, refetch } = useHostedOAuthConnections(
    props.projectId,
    props.serverId,
  );
  const snapshot = useSyncExternalStore(subscribeTaskBookmarks, () =>
    JSON.stringify(
      getTrackedTasks()
        .filter((task) => isBoundTask(task) && task.serverId === props.serverId)
        .map((task) => [task.taskId, task.connectionId, task.wire]),
    ),
  );
  const options = useMemo(
    () =>
      taskAccountOptions(
        props.serverId,
        props.scope,
        connections,
        getTrackedTasks().filter(
          (task) => isBoundTask(task) && task.serverId === props.serverId,
        ),
      ),
    [props.serverId, props.scope, connections, snapshot],
  );
  const [selected, setSelected] = useState<TaskAccountOption>(() => {
    const latest = getTrackedTasks().find(
      (task) => isBoundTask(task) && task.serverId === props.serverId,
    );
    return (
      options.find(
        (option) =>
          latest &&
          option.target?.connectionId === latest.connectionId &&
          option.target?.wire === latest.wire,
      ) ?? options[0]
    );
  });
  const active =
    options.find((option) => option.id === selected.id) ?? selected;
  const visibleOptions = options.some((option) => option.id === active.id)
    ? options
    : [...options, { ...active, label: `${active.label} (unavailable)` }];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Select
          value={active.id}
          onValueChange={(id) =>
            setSelected(
              visibleOptions.find((option) => option.id === id) ?? selected,
            )
          }
        >
          <SelectTrigger aria-label="Task account" className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {visibleOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error && (
          <Button variant="ghost" size="sm" onClick={refetch}>
            Reload accounts
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <TasksTab {...props} taskTarget={active.target} />
      </div>
    </div>
  );
}
