import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createServer } from "@/test/factories";
import { AuthChallengeCard } from "../AuthChallengeCard";
import type { AuthChallengeCard as Card } from "@/lib/auth-challenge-lifecycle";

const connect = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-challenge-lifecycle", () => ({
  connectAuthChallenge: connect,
  dismissAuthChallenge: vi.fn(),
  useAuthChallengeCards: () => [],
}));

it("keeps an early Connect click local and allows retry after restoration", async () => {
  const card: Card = {
    key: "call", serverName: "bench", serverOrigin: "https://bench.example", surface: "chat",
    operation: { method: "tools/call", operation: "bench_read" },
    signal: { source: "http_401", effectiveAuth: "discover", facets: {
      challengeHeader: "bearer", hasResourceMetadata: true, hasScope: true, hasErrorParams: false,
    } },
    action: "prompt", readOnly: true, explanation: "", expiresAt: Date.now() + 60_000,
  };
  const onResult = vi.fn();
  connect.mockResolvedValueOnce({ kind: "waiting", message: "Chats are still restoring. Please try Connect again in a moment." })
    .mockResolvedValueOnce({ kind: "started" });
  render(<AuthChallengeCard card={card} server={createServer({ name: "bench" })} onResult={onResult} />);
  fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
  expect(await screen.findByRole("status")).toHaveTextContent("Chats are still restoring");
  expect(onResult).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith({ kind: "started" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
