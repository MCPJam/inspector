import type { ReactNode } from "react";
import { useSignOutStore } from "@/stores/sign-out-store";
import LoadingScreen from "./LoadingScreen";

export function SignOutBoundary({ children }: { children: ReactNode }) {
  const isSigningOut = useSignOutStore((state) => state.isSigningOut);
  return isSigningOut ? <LoadingScreen /> : children;
}
