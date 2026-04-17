import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Building2, Globe, Search, Wand2 } from "lucide-react";
import { CHATBOX_STARTERS } from "./drafts";
import type { ChatboxStarterDefinition } from "./types";

const STARTER_ICONS = {
  "internal-qa": Building2,
  "icp-demo": Globe,
  blank: Wand2,
} as const;

interface ChatboxLauncherProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectStarter: (starter: ChatboxStarterDefinition) => void;
}

export function ChatboxLauncher({
  open,
  onOpenChange,
  onSelectStarter,
}: ChatboxLauncherProps) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create chatbox"
      description="Choose how you want to start the chatbox builder."
      className="max-w-2xl"
    >
      <div className="border-b border-border/70 bg-muted/20 px-5 py-5">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          New chatbox
        </p>
        <h2 className="mt-2 text-2xl font-semibold text-foreground">
          What would you like to create?
        </h2>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Start from an opinionated Railway-style chatbox layout, then refine
          the details in the builder.
        </p>
      </div>

      <CommandInput placeholder="Search starters..." />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>No starters match.</CommandEmpty>
        <CommandGroup heading="Recommended starters">
          {CHATBOX_STARTERS.map((starter) => {
            const Icon = STARTER_ICONS[starter.id] ?? Search;
            return (
              <CommandItem
                key={starter.id}
                value={`${starter.title} ${starter.description}`}
                onSelect={() => onSelectStarter(starter)}
                className="items-start gap-4 rounded-xl px-4 py-4"
              >
                <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-muted/40">
                  <Icon className="size-4.5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {starter.title}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {starter.description}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground/90">
                    {starter.promptHint}
                  </p>
                </div>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
