import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { resolveProjectIcon } from "@/components/project/ProjectEmojiPicker";
const ORG_TINTS: Array<{ bg: string; fg: string }> = [
  { bg: "bg-blue-500/15", fg: "text-blue-700 dark:text-blue-300" },
  { bg: "bg-violet-500/15", fg: "text-violet-700 dark:text-violet-300" },
  { bg: "bg-emerald-500/15", fg: "text-emerald-700 dark:text-emerald-300" },
  { bg: "bg-amber-500/15", fg: "text-amber-700 dark:text-amber-300" },
  { bg: "bg-rose-500/15", fg: "text-rose-700 dark:text-rose-300" },
  { bg: "bg-cyan-500/15", fg: "text-cyan-700 dark:text-cyan-300" },
];

function getOrgTint(orgId: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < orgId.length; i++) {
    hash = (hash * 31 + orgId.charCodeAt(i)) | 0;
  }
  return ORG_TINTS[Math.abs(hash) % ORG_TINTS.length];
}

export function OrgIconBadge({
  org,
  size,
}: {
  org?: { _id: string; name: string };
  size: 5 | 6 | 8;
}) {
  const sizeClass =
    size === 8
      ? "size-8 rounded-lg"
      : size === 6
        ? "size-6 rounded-md"
        : "size-5 rounded";
  const textClass =
    size === 8 ? "text-sm" : size === 6 ? "text-[11px]" : "text-[10px]";
  const iconClass = size === 8 ? "size-4" : "size-3.5";
  if (!org) {
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-muted text-muted-foreground shrink-0",
          sizeClass,
        )}
      >
        <Building2 className={iconClass} />
      </div>
    );
  }
  const tint = getOrgTint(org._id);
  return (
    <div
      className={cn(
        "flex items-center justify-center font-semibold shrink-0",
        sizeClass,
        textClass,
        tint.bg,
        tint.fg,
      )}
    >
      {org.name.charAt(0).toUpperCase()}
    </div>
  );
}

export function ProjectIconBadge({
  icon,
  fallback,
}: {
  icon?: string;
  fallback: string;
}) {
  const IconComponent = icon ? resolveProjectIcon(icon) : null;
  return (
    <div className="flex size-6 items-center justify-center rounded bg-primary/10 text-[11px] font-semibold text-primary shrink-0">
      {IconComponent ? (
        <IconComponent className="h-3.5 w-3.5" strokeWidth={1.5} />
      ) : (
        fallback
      )}
    </div>
  );
}
