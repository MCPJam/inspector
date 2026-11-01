import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createServer } from "@/test/factories";
import {
  AuthChallengeCard,
  authChallengeConnectMessage,
} from "../AuthChallengeCard";
import type { AuthChallengeCard as Card } from "@/lib/auth-challenge-lifecycle";

const connect = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-challenge-lifecycle", () => ({
  AUTH_CHALLENGE_PERMANENT_MESSAGE: "The shared permanent notice.",
  connectAuthChallenge: connect,
  dismissAuthChallenge: vi.fn(),
  useAuthChallengeCards: () => [],
}));

it.each([true, false])("keeps Connect retryable without an extra approval promise (readOnly=%s)", async (readOnly) => {
  const card: Card = {
    key: "call", serverName: "bench", serverOrigin: "https://bench.example", surface: "chat",
    operation: { method: "tools/call", operation: "bench_read" },
    signal: { source: "http_401", effectiveAuth: "discover", facets: {
      challengeHeader: "bearer", hasResourceMetadata: true, hasScope: true, hasErrorParams: false,
    } },
    action: "prompt", readOnly, explanation: "", expiresAt: Date.now() + 60_000,
  };
  const onResult = vi.fn();
  connect.mockResolvedValueOnce({ kind: "waiting", message: "Chats are still restoring. Please try Connect again in a moment." })
    .mockResolvedValueOnce({ kind: "started" });
  render(<AuthChallengeCard card={card} server={createServer({ name: "bench" })} onResult={onResult} />);
  expect(screen.getByText(/It runs again after you sign in/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
  expect(await screen.findByRole("status")).toHaveTextContent("Chats are still restoring");
  expect(onResult).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Connect", exact: true }));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith({ kind: "started" }));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("reports a repeated challenge with the same notice as the call surfaces", () => {
  expect(authChallengeConnectMessage({ kind: "permanent" })).toBe(
    "The shared permanent notice.",
  );
});

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    key: "call",
    serverName: "bench",
    serverOrigin: "https://bench.example",
    surface: "chat",
    operation: { method: "tools/call", operation: "bench_read" },
    signal: {
      source: "http_401",
      effectiveAuth: "discover",
      requiredScope: "bench:read",
      facets: {
        challengeHeader: "bearer",
        hasResourceMetadata: true,
        hasScope: true,
        hasErrorParams: false,
      },
    },
    action: "prompt",
    readOnly: true,
    explanation: "The host prompts.",
    expiresAt: Date.now() + 60_000,
    attempt: {
      projectId: "local",
      serverId: "bench",
      surface: "chat",
      callId: "call",
    },
    ...overrides,
  };
}

it("stops counting down once the card has expired", () => {
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  try {
    render(
      <AuthChallengeCard
        card={makeCard({ expiresAt: Date.now() - 1 })}
        server={createServer({ name: "bench" })}
      />,
    );
    expect(screen.getByText(/This call expired/)).toBeInTheDocument();
    // The countdown's one-second tick; jsdom's requestAnimationFrame also
    // runs on setInterval.
    expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 1000)).toBe(
      false,
    );
  } finally {
    setIntervalSpy.mockRestore();
  }
});

it("discloses the challenge details from the Details control", () => {
  render(
    <AuthChallengeCard
      card={makeCard()}
      server={createServer({ name: "bench" })}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Details" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const details = screen.getByTestId("auth-challenge-details");
  expect(
    document.getElementById(trigger.getAttribute("aria-controls") ?? ""),
  ).toContainElement(details);
  expect(screen.getByTestId("auth-challenge-details")).toHaveTextContent(
    "bench:read",
  );
});
