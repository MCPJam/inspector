import { useOptionalSharedAppState } from "@/state/app-state-context";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { AuthChallengeCardsForSurface } from "./AuthChallengeCard";

/** The Playground tools rail's sign-in cards, for whichever server asked. */
export function PlaygroundAuthChallengeCards() {
  const appState = useOptionalSharedAppState();
  const error = useUIPlaygroundStore((state) => state.executionError);
  return (
    <>
    <AuthChallengeCardsForSurface
      surface="playground"
      resolveServer={(serverName) => appState?.servers[serverName]}
      className="border-b border-border p-3"
    />
    {error && <p role="alert" className="border-b border-border p-3 text-sm text-destructive">{error}</p>}
    </>
  );
}
