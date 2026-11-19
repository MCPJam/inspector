import { resolveHostLogo } from "@/lib/host-logo";
import { HostChipLogo } from "@/components/hosts/host-chip";

/**
 * Small host logo mark keyed by display name. Shared by the new-journey form
 * (host picker) and the journey matrix header/cells.
 */
export function JourneyHostLogoMark({
  label,
  hostStyle,
}: {
  label: string;
  hostStyle?: string | null;
}) {
  const logoSrc = resolveHostLogo({ name: label, hostStyle });
  return <HostChipLogo logoSrc={logoSrc} name={label} size="sm" />;
}
