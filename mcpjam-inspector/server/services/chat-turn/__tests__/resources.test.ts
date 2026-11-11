import { describe, expect, it, vi } from "vitest";
import { TurnResources } from "../resources.js";

describe("turn resource ownership", () => {
  it("releases all owned resources once even when one release fails", async () => {
    const failed = vi.fn();
    const order: string[] = [];
    const owner = new TurnResources(failed);
    owner.own(() => {
      order.push("manager");
    });
    owner.own(() => {
      order.push("elicitation");
      throw new Error("unavailable");
    });
    await Promise.all([owner.dispose(), owner.dispose()]);
    expect(order).toEqual(["elicitation", "manager"]);
    expect(failed).toHaveBeenCalledOnce();
    expect(() => owner.own(() => undefined)).toThrow("turn ended");
  });

  it("holds resources until the streamed response completes", async () => {
    const release = vi.fn();
    const owner = new TurnResources(vi.fn());
    owner.own(release);
    const response = owner.response(
      new Response("answer", {
        status: 201,
        headers: { "x-turn": "one" },
      }),
    );
    expect(release).not.toHaveBeenCalled();
    expect(await response.text()).toBe("answer");
    expect(response.status).toBe(201);
    expect(response.headers.get("x-turn")).toBe("one");
    expect(release).toHaveBeenCalledOnce();
  });

  it("cleans up on cancellation without touching a concurrent turn", async () => {
    const releaseA = vi.fn();
    const releaseB = vi.fn();
    const cancel = vi.fn();
    const ownerA = new TurnResources(vi.fn());
    const ownerB = new TurnResources(vi.fn());
    ownerA.own(releaseA);
    ownerB.own(releaseB);
    const response = ownerA.response(
      new Response(new ReadableStream({ cancel })),
    );
    await response.body!.cancel("stopped");
    expect(cancel).toHaveBeenCalledWith("stopped");
    expect(releaseA).toHaveBeenCalledOnce();
    expect(releaseB).not.toHaveBeenCalled();
    await ownerB.dispose();
  });

  it("cleans up when a body fails and preserves the stream error", async () => {
    const release = vi.fn();
    const owner = new TurnResources(vi.fn());
    owner.own(release);
    const error = new Error("replica lost");
    const response = owner.response(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(error);
          },
        }),
      ),
    );
    await expect(response.text()).rejects.toThrow("replica lost");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases on request abort even if the consumer stops reading", async () => {
    const release = vi.fn();
    const owner = new TurnResources(vi.fn());
    owner.own(release);
    const abort = new AbortController();
    const response = owner.response(
      new Response(new ReadableStream()),
      abort.signal,
    );
    abort.abort();
    await owner.dispose();
    expect(release).toHaveBeenCalledOnce();
    await response.body!.cancel();
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases immediately for a pre-stream refusal", async () => {
    const release = vi.fn();
    const owner = new TurnResources(vi.fn());
    owner.own(release);
    owner.response(new Response(null, { status: 204 }));
    await owner.dispose();
    expect(release).toHaveBeenCalledOnce();
  });
});
