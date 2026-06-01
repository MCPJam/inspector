import { cn } from "@/lib/utils";
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";

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
  const resolvedLogo = logoSrc ?? resolveHostLogoByDisplayName(name);

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
