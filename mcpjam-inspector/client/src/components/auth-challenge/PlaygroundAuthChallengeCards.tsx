import { useOptionalSharedAppState } from "@/state/app-state-context";
import { AuthChallengeCardsForSurface } from "./AuthChallengeCard";

/** The Playground tools rail's sign-in cards, for whichever server asked. */
export function PlaygroundAuthChallengeCards() {
  const appState = useOptionalSharedAppState();
  return (
    <AuthChallengeCardsForSurface
      surface="playground"
      resolveServer={(serverName) => appState?.servers[serverName]}
      className="border-b border-border p-3"
    />
  );
}
