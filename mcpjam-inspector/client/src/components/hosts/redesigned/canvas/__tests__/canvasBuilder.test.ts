import { describe, expect, it } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/host-config-v2";
import { HOST_GROUP_NODE_ID } from "../../types";
import { buildRedesignedHostCanvas } from "../canvasBuilder";

describe("buildRedesignedHostCanvas", () => {
  it("stores only hostName on host-group canvas node data", () => {
    const draft = emptyHostConfigInputV2();
    const viewModel = buildRedesignedHostCanvas(
      {
        hostName: "My Host",
        draft,
        savedSnapshotId: "snap",
        isDirty: true,
        projectServers: [],
      },
      [],
    );
    const groupNode = viewModel.nodes.find((n) => n.id === HOST_GROUP_NODE_ID);
    expect(groupNode?.type).toBe("redesignHostGroup");
    expect(groupNode?.data).toEqual({
      kind: "host-group",
      hostName: "My Host",
    });
  });
});
