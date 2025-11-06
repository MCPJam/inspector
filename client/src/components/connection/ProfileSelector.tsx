import { Check, ChevronDown, Settings, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Profile } from "@/state/app-types";

interface ProfileSelectorProps {
  activeProfileId: string;
  profiles: Record<string, Profile>;
  onSwitchProfile: (profileId: string) => void;
  onManageProfiles: () => void;
}

export function ProfileSelector({
  activeProfileId,
  profiles,
  onSwitchProfile,
  onManageProfiles,
}: ProfileSelectorProps) {
  const activeProfile = profiles[activeProfileId];
  const profileList = Object.values(profiles).sort((a, b) => {
    // Default profile first
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    // Then sort by name
    return a.name.localeCompare(b.name);
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-[200px] justify-start">
          <User className="mr-2 h-4 w-4" />
          <span className="truncate">{activeProfile?.name || "No Profile"}</span>
          <ChevronDown className="ml-auto h-4 w-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        {profileList.map((profile) => (
          <DropdownMenuItem
            key={profile.id}
            onClick={() => onSwitchProfile(profile.id)}
            className={cn(
              "cursor-pointer",
              profile.id === activeProfileId && "bg-accent"
            )}
          >
            <Check
              className={cn(
                "mr-2 h-4 w-4",
                profile.id === activeProfileId ? "opacity-100" : "opacity-0"
              )}
            />
            <span className="truncate flex-1">{profile.name}</span>
            {profile.isDefault && (
              <Badge variant="secondary" className="ml-2 text-xs">
                Default
              </Badge>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onManageProfiles} className="cursor-pointer">
          <Settings className="mr-2 h-4 w-4" />
          Manage Profiles
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
