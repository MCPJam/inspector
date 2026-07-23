import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { launchMock } = vi.hoisted(() => ({ launchMock: vi.fn() }));
vi.mock("@/lib/mcpjam-agent/launch-lesson", () => ({
  launchLessonSession: launchMock,
}));

vi.mock("@/hooks/use-learning-progress", () => ({
  useLearningProgress: () => ({
    isCompleted: () => false,
    markComplete: vi.fn(),
    toggleComplete: vi.fn(),
    completionCount: 0,
  }),
}));

import { LearningTab } from "@/components/LearningTab";
import { GUIDED_TOURS } from "@/components/lifecycle/guided-tour-lessons";
import { LEARNING_CONCEPTS } from "@/components/lifecycle/learning-concepts";

const LANDING_MARKER = "Learn MCP step by step";

describe("LearningTab — guided tour dispatch", () => {
  it("launches the agent for a guided row and keeps the landing page mounted", () => {
    render(<LearningTab projectId="proj-1" />);
    fireEvent.click(screen.getByText("Guided tours"));
    fireEvent.click(screen.getByText("Create and run an eval suite"));

    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledWith({
      tour: expect.objectContaining({ id: "tour-eval-suite" }),
      projectId: "proj-1",
    });
    // Landing stays — guided tours never route to an in-tab shell.
    expect(screen.getByText(LANDING_MARKER)).toBeInTheDocument();
  });

  it("routes a reading module to its article shell (no agent launch)", () => {
    render(<LearningTab projectId="proj-1" />);
    // "Getting Started" is auto-open at 0 completions.
    fireEvent.click(screen.getByText("Why MCP?"));

    expect(launchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(LANDING_MARKER)).not.toBeInTheDocument();
  });
});

describe("guided tour content invariants", () => {
  it("every tour is a guided module with a usable system prompt", () => {
    expect(GUIDED_TOURS.length).toBeGreaterThan(0);
    for (const tour of GUIDED_TOURS) {
      expect(tour.kind).toBe("guided");
      expect(tour.agentSystemPrompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("every tour prompt encodes the never-submit and mark-complete rules", () => {
    for (const tour of GUIDED_TOURS) {
      const prompt = tour.agentSystemPrompt.toLowerCase();
      // never click the final submit for the user
      expect(prompt).toContain("never click the final");
      // close by pointing back to the Learning tab
      expect(prompt).toContain("complete");
    }
  });

  it("every tour prompt encodes the one-step-per-turn pacing gate", () => {
    for (const tour of GUIDED_TOURS) {
      const prompt = tour.agentSystemPrompt.toLowerCase();
      expect(prompt).toContain("one numbered step per turn");
      expect(prompt).toContain("never continue to the next numbered step");
    }
  });

  it("tour ids are unique across all learning modules", () => {
    const ids = LEARNING_CONCEPTS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
