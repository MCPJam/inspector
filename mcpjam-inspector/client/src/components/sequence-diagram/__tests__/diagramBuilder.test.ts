import { describe, it, expect } from "vitest";
import { buildNodesAndEdges } from "../diagramBuilder";
import type {
  SequenceDiagramActorConfig,
  SequenceDiagramAction,
} from "../types";

// --- Test fixtures ---

const twoActors: SequenceDiagramActorConfig[] = [
  { id: "client", label: "Client", color: "#10b981" },
  { id: "server", label: "Server", color: "#f59e0b" },
];

const threeActors: SequenceDiagramActorConfig[] = [
  ...twoActors,
  { id: "process", label: "Process", color: "#8b5cf6" },
];

const fourActors: SequenceDiagramActorConfig[] = [
  { id: "browser", label: "Browser", color: "#8b5cf6" },
  { id: "client", label: "Client", color: "#10b981" },
  { id: "mcpServer", label: "MCP Server", color: "#f59e0b" },
  { id: "authServer", label: "Auth Server", color: "#3b82f6" },
];

const twoActions: SequenceDiagramAction[] = [
  {
    id: "step1",
    label: "Request",
    description: "A request",
    from: "client",
    to: "server",
  },
  {
    id: "step2",
    label: "Response",
    description: "A response",
    from: "server",
    to: "client",
  },
];

const threeActorActions: SequenceDiagramAction[] = [
  {
    id: "step1",
    label: "Request",
    description: "A request",
    from: "client",
    to: "server",
  },
  {
    id: "step2",
    label: "Response",
    description: "A response",
    from: "server",
    to: "client",
  },
  {
    id: "step3",
    label: "Close",
    description: "Close",
    from: "client",
    to: "process",
  },
];

const twoActorPositions = { client: 100, server: 350 };
const threeActorPositions = { client: 100, server: 350, process: 600 };
const fourActorPositions = {
  browser: 100,
  client: 350,
  mcpServer: 650,
  authServer: 950,
};

// --- Tests ---

describe("buildNodesAndEdges", () => {
  describe("actor node generation", () => {
    it("creates one actor node per actor (2 actors)", () => {
      const { nodes } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        actorXPositions: twoActorPositions,
      });
      const actorNodes = nodes.filter((n) => n.type === "actor");
      expect(actorNodes).toHaveLength(2);
      expect(actorNodes.map((n) => n.id)).toEqual([
        "actor-client",
        "actor-server",
      ]);
    });

    it("creates one actor node per actor (3 actors)", () => {
      const { nodes } = buildNodesAndEdges({
        actors: threeActors,
        actions: threeActorActions,
        actorXPositions: threeActorPositions,
      });
      const actorNodes = nodes.filter((n) => n.type === "actor");
      expect(actorNodes).toHaveLength(3);
    });

    it("creates one actor node per actor (4 actors)", () => {
      const { nodes } = buildNodesAndEdges({
        actors: fourActors,
        actions: twoActions,
        actorXPositions: fourActorPositions,
      });
      const actorNodes = nodes.filter((n) => n.type === "actor");
      expect(actorNodes).toHaveLength(4);
    });

    it("assigns correct x-positions from actorXPositions", () => {
      const { nodes } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        actorXPositions: twoActorPositions,
      });
      const clientNode = nodes.find((n) => n.id === "actor-client");
      const serverNode = nodes.find((n) => n.id === "actor-server");
      expect(clientNode?.position.x).toBe(100);
      expect(serverNode?.position.x).toBe(350);
    });

    it("all actor nodes are non-draggable", () => {
      const { nodes } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        actorXPositions: twoActorPositions,
      });
      for (const node of nodes) {
        expect(node.draggable).toBe(false);
      }
    });
  });

  describe("segment generation", () => {
    it("generates segments for each actor", () => {
      const { nodes } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        actorXPositions: twoActorPositions,
      });
      for (const node of nodes) {
        const data = node.data as any;
        expect(data.segments).toBeDefined();
        expect(data.segments.length).toBeGreaterThan(0);
      }
    });

    it("creates box segments for actors involved in an action", () => {
      const { nodes } = buildNodesAndEdges({
        actors: threeActors,
        actions: threeActorActions,
        actorXPositions: threeActorPositions,
      });

      // step3 goes client -> process, so server should have line segments at that position
      const processNode = nodes.find((n) => n.id === "actor-process");
      const processData = processNode?.data as any;
      const boxSegments = processData.segments.filter(
        (s: any) => s.type === "box",
      );
      // process is only involved in step3
      expect(boxSegments).toHaveLength(1);
      expect(boxSegments[0].handleId).toBe("step3");
    });
  });

  describe("neutral status when currentStep is undefined", () => {
    it("all edges get 'neutral' status", () => {
      const { edges } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        actorXPositions: twoActorPositions,
        // no currentStep
      });

      for (const edge of edges) {
        expect(edge.data?.status).toBe("neutral");
      }
    });

    it("neutral edges have full opacity (not 0.4 like pending)", () => {
      const { edges } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        actorXPositions: twoActorPositions,
      });

      for (const edge of edges) {
        expect(edge.style?.opacity).toBe(1);
      }
    });

    it("neutral edges use slate-400 color (#94a3b8)", () => {
      const { edges } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        actorXPositions: twoActorPositions,
      });

      for (const edge of edges) {
        expect(edge.style?.stroke).toBe("#94a3b8");
      }
    });

    it("neutral edges are not animated", () => {
      const { edges } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        actorXPositions: twoActorPositions,
      });

      for (const edge of edges) {
        expect(edge.animated).toBeFalsy();
      }
    });
  });

  describe("edge routing for left-to-right and right-to-left", () => {
    it("uses right-source/left-target handles for left-to-right edges", () => {
      const { edges } = buildNodesAndEdges({
        actors: twoActors,
        actions: [twoActions[0]], // client(100) -> server(350)
        currentStep: "step1",
        actorXPositions: twoActorPositions,
      });

      const edge = edges[0];
      expect(edge.sourceHandle).toBe("step1-right-source");
      expect(edge.targetHandle).toBe("step1-left-target");
    });

    it("uses left-source/right-target handles for right-to-left edges", () => {
      const { edges } = buildNodesAndEdges({
        actors: twoActors,
        actions: [twoActions[1]], // server(350) -> client(100)
        currentStep: "step2",
        actorXPositions: twoActorPositions,
      });

      const edge = edges[0];
      expect(edge.sourceHandle).toBe("step2-left-source");
      expect(edge.targetHandle).toBe("step2-right-target");
    });
  });

  describe("stepped mode (currentStep provided)", () => {
    it("marks completed steps as 'complete'", () => {
      const { edges } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        currentStep: "step1",
        actorXPositions: twoActorPositions,
      });

      const step1Edge = edges.find((e) => e.data?.stepId === "step1");
      expect(step1Edge?.data?.status).toBe("complete");
    });

    it("marks next step as 'current'", () => {
      const { edges } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        currentStep: "step1",
        actorXPositions: twoActorPositions,
      });

      const step2Edge = edges.find((e) => e.data?.stepId === "step2");
      expect(step2Edge?.data?.status).toBe("current");
    });

    it("marks future steps as 'pending'", () => {
      const actions: SequenceDiagramAction[] = [
        ...twoActions,
        {
          id: "step3",
          label: "Extra",
          description: "Extra",
          from: "client",
          to: "server",
        },
      ];
      const { edges } = buildNodesAndEdges({
        actors: twoActors,
        actions,
        currentStep: "step1",
        actorXPositions: twoActorPositions,
      });

      const step3Edge = edges.find((e) => e.data?.stepId === "step3");
      expect(step3Edge?.data?.status).toBe("pending");
    });
  });

  describe("edge count", () => {
    it("creates one edge per action", () => {
      const { edges } = buildNodesAndEdges({
        actors: twoActors,
        actions: twoActions,
        actorXPositions: twoActorPositions,
      });
      expect(edges).toHaveLength(2);
    });
  });
});
