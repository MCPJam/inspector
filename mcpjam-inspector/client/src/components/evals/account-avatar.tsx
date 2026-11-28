import { cn } from "@/lib/utils";

/** `--account-avatar-{n}-{bg,fg}` in `design-system/src/tokens.css`. */
const ACCOUNT_AVATAR_TINTS = [
  "bg-[var(--account-avatar-1-bg)] text-[var(--account-avatar-1-fg)]",
  "bg-[var(--account-avatar-2-bg)] text-[var(--account-avatar-2-fg)]",
  "bg-[var(--account-avatar-3-bg)] text-[var(--account-avatar-3-fg)]",
  "bg-[var(--account-avatar-4-bg)] text-[var(--account-avatar-4-fg)]",
  "bg-[var(--account-avatar-5-bg)] text-[var(--account-avatar-5-fg)]",
  "bg-[var(--account-avatar-6-bg)] text-[var(--account-avatar-6-fg)]",
] as const;

/** One tint per account, picked from its id so it matches on every screen. */
export function accountAvatarTint(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return ACCOUNT_AVATAR_TINTS[Math.abs(hash) % ACCOUNT_AVATAR_TINTS.length];
}

/** The round initial the Authorization tab shows, tinted per account. */
export function AccountAvatar({
  name,
  seed,
  size = "sm",
  className,
}: {
  name: string;
  /** Stable id for the tint; the name when there is none. */
  seed?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium uppercase",
        size === "md" ? "size-8 text-xs" : "size-4 text-[9px]",
        accountAvatarTint(seed ?? name),
        className,
      )}
    >
      {name.trim().slice(0, 1) || "?"}
    </span>
  );
}
