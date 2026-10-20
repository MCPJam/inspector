import { afterEach, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { PlaygroundAuthChallengeCards } from "../PlaygroundAuthChallengeCards";
vi.mock("@/state/app-state-context", () => ({ useOptionalSharedAppState: () => null }));
vi.mock("../AuthChallengeCard", () => ({ AuthChallengeCardsForSurface: () => null }));
afterEach(() => useUIPlaygroundStore.getState().reset());
it("shows a failed retry even when no sign-in card remains", () => {
  useUIPlaygroundStore.getState().setExecutionError("Server refused the retry");
  render(<PlaygroundAuthChallengeCards />);
  expect(screen.getByRole("alert").textContent).toBe("Server refused the retry");
  act(() => useUIPlaygroundStore.getState().setSelectedTool("other"));
  expect(screen.queryByRole("alert")).toBeNull();
});
