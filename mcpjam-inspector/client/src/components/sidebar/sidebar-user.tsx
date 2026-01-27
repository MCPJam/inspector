import { useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { getInitials } from "@/lib/utils";
import {
  Building2,
  ChevronsUpDown,
  CircleUser,
  LogOut,
  Plus,
  RefreshCw,
  Settings,
  User,
} from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { CreateOrganizationDialog } from "@/components/organization/CreateOrganizationDialog";

export function SidebarUser() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { user, signIn, signOut, signUp } = useAuth();
  const posthog = usePostHog();
  const { profilePictureUrl } = useProfilePicture();
  const convexUser = useQuery("users:getCurrentUser" as any);
  const { isMobile } = useSidebar();

  const [showCreateOrgDialog, setShowCreateOrgDialog] = useState(false);

  const { sortedOrganizations } = useOrganizationQueries({
    isAuthenticated,
  });

  // Prefer convexUser name (can be edited) over WorkOS user name
  const workOsName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(" ")
    : "";
  const displayName = convexUser?.name || workOsName || "User";
  const email = user?.email ?? "";
  const initials = getInitials(displayName);

  const handleSignOut = () => {
    const isElectron = (window as any).isElectron;
    const returnTo =
      isElectron && import.meta.env.DEV
        ? "http://localhost:8080/callback"
        : window.location.origin;
    signOut({ returnTo });
  };

  const avatarUrl = profilePictureUrl;

  // Not logged in state
  if (!user) {
    if (isLoading) {
      return (
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" disabled>
              <RefreshCw className="size-4 animate-spin" />
              <span className="truncate group-data-[collapsible=icon]:hidden">
                Loading...
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      );
    }

    return (
      <SidebarMenu>
        <SidebarMenuItem className="flex flex-col gap-2 group-data-[collapsible=icon]:items-center">
          <Button
            variant="outline"
            size="sm"
            className="w-full group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:h-8 group-data-[collapsible=icon]:p-0"
            onClick={() => {
              posthog.capture("login_button_clicked", {
                location: "sidebar",
                platform: detectPlatform(),
                environment: detectEnvironment(),
              });
              signIn();
            }}
          >
            <span className="group-data-[collapsible=icon]:hidden">
              Sign in
            </span>
            <User className="hidden group-data-[collapsible=icon]:block size-4" />
          </Button>
          <Button
            size="sm"
            className="w-full group-data-[collapsible=icon]:hidden"
            onClick={() => {
              posthog.capture("sign_up_button_clicked", {
                location: "sidebar",
                platform: detectPlatform(),
                environment: detectEnvironment(),
              });
              signUp();
            }}
          >
            Create account
          </Button>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  // Loading state while authenticated
  if (isLoading) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton size="lg" disabled>
            <RefreshCw className="size-4 animate-spin" />
            <span className="truncate group-data-[collapsible=icon]:hidden">
              Loading...
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  // Logged in state with dropdown
  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              >
                <Avatar className="size-8 rounded-lg">
                  <AvatarImage src={avatarUrl} alt={displayName} />
                  <AvatarFallback className="rounded-lg bg-muted text-muted-foreground text-sm font-medium">
                    {initials !== "?" ? (
                      initials
                    ) : (
                      <CircleUser className="size-4" />
                    )}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="truncate font-semibold">{displayName}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {email}
                  </span>
                </div>
                <ChevronsUpDown className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
              side={isMobile ? "bottom" : "right"}
              align="end"
              sideOffset={4}
            >
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarImage src={avatarUrl} alt={displayName} />
                    <AvatarFallback className="rounded-lg bg-muted text-muted-foreground text-sm font-medium">
                      {initials !== "?" ? (
                        initials
                      ) : (
                        <CircleUser className="size-4" />
                      )}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">
                      {displayName}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {email}
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => (window.location.hash = "profile")}
                className="cursor-pointer"
              >
                <User className="size-4" />
                Profile
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => (window.location.hash = "settings")}
                className="cursor-pointer"
              >
                <Settings className="size-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* Organizations Section */}
              <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wider">
                Organizations
              </DropdownMenuLabel>
              {sortedOrganizations.length > 0 ? (
                sortedOrganizations.map((org) => (
                  <DropdownMenuItem
                    key={org._id}
                    onClick={() =>
                      (window.location.hash = `organizations/${org._id}`)
                    }
                    className="cursor-pointer"
                  >
                    <Avatar className="size-6 rounded">
                      <AvatarImage src={org.logoUrl} alt={org.name} />
                      <AvatarFallback className="rounded bg-primary/10 text-primary text-xs font-semibold">
                        {org.name.charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="flex-1 truncate">{org.name}</span>
                    <Settings
                      className="size-4 text-muted-foreground hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        window.location.hash = `organizations/${org._id}`;
                      }}
                    />
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem
                  onClick={() => setShowCreateOrgDialog(true)}
                  className="cursor-pointer text-muted-foreground"
                >
                  <Building2 className="size-4" />
                  No organizations yet
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={() => setShowCreateOrgDialog(true)}
                className="cursor-pointer"
              >
                <Plus className="size-4" />
                New organization
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={handleSignOut}
                className="cursor-pointer"
              >
                <LogOut className="size-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <CreateOrganizationDialog
        open={showCreateOrgDialog}
        onOpenChange={setShowCreateOrgDialog}
      />
    </>
  );
}
