import { describe, expect, it } from "vitest";
import { taskAccountOptions } from "../task-account-options";

const task = {
  taskId: "same",
  serverId: "server",
  scope: "owner",
  wire: "extension" as const,
  connectionId: "b",
  createdAt: new Date().toISOString(),
};

describe("Task account choices", () => {
  it("keeps the current connection separate from pinned accounts", () => {
    const options = taskAccountOptions(
      "server",
      "owner",
      [
        { connectionId: "a", label: "A", isDefault: true },
        { connectionId: "b", label: "B", isDefault: false },
      ],
      [task],
    );
    expect(options[0].target).toBeUndefined();
    expect(
      options.find((option) => option.label === "B")?.target,
    ).toMatchObject({ connectionId: "b", scope: "owner", wire: "extension" });
  });
  it("retains disconnected account handles instead of switching them to default", () => {
    const options = taskAccountOptions("server", "owner", [], [task]);
    expect(
      options.find((option) => option.target?.connectionId === "b")?.label,
    ).toContain("Saved account");
  });
  it("offers recovery for account-free tasks when the browser has no bookmarks", () => {
    expect(
      taskAccountOptions("server", "owner", [], []).find(
        (option) => option.label === "Saved tasks",
      )?.target,
    ).toMatchObject({ serverId: "server", scope: "owner" });
  });
});
