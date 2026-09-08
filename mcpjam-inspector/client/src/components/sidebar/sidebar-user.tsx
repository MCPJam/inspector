import { useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useQuery } from "convex/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@mcpjam/design-system/avatar";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  markSignOutInProgress,
  SIGN_OUT_REQUEST_TIMEOUT_MS,
} from "@/lib/auth/sign-out-latch";
import { getInitials } from "@/lib/utils";
import {
  Bell,
  ChevronsUpDown,
  CircleUser,
  LogOut,
  MessageCircleQuestion,
  RefreshCw,
  Settings,
  User,
} from "lucide-react";
import { Popover, PopoverAnchor } from "@mcpjam/design-system/popover";
import { NotificationsPanelContent } from "@/components/notifications/NotificationsPanel";
import { useNotifications } from "@/hooks/useNotifications";
import { useProfilePicture } from "@/hooks/useProfilePicture";
import { useAppNavigate } from "@/lib/app-navigation";

interface SidebarUserProps {
  onBeforeSignOut?: () => void | Promise<void>;
}

export function SidebarUser({ onBeforeSignOut }: SidebarUserProps = {}) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { user, signOut, isLoading: isWorkOsAuthLoading } = useAuth();
  const { profilePictureUrl } = useProfilePicture();
  const convexUser = useQuery("users:getCurrentUser" as any);
  const { isMobile } = useSidebar();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  // Set when the Notifications item is selected so the dropdown's
  // close-auto-focus handler knows to open the popover instead of returning
  // focus to the shared trigger (which would immediately dismiss the popover).
  const openNotificationsOnCloseRef = useRef(false);
  const { unreadCount } = useNotifications({ isAuthenticated });
  const appNavigate = useAppNavigate();

  const workOsName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(" ")
    : "";
  const displayName = convexUser?.name || workOsName || "User";
  const email = user?.email ?? "";
  const initials = getInitials(displayName);

  const finishSignOut = () => {
    // Before `signOut()`, never after: authkit's refresh timer can fire on the
    // next tick, and an unlatched failure would redirect this tab to the login
    // page on top of the logout navigation below. See `sign-out-latch`.
    markSignOutInProgress();
    const returnTo = window.location.origin;
    if (window.isElectron) {
      // Bounded, because the latch above is. This promise settles when the
      // logout request does, and nothing else navigates this window, so a hung
      // request would outlive the suppression window and let the refresh timer
      // redirect to the hosted login page mid-logout. The response is opaque,
      // so there is nothing to lose by giving up on it and leaving anyway.
      void Promise.race([
        Promise.resolve(signOut({ returnTo, navigate: false })),
        new Promise((resolve) =>
          setTimeout(resolve, SIGN_OUT_REQUEST_TIMEOUT_MS)
        ),
      ])
        // A failed logout request still gets the navigation: the session is
        // already gone locally, and stranding the user on the signed-in app
        // would be a worse answer than leaving.
        .catch(() => undefined)
        .finally(() => {
          window.location.assign(returnTo);
        });
      return;
    }

    signOut({ returnTo });
  };

  const handleSignOut = () => {
    setMenuOpen(false);

    let cleanupResult: void | Promise<void>;
    try {
      cleanupResult = onBeforeSignOut?.();
    } catch {
      finishSignOut();
      return;
    }

    if (
      cleanupResult &&
      typeof (cleanupResult as Promise<void>).finally === "function"
    ) {
      void (cleanupResult as Promise<void>)
        .catch(() => undefined)
        .finally(finishSignOut);
      return;
    }

    finishSignOut();
  };

  const avatarUrl = profilePictureUrl;

  // `size="lg"` drops its icon-mode padding so a 32px avatar can fill the
  // button; the loading/guest branches hold a bare 16px icon instead, so they
  // must center it explicitly or it parks 8px left of the rail centerline.
  const loadingState = (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          disabled
          className="group-data-[collapsible=icon]:justify-center"
        >
          <RefreshCw className="size-4 animate-spin" />
          <span className="truncate group-data-[collapsible=icon]:hidden">
            Loading...
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );

  // While WorkOS/Convex are still resolving the session, `user` is null even for
  // signed-in users. Show the neutral loading state before the `!user` guest
  // branch so authenticated users don't flash the "Sign in" footer on load.
  // Applies in both modes: local/npx users can also sign in with WorkOS, so a
  // signed-in local user would otherwise flash "Sign in" while auth resolves.
  const authResolving = !user && (isWorkOsAuthLoading || isLoading);

  if (authResolving) {
    return loadingState;
  }

  // No WorkOS user → render nothing. Guests sign in from the header button and
  // the org switcher's sign-in chip; a third affordance in the sidebar footer is
  // redundant.
  if (!user) {
    return null;
  }

  if (isLoading) {
    return loadingState;
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <Popover open={notificationsOpen} onOpenChange={setNotificationsOpen}>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverAnchor asChild>
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
                    <span className="truncate font-semibold">
                      {displayName}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {email}
                    </span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4 group-data-[collapsible=icon]:hidden" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
            </PopoverAnchor>
            <DropdownMenuContent
              className="w-[--radix-dropdown-menu-trigger-width] min-w-72 rounded-lg"
              side={isMobile ? "bottom" : "right"}
              align="end"
              sideOffset={4}
              onCloseAutoFocus={(event) => {
                // When Notifications was selected, don't return focus to the
                // trigger — that focus move lands outside the notifications
                // popover and Radix would dismiss it as a focus-outside event.
                // Instead, swallow the focus-return and open the popover here,
                // once the menu has actually closed.
                if (openNotificationsOnCloseRef.current) {
                  openNotificationsOnCloseRef.current = false;
                  event.preventDefault();
                  setNotificationsOpen(true);
                }
              }}
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
                onClick={() => appNavigate("/profile")}
                className="cursor-pointer"
              >
                <User className="size-4" />
                Profile
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => appNavigate("/settings")}
                className="cursor-pointer"
              >
                <Settings className="size-4" />
                Settings
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  // Flag the intent, then let the menu close normally; the
                  // popover is opened from the dropdown's onCloseAutoFocus so
                  // the focus-return doesn't dismiss it. See the handler above.
                  openNotificationsOnCloseRef.current = true;
                }}
                className="cursor-pointer"
              >
                <Bell className="size-4" />
                Notifications
                {unreadCount > 0 ? (
                  <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-white">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                ) : null}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => appNavigate("/support")}
                className="cursor-pointer"
              >
                <MessageCircleQuestion className="size-4" />
                Support
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
          <NotificationsPanelContent
            side={isMobile ? "bottom" : "right"}
            align="end"
          />
        </Popover>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
