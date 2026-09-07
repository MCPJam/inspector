/**
 * The canvas the suite draws on.
 *
 * jsdom has no 2D context, so `setup.ts` supplies one. It is an ENVIRONMENT
 * shim, which means its failures do not look like failures: a component that
 * reads a state property gets whatever the shim decided to say, the test goes
 * green, and the thing it was meant to prove was never exercised. These pin
 * the two ways that has already happened.
 */
import { describe, expect, it } from "vitest";

const contextOf = () =>
  document.createElement("canvas").getContext("2d") as unknown as Record<
    string,
    unknown
  > | null;

describe("the jsdom 2D context", () => {
  it("is the same context for the same canvas", () => {
    // A component sets `fillStyle` once and paints later. A fresh object per
    // call would discard every assignment it ever made.
    const canvas = document.createElement("canvas");
    const first = canvas.getContext("2d");
    expect(canvas.getContext("2d")).toBe(first);
    expect(document.createElement("canvas").getContext("2d")).not.toBe(first);
  });

  it("reads back 2D state as state, not as a function", () => {
    const ctx = contextOf()!;
    // `ctx.globalAlpha * 0.5` was NaN, and silently: a shim that answers every
    // unknown member with a no-op function makes arithmetic on unset state
    // produce nonsense that no assertion in the component's own test can see.
    expect(ctx.globalAlpha).toBe(1);
    expect(ctx.globalCompositeOperation).toBe("source-over");
    expect(ctx.font).toBe("10px sans-serif");
    expect(ctx.lineWidth).toBe(1);
    expect(ctx.shadowBlur).toBe(0);
  });

  it("puts state back where `restore` says it was", () => {
    const ctx = contextOf()!;
    ctx.globalAlpha = 0.25;
    (ctx.save as () => void)();
    ctx.globalAlpha = 1;
    (ctx.restore as () => void)();
    expect(ctx.globalAlpha).toBe(0.25);
  });

  it("still answers every drawing call", () => {
    const ctx = contextOf()!;
    // The whole point of the shim: no component's paint path may fail on it.
    expect(() => {
      (ctx.setTransform as (...args: number[]) => void)(1, 0, 0, 1, 0, 0);
      (ctx.beginPath as () => void)();
      (ctx.arc as (...args: number[]) => void)(0, 0, 1, 0, Math.PI);
      (ctx.fill as () => void)();
      (ctx.clearRect as (...args: number[]) => void)(0, 0, 1, 1);
    }).not.toThrow();
    expect((ctx.measureText as (t: string) => { width: number })("x").width).toBe(
      0,
    );
  });

  it("is not a thenable, and does not claim members it has not got", async () => {
    const ctx = contextOf()!;
    // `then` answered with a no-op made the context a thenable: `await ctx`
    // handed that no-op the resolve callback, and the promise never settled.
    // A suite-wide hang, out of a shim that only meant to draw nothing.
    expect(ctx.then).toBeUndefined();
    expect("then" in ctx).toBe(false);
    const settled = await Promise.race([
      Promise.resolve(ctx),
      new Promise((resolve) => setTimeout(() => resolve("never settled"), 50)),
    ]);
    expect(settled).toBe(ctx);
    // And `'x' in ctx` is how a component asks what this engine supports.
    expect("noSuchCanvasMember" in ctx).toBe(false);
    expect("drawImage" in ctx).toBe(true);
  });

  it("hands out nothing at all for a context it cannot fake", () => {
    expect(document.createElement("canvas").getContext("webgl")).toBeNull();
  });
});
