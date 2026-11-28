import { Check, ChevronDown, Server } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import type { SuiteAccount } from "@/lib/evals/eval-accounts";
import { AccountAvatar } from "./account-avatar";

const INHERIT_VALUE = "__inherit__";

/** The empty choice: follow the suite (or saved settings) instead of pinning. */
export type AccountPickerInherit = {
  /** "Suite default · Work", in the menu. */
  label: string;
  /** The account it resolves to, shown on the trigger with `note`. */
  accountName?: string;
  /** "(suite default)", after the name on the trigger. */
  note?: string;
};

/** A server icon and name, the label next to every account choice. */
export function ServerLabel({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-muted-foreground",
        className,
      )}
    >
      <Server className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
    </span>
  );
}

/**
 * Avatar, name and chevron, opening the accounts with the Authorization tab's
 * rows. `inline` sits in a line of text; `field` is a settings input.
 */
export function AccountPicker({
  ariaLabel,
  accounts,
  value,
  onChange,
  inherit,
  disabled,
  variant = "inline",
}: {
  ariaLabel: string;
  accounts: readonly SuiteAccount[];
  /** A connection id, or "" for `inherit`. */
  value: string;
  onChange: (connectionId: string) => void;
  inherit?: AccountPickerInherit;
  disabled?: boolean;
  variant?: "inline" | "field";
}) {
  const chosen = accounts.find((account) => account.connectionId === value);
  const name = value
    ? (chosen?.name ?? "Account unavailable")
    : (inherit?.accountName ?? inherit?.label ?? "Choose an account");
  const note = !value && inherit?.accountName ? inherit.note : undefined;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${ariaLabel}: ${name}`}
        disabled={disabled}
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60",
          variant === "field"
            ? "h-9 w-full max-w-72 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent/50"
            : "rounded-md px-1.5 py-0.5 text-xs hover:bg-accent data-[state=open]:bg-accent",
        )}
      >
        {value && !chosen ? null : <AccountAvatar name={name} />}
        <span
          className={cn(
            "min-w-0 truncate",
            variant === "field" ? "flex-1 text-left" : "font-medium",
          )}
        >
          {name}
          {note ? (
            <span className="font-normal text-muted-foreground"> {note}</span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "shrink-0 text-muted-foreground",
            variant === "field" ? "size-4" : "size-3",
          )}
          aria-hidden
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuRadioGroup
          value={value || INHERIT_VALUE}
          onValueChange={(next) => onChange(next === INHERIT_VALUE ? "" : next)}
        >
          {inherit ? (
            <>
              <DropdownMenuRadioItem value={INHERIT_VALUE} hideIndicator>
                <span className="min-w-0 flex-1 truncate">{inherit.label}</span>
                <Check
                  className={cn("size-4", value ? "opacity-0" : "opacity-100")}
                  aria-hidden
                />
              </DropdownMenuRadioItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {accounts.map((account) => (
            <DropdownMenuRadioItem
              key={account.connectionId}
              value={account.connectionId}
              disabled={account.needsReauth}
              hideIndicator
            >
              <AccountAvatar name={account.name} size="md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{account.name}</span>
                {account.needsReauth || account.isDefault ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {account.needsReauth ? "Needs reconnect" : "Default"}
                  </span>
                ) : null}
              </span>
              <Check
                className={cn(
                  "size-4",
                  value === account.connectionId ? "opacity-100" : "opacity-0",
                )}
                aria-hidden
              />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
