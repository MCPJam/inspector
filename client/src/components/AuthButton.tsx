import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@/components/ui/button";

export function AuthButton() {
  const { user, isAuthenticated, signIn, signOut, isLoading } = useAuth();

  if (isLoading) {
    return (
      <Button variant="outline" size="sm" disabled>
        Loading...
      </Button>
    );
  }

  if (!isAuthenticated) {
    return (
      <Button variant="outline" size="sm" onClick={() => signIn()}>
        Sign in
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground max-w-[160px] truncate">
        {user?.email || user?.id}
      </span>
      <Button variant="outline" size="sm" onClick={() => signOut()}>
        Sign out
      </Button>
    </div>
  );
}

