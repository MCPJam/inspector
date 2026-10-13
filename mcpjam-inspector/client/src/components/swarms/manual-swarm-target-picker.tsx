import {
  EnvironmentComposer,
  SWARM_COMPOSER_SLOTS,
} from "@/components/environment-composer/environment-composer";
import { Button } from "@mcpjam/design-system/button";
import { emptyComposerState } from "@/components/environment-composer/environment-stack";
import { environmentLabel } from "@/lib/environment-label";
import type { SwarmDefaultTarget } from "./use-swarm-default-target";

export function ManualSwarmTargetPicker({
  projectId,
  target,
  inherited,
  disabled,
  onEdit,
}: {
  projectId: string;
  target: SwarmDefaultTarget;
  inherited: string[] | null;
  disabled: boolean;
  onEdit: () => void;
}) {
  if (inherited) {
    return (
      <div className="mb-2 space-y-2 text-xs text-muted-foreground">
        <p>Uses the targets from this persona’s existing goals.</p>
        <ul>
          {inherited.map((id, index) => {
            const env = target.liveEnvironments.find(
              (row) => row.environmentId === id,
            );
            return (
              <li key={id}>
                Target {index + 1}:{" "}
                {env ? environmentLabel(env) : "Loading target…"}
              </li>
            );
          })}
        </ul>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            target.setState({ ...emptyComposerState(), customized: true });
            onEdit();
          }}
        >
          Replace targets
        </Button>
      </div>
    );
  }
  return (
    <div className="mb-2 space-y-2">
      <EnvironmentComposer
        projectId={projectId}
        slots={SWARM_COMPOSER_SLOTS}
        environments={target.liveEnvironments}
        value={target.state}
        onChange={(next) => {
          onEdit();
          target.setState(next);
        }}
        emptyServerLabel="Pick a server or group"
        serverOptional={false}
        disabled={disabled}
      />
      {target.noServers ? (
        <p role="alert" className="text-xs text-destructive">
          Pick a server or group with at least one server.
        </p>
      ) : null}
    </div>
  );
}
