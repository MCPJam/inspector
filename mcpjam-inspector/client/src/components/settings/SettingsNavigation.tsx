import { useEffect, useState, type ComponentProps } from "react";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useGithubChecksAvailability } from "@/hooks/useGithubChecksSettings";
import { useDiscordAgentEnabled } from "@/hooks/useDiscordAgentEnabled";
import { useTraceDestinationsEnabled } from "@/hooks/useTraceDestinationsEnabled";
import { useIntegrationsTabEnabled } from "@/hooks/useIntegrationsTabEnabled";
import { useTraceDestinationsAvailability } from "@/hooks/useOrgTraceDestinations";
import { SettingsRail } from "./SettingsRail";
import type { SettingsContext } from "@/lib/settings-manifest";

type Availability = {
  organizationId: string;
  features: SettingsContext["features"];
};
function AvailabilityProbe({
  organizationId,
  onChange,
}: {
  organizationId: string;
  onChange: (value: Availability) => void;
}) {
  const github =
    useGithubChecksAvailability(organizationId)?.state === "enabled";
  const discord = useDiscordAgentEnabled();
  const tracesEnabled = useTraceDestinationsEnabled();
  const observability =
    useTraceDestinationsAvailability(tracesEnabled ? organizationId : null)
      ?.state === "enabled";
  const integrations = useIntegrationsTabEnabled();
  useEffect(() => {
    onChange({
      organizationId,
      features: { github, discord, observability, integrations },
    });
  }, [organizationId, github, discord, observability, integrations, onChange]);
  return null;
}
/** Availability errors must never take down settings navigation. */
export function SettingsNavigation(props: ComponentProps<typeof SettingsRail>) {
  const [availability, setAvailability] = useState<Availability | null>(null);
  const organizationId = props.context.organizationId;
  return (
    <>
      {props.enabled && organizationId && (
        <ErrorBoundary
          key={organizationId}
          name="settings_search_availability"
          fallback={null}
        >
          <AvailabilityProbe
            organizationId={organizationId}
            onChange={setAvailability}
          />
        </ErrorBoundary>
      )}
      <SettingsRail
        {...props}
        context={{
          ...props.context,
          features:
            availability?.organizationId === organizationId
              ? availability?.features
              : undefined,
        }}
      />
    </>
  );
}
