import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";

/**
 * Small host logo mark keyed by display name. Shared by the new-journey form
 * (host picker) and the journey matrix header/cells.
 */
export function JourneyHostLogoMark({ label }: { label: string }) {
  const logoSrc = resolveHostLogoByDisplayName(label);
  if (logoSrc) {
    return (
      <img src={logoSrc} alt="" className="size-3.5 shrink-0 object-contain" />
    );
  }
  return (
    <span aria-hidden className="size-3.5 shrink-0 rounded-full bg-muted" />
  );
}
