import {
  EnvironmentComposer,
  SWARM_COMPOSER_SLOTS,
} from "@/components/environment-composer/environment-composer";
import { composerStateFromEnvironments } from "@/components/environment-composer/environment-stack";
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
  const value = inherited
    ? composerStateFromEnvironments(
        target.liveEnvironments.filter((env) =>
          inherited.includes(env.environmentId),
        ),
      )
    : target.state;
  return (
    <EnvironmentComposer
      projectId={projectId}
      slots={SWARM_COMPOSER_SLOTS}
      environments={target.liveEnvironments}
      value={value}
      onChange={(next) => {
        onEdit();
        target.setState(next);
      }}
      emptyServerLabel="Pick a server or group"
      serverOptional={false}
      disabled={disabled}
    />
  );
}
