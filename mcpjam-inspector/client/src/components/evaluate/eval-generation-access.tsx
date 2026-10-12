import type { PropsWithChildren } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { GuestSignInMessage } from "@/components/auth/GuestSignInMessage";
import { HOSTED_MODE } from "@/lib/config";

export function EvalGenerationAccess({ children }: PropsWithChildren) {
  return HOSTED_MODE ? (
    <HostedEvalGenerationAccess>{children}</HostedEvalGenerationAccess>
  ) : (
    children
  );
}

function HostedEvalGenerationAccess({ children }: PropsWithChildren) {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return <p role="status">Checking sign-in…</p>;
  }
  return user ? (
    children
  ) : (
    <GuestSignInMessage
      compact
      message="Sign in to generate test cases with AI. You can still add cases manually."
      location="eval_generate_cases"
    />
  );
}
