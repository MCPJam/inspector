import { cn } from "@/lib/utils";
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";

const hostChipLogoClass = {
  default: "size-3.5",
  sm: "size-3.5",
  stack: "size-5",
} as const;

function HostChipLogo({
  logoSrc,
  name,
  size,
}: {
  logoSrc: string | null;
  name: string;
  size: keyof typeof hostChipLogoClass;
}) {
  if (logoSrc) {
    return (
      <img
        src={logoSrc}
        alt=""
        className={cn("shrink-0 object-contain", hostChipLogoClass[size])}
      />
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md bg-muted font-semibold uppercase text-muted-foreground",
        size === "stack" ? "size-5 text-[9px]" : "size-3.5 text-[8px]",
      )}
    >
      {name.slice(0, 2)}
    </span>
  );
}

/** Read-only chip matching selected {@link HostCompareChip} styling. */
export function HostChip({
  name,
  hostId,
  logoSrc,
  size = "default",
  layout = "inline",
  className,
}: {
  name: string;
  hostId?: string;
  logoSrc?: string | null;
  size?: "default" | "sm";
  layout?: "inline" | "stack";
  className?: string;
}) {
  const resolvedLogo = logoSrc ?? resolveHostLogoByDisplayName(name);
  const title = hostId ?? name;
  const logoSize = layout === "stack" ? "stack" : size;

  if (layout === "stack") {
    return (
      <span
        className={cn(
          "inline-flex max-w-[11rem] flex-col items-center gap-1 text-foreground",
          className,
        )}
        title={title}
      >
        <HostChipLogo logoSrc={resolvedLogo} name={name} size={logoSize} />
        <span
          className={cn(
            "max-w-full truncate text-center font-medium leading-tight",
            size === "sm" ? "text-[11px]" : "text-xs",
          )}
        >
          {name}
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex max-w-[180px] items-center gap-1.5 rounded-full border text-foreground",
        "border-primary/35 bg-primary/8 shadow-xs",
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-[12px]",
        className,
      )}
      title={title}
    >
      <HostChipLogo logoSrc={resolvedLogo} name={name} size={logoSize} />
      <span className="min-w-0 truncate font-medium leading-tight">{name}</span>
    </span>
  );
}
