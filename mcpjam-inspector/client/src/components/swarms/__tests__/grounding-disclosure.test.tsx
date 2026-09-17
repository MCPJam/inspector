import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GroundingDisclosure } from "../grounding-disclosure";
import type { TargetGrounding } from "@/shared/swarm-grounding";
describe("grounding disclosure", () => {
  it("is absent for legacy runs", () => {
    const { container } = render(<GroundingDisclosure />);
    expect(container).toBeEmptyDOMElement();
  });
  it("discloses unavailable setup, retained entities and incomplete residue", () => {
    const entry: TargetGrounding = {
      targetId: "t",
      hostId: "h",
      status: "skipped",
      probedTools: [],
      capturedAt: 0,
      setup: {
        status: "completed",
        readiness: "unavailable",
        prefix: "swarm-test-",
        reason: "entity_record_limit",
        createdEntities: [
          {
            kind: "project",
            id: "real",
            name: "QA",
            serverId: "s",
            tool: "create_project",
            evidence: { callIndex: 0, objectPath: "$" },
            unprefixed: true,
          },
        ],
        observedCreatedEntityCount: 26,
        createdEntitiesTruncated: true,
        unsupportedClaims: 1,
        missing: [],
        toolCalls: [
          {
            serverId: "s",
            toolName: "create_project",
            ok: true,
            isWrite: true,
            dispatched: true,
          },
        ],
        writeCallsDispatched: 1,
        retried: false,
        admittedWriteTools: ["create_project"],
        excludedToolCount: 0,
        startedAt: 0,
        durationMs: 1,
        chatSessionId: "setup",
      },
    };
    render(<GroundingDisclosure entries={[entry]} />);
    expect(screen.getByText(/Prerequisites unavailable/)).toBeInTheDocument();
    expect(
      screen.getByText(/26 entities observed; showing 25; list incomplete/),
    ).toBeInTheDocument();
    expect(screen.getByText(/QA.*real.*unprefixed/)).toBeInTheDocument();
    expect(
      screen.getByText(/Created data is not cleaned up/),
    ).toBeInTheDocument();
  });
});
