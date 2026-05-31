import { cn } from "@/lib/utils";
import { getChatboxHostLogo } from "@/lib/chatbox-client-style";
import { listHostStyles } from "@/lib/client-styles";

function resolveLogoForClientName(displayName: string): string | null {
  const needle = displayName.trim().toLowerCase().replace(/\s+/g, "");
  if (!needle) return null;

  for (const style of listHostStyles()) {
    const id = style.id.toLowerCase();
    const label = style.chatUi.label.toLowerCase().replace(/\s+/g, "");
    const shortLabel = style.chatUi.shortLabel.toLowerCase().replace(/\s+/g, "");
    if (needle === id || needle === label || needle === shortLabel) {
      return getChatboxHostLogo(style.id);
    }
  }
  return null;
}

/** Read-only chip matching selected {@link HostCompareChip} styling. */
export function ClientChip({
  name,
  hostId,
  logoSrc,
  className,
}: {
  name: string;
  hostId?: string;
  logoSrc?: string | null;
  className?: string;
}) {
  const resolvedLogo = logoSrc ?? resolveLogoForClientName(name);

  return (
    <span
      className={cn(
        "inline-flex max-w-[180px] items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
        "border-primary/35 bg-primary/8 text-foreground shadow-xs",
        className,
      )}
      title={hostId ?? name}
    >
      {resolvedLogo ? (
        <img
          src={resolvedLogo}
          alt=""
          className="size-3.5 shrink-0 object-contain"
        />
      ) : (
        <span
          aria-hidden
          className="size-3.5 shrink-0 rounded-full bg-muted"
        />
      )}
      <span className="min-w-0 truncate font-medium leading-tight">
        {name}
      </span>
    </span>
  );
}
