import { useRef, type ComponentProps } from "react";
import { EnvironmentComposer } from "@/components/environment-composer/environment-composer";
import { useCloudServerReadiness } from "@/components/environment-composer/use-cloud-server-readiness";
import { CloudUnreachableNotice } from "@/components/computer/CloudUnreachableNotice";
import { describeCloudServerBlock } from "@/lib/cloud-server-readiness";
import { navigateApp, routePaths } from "@/lib/app-navigation";

type Props = Pick<
  ComponentProps<typeof EnvironmentComposer>,
  "projectId" | "environments" | "value" | "onChange" | "disabled"
> & { hostsLoading: boolean };

export function UserTestingEnvironmentComposer({
  projectId,
  environments,
  value,
  onChange,
  disabled,
  hostsLoading,
}: Props) {
  const composerRef = useRef<HTMLDivElement>(null);
  const readiness = useCloudServerReadiness({
    projectId,
    environments,
    state: value,
  });
  const block =
    !hostsLoading && readiness.status === "no_servers"
      ? describeCloudServerBlock(readiness)
      : null;
  const action = block?.action
    ? {
        label: block.action.label,
        onClick: () => navigateApp(routePaths.servers),
      }
    : readiness.status === "no_servers" && readiness.attachable.length > 0
      ? {
          label: "Choose servers",
          onClick: () =>
            composerRef.current
              ?.querySelector<HTMLButtonElement>(
                '[data-testid="user-testing-create-servers-picker"]',
              )
              ?.click(),
        }
      : undefined;

  return (
    <div ref={composerRef} className="space-y-2">
      {block ? (
        <CloudUnreachableNotice
          data-testid="user-testing-create-servers-required"
          message={block.message}
          detail={block.detail}
          tone={block.tone}
          action={disabled ? undefined : action}
        />
      ) : null}
      <EnvironmentComposer
        projectId={projectId}
        environments={environments}
        value={value}
        onChange={onChange}
        maxTargets={1}
        disabled={disabled}
        testIdPrefix="user-testing-create"
      />
    </div>
  );
}
