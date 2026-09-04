import { resolveHostLogoByName } from "@/lib/host-logo";
import { HostChipLogo } from "@/components/hosts/host-chip";

/**
 * Small host logo mark keyed by display name. Shared by the new-journey form
 * (host picker) and the journey matrix header/cells.
 */
export function JourneyHostLogoMark({ label }: { label: string }) {
  const logoSrc = resolveHostLogoByName(label);
  return <HostChipLogo logoSrc={logoSrc} name={label} size="sm" />;
}
