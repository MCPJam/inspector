import { useEffect, useRef } from "react";
import { Gem, Mail, UserPlus, type LucideIcon } from "lucide-react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { track } from "@/lib/analytics";

/** Which ask the footer card is making; also the `prompt` analytics property. */
export type SidebarPromptKind = "guest_signup" | "pro_upgrade" | "owner_request";

const PROMPT_COPY: Record<
  SidebarPromptKind,
  { title: string; description: string; icon: LucideIcon }
> = {
  guest_signup: {
    title: "Create a free account",
    description: "200 credits a day, all features",
    icon: UserPlus,
  },
  pro_upgrade: {
    title: "Upgrade to Pro",
    description: "Credits roll over, top up anytime",
    icon: Gem,
  },
  owner_request: {
    title: "Ask an owner to upgrade",
    description: "Credits roll over, top up anytime",
    icon: Mail,
  },
};

export function sidebarPromptPage(): string {
  return `${window.location.pathname}${window.location.hash}`;
}

/** One impression per mount and prompt, so a re-render never double counts. */
export function useSidebarPromptShown(
  kind: SidebarPromptKind | null,
  organizationId: string | null,
) {
  const trackedRef = useRef<SidebarPromptKind | null>(null);
  useEffect(() => {
    if (!kind || trackedRef.current === kind) return;
    trackedRef.current = kind;
    track("sidebar_prompt_shown", {
      location: "sidebar_prompt",
      prompt: kind,
      organization_id: organizationId,
      page: sidebarPromptPage(),
    });
  }, [kind, organizationId]);
}

export function SidebarPromptCard({
  kind,
  onClick,
  disabled,
}: {
  kind: SidebarPromptKind;
  onClick: () => void;
  disabled?: boolean;
}) {
  const { title, description, icon: Icon } = PROMPT_COPY[kind];
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          tooltip={title}
          disabled={disabled}
          onClick={onClick}
          data-testid={`sidebar-prompt-${kind}`}
          className="h-auto gap-3 rounded-lg border border-border bg-card py-2 text-card-foreground hover:bg-accent hover:text-accent-foreground group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:bg-transparent"
        >
          <span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate text-sm font-medium">{title}</span>
            <span className="truncate text-xs text-muted-foreground">
              {description}
            </span>
          </span>
          <Icon className="size-4 shrink-0 text-muted-foreground" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
