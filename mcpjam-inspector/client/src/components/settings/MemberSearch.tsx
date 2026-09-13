import type { ReactNode } from "react";
import {
  Search,
  SlidersHorizontal,
  UserRound,
  Shield,
  Crown,
  UserRoundCheck,
  Clock,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Input } from "@mcpjam/design-system/input";

export function matchesMember(
  member: { email: string; user?: { name?: string | null } | null },
  query: string,
  role: string,
  filter: string,
) {
  return (
    (filter === "all" || filter === role) &&
    `${member.user?.name ?? ""} ${member.email}`
      .toLowerCase()
      .includes(query.trim().toLowerCase())
  );
}

export function MemberSearch({
  query,
  onQueryChange,
  role,
  onRoleChange,
  roles,
  actions,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  role: string;
  onRoleChange: (value: string) => void;
  roles: readonly string[];
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-40 flex-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground"
        />
        <Input
          aria-label="Search members"
          placeholder="Search name or email"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className="pl-9 text-accent-foreground"
        />
      </div>
      <Select value={role} onValueChange={onRoleChange}>
        <SelectTrigger
          aria-label="Filter members by role"
          className="w-auto min-w-36"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">
            <span className="flex items-center gap-2">
              <SlidersHorizontal aria-hidden="true" className="size-4" />
              All roles
            </span>
          </SelectItem>
          {roles.map((value) => {
            const Icon =
              value === "owner"
                ? Crown
                : value === "admin"
                  ? Shield
                  : value === "pending"
                    ? Clock
                    : value === "guest"
                      ? UserRound
                      : UserRoundCheck;
            return (
              <SelectItem key={value} value={value}>
                <span className="flex items-center gap-2 capitalize">
                  <Icon aria-hidden="true" className="size-4" />
                  {value}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {actions}
    </div>
  );
}

export function MemberListHeader({
  activeCount,
  pendingCount = 0,
}: {
  activeCount?: number;
  pendingCount?: number;
} = {}) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-3 text-xs font-medium text-foreground">
      <span className="flex items-center gap-2">
        <UserRound aria-hidden="true" className="size-4" />
        User
        {activeCount !== undefined && (
          <span className="font-normal text-muted-foreground">
            ({activeCount} active
            {pendingCount > 0 ? ` · ${pendingCount} pending` : ""})
          </span>
        )}
      </span>
      <span className="flex items-center gap-2">
        <Shield aria-hidden="true" className="size-4" />
        Role & access
      </span>
    </div>
  );
}
