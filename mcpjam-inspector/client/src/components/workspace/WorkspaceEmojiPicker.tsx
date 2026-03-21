import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  X,
  Rocket,
  Zap,
  Lightbulb,
  Target,
  BarChart3,
  Wrench,
  Globe,
  Lock,
  Server,
  Code2,
  Bot,
  FlaskConical,
  GitBranch,
  FolderOpen,
  BookOpen,
  Layers,
  FileCode,
  Users,
  MessageSquare,
  Sparkles,
  Star,
  Heart,
  Shield,
  Crown,
  Flame,
  Hexagon,
  Atom,
  Moon,
  Mountain,
  Gem,
  Compass,
  Trophy,
  Palette,
  Music,
  Camera,
  Briefcase,
  type LucideIcon,
} from "lucide-react";

interface WorkspaceIconPickerProps {
  currentIcon?: string;
  workspaceName: string;
  onSelect: (iconName: string) => void;
  onRemove: () => void;
  size?: "sm" | "lg";
}

const ICONS: { name: string; icon: LucideIcon }[] = [
  { name: "Rocket", icon: Rocket },
  { name: "Zap", icon: Zap },
  { name: "Lightbulb", icon: Lightbulb },
  { name: "Target", icon: Target },
  { name: "Flame", icon: Flame },
  { name: "Sparkles", icon: Sparkles },
  { name: "Star", icon: Star },
  { name: "Crown", icon: Crown },
  { name: "Code2", icon: Code2 },
  { name: "Server", icon: Server },
  { name: "Globe", icon: Globe },
  { name: "GitBranch", icon: GitBranch },
  { name: "Bot", icon: Bot },
  { name: "FlaskConical", icon: FlaskConical },
  { name: "Atom", icon: Atom },
  { name: "Lock", icon: Lock },
  { name: "BarChart3", icon: BarChart3 },
  { name: "Briefcase", icon: Briefcase },
  { name: "Wrench", icon: Wrench },
  { name: "Users", icon: Users },
  { name: "MessageSquare", icon: MessageSquare },
  { name: "Layers", icon: Layers },
  { name: "FolderOpen", icon: FolderOpen },
  { name: "FileCode", icon: FileCode },
  { name: "BookOpen", icon: BookOpen },
  { name: "Shield", icon: Shield },
  { name: "Heart", icon: Heart },
  { name: "Hexagon", icon: Hexagon },
  { name: "Moon", icon: Moon },
  { name: "Mountain", icon: Mountain },
  { name: "Gem", icon: Gem },
  { name: "Compass", icon: Compass },
  { name: "Trophy", icon: Trophy },
  { name: "Palette", icon: Palette },
  { name: "Music", icon: Music },
  { name: "Camera", icon: Camera },
];

const ICON_MAP: Record<string, LucideIcon> = Object.fromEntries(
  ICONS.map((i) => [i.name, i.icon]),
);

export function resolveWorkspaceIcon(iconName: string): LucideIcon | null {
  return ICON_MAP[iconName] ?? null;
}

export function WorkspaceIconPicker({
  currentIcon,
  workspaceName,
  onSelect,
  onRemove,
  size = "lg",
}: WorkspaceIconPickerProps) {
  const [open, setOpen] = useState(false);
  const initial = workspaceName.charAt(0).toUpperCase() || "W";
  const hasIcon = currentIcon && currentIcon !== "";
  const CurrentIconComponent = hasIcon
    ? resolveWorkspaceIcon(currentIcon)
    : null;

  const isLarge = size === "lg";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={`
            relative group shrink-0 rounded-2xl flex items-center justify-center
            bg-primary/10 text-primary cursor-pointer
            transition-all hover:bg-primary/15
            ${isLarge ? "h-24 w-24" : "h-8 w-8"}
          `}
        >
          {CurrentIconComponent ? (
            <CurrentIconComponent
              className={isLarge ? "h-12 w-12" : "h-4 w-4"}
              strokeWidth={1.5}
            />
          ) : (
            <span
              className={
                isLarge ? "text-5xl font-light" : "text-sm font-semibold"
              }
            >
              {initial}
            </span>
          )}
          <div
            className={`
              absolute inset-0 rounded-2xl bg-black/5 dark:bg-white/5
              opacity-0 group-hover:opacity-100 transition-opacity
              flex items-center justify-center
            `}
          >
            <span
              className={`text-muted-foreground ${isLarge ? "text-xs" : "text-[8px]"}`}
            >
              {hasIcon ? "Change" : "Add icon"}
            </span>
          </div>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-2" align="start">
        <div className="space-y-1">
          {hasIcon && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground gap-2 h-7 text-xs"
              onClick={() => {
                onRemove();
                setOpen(false);
              }}
            >
              <X className="h-3 w-3" />
              Remove
            </Button>
          )}
          <div className="grid grid-cols-9 gap-0.5">
            {ICONS.map(({ name, icon: Icon }) => (
              <button
                key={name}
                className={`
                  h-8 w-8 rounded-md flex items-center justify-center
                  hover:bg-accent transition-colors cursor-pointer
                  ${currentIcon === name ? "bg-accent ring-1 ring-primary/30" : ""}
                `}
                onClick={() => {
                  onSelect(name);
                  setOpen(false);
                }}
                title={name}
              >
                <Icon className="h-4 w-4" strokeWidth={1.5} />
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
