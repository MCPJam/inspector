import { describe, expect, it } from "vitest";
import { TaskOwnerRequests } from "../task-owner-requests";

describe("Task request ownership", () => {
  it("preserves owners across overlapping requests and reversed responses", () => {
    const requests = new TaskOwnerRequests();
    requests.capture("first", "owner-a");
    requests.capture("second", "owner-b");
    expect(requests.resolve("second")).toBe("owner-b");
    expect(requests.resolve("first")).toBe("owner-a");
  });
  it("never fills missing or reused request ownership from a later actor", () => {
    const requests = new TaskOwnerRequests();
    expect(requests.capture("missing", undefined)).toBeUndefined();
    requests.capture("known", "owner-a");
    expect(requests.capture("known", "owner-b")).toBeUndefined();
    expect(requests.resolve("known")).toBe("owner-a");
    expect(requests.resolve("missing")).toBeUndefined();
  });
  it("bounds request history and refuses expired correlations", () => {
    const requests = new TaskOwnerRequests();
    for (let i = 0; i < 129; i++) requests.capture(String(i), `owner-${i}`);
    expect(requests.resolve("0")).toBeUndefined();
    expect(requests.resolve("128")).toBe("owner-128");
  });
});
