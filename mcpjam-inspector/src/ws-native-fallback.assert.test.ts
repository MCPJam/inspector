import { describe, it, expect } from "vitest";
import { resolve } from "path";
import {
  assertWsNativeFallback,
  type ReadFsBits,
} from "./ws-native-fallback.assert";

const STUB = "const __viteOptionalPeerDep_bufferutil_ws_true = {};";
/** `ws/lib/buffer-util.js`'s own gate. Present in every bundle carrying `ws`. */
const WS_OWN_READ = "if (!process.env.WS_NO_BUFFER_UTIL) try { require(...) }";
const FIX = 'process.env.WS_NO_BUFFER_UTIL="1";';

const BUILD = resolve("/build");

/** An in-memory tree: path -> file contents. Directories are inferred. */
function fakeFs(
  files: Record<string, string>,
  overrides: Partial<ReadFsBits> = {},
): ReadFsBits {
  const paths = Object.keys(files).map((p) => resolve(p));
  const isDir = (p: string) => paths.some((f) => f.startsWith(p + "/"));

  return {
    existsSync: (p) => isDir(p) || paths.includes(resolve(p)),
    readdirSync: (p) => {
      const prefix = resolve(p) + "/";
      const names = new Set<string>();
      for (const f of paths) {
        if (!f.startsWith(prefix)) continue;
        names.add(f.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
    statSync: (p) => ({ isDirectory: () => isDir(resolve(p)) }),
    readFileSync: (p) => files[resolve(p)] ?? "",
    ...overrides,
  };
}

describe("assertWsNativeFallback", () => {
  it("passes when the build directory does not exist", () => {
    expect(() => assertWsNativeFallback(BUILD, fakeFs({}))).not.toThrow();
  });

  it("passes when no stub is bundled, even with no assignment anywhere", () => {
    // The assertion is "fix present IF stub present" — a bundle Vite never
    // stubbed needs no fix, and demanding one would fail honest builds.
    const fs = fakeFs({ "/build/main.cjs": WS_OWN_READ });
    expect(() => assertWsNativeFallback(BUILD, fs)).not.toThrow();
  });

  it("passes when the stub is bundled alongside the assignment", () => {
    const fs = fakeFs({ "/build/main.cjs": `${STUB}\n${FIX}` });
    expect(() => assertWsNativeFallback(BUILD, fs)).not.toThrow();
  });

  it("passes when the assignment lands in a different chunk than the stub", () => {
    // Rollup splits main.ts and the server graph into separate chunks, so the
    // two halves routinely do NOT share a file.
    const fs = fakeFs({
      "/build/app-abc.cjs": STUB,
      "/build/main.cjs": FIX,
    });
    expect(() => assertWsNativeFallback(BUILD, fs)).not.toThrow();
  });

  it("descends into subdirectories to find both halves", () => {
    // Both assertions are load-bearing, and neither is on its own: a walk that
    // never recursed would find NOTHING nested, and "found nothing" is
    // indistinguishable from "no stub" — it returns early and throws nothing.
    // So each direction has to be the one that would notice.

    // Stub nested, no assignment anywhere: only a walk that descended can see
    // the stub, and seeing it is what makes this throw.
    const stubNested = fakeFs({ "/build/chunks/deep/app-abc.cjs": STUB });
    expect(() => assertWsNativeFallback(BUILD, stubNested)).toThrow(/#4208/);

    // Assignment nested, stub at the top: the stub is found either way, so a
    // walk that stopped short would miss only the fix — and throw.
    const fixNested = fakeFs({
      "/build/app-abc.cjs": STUB,
      "/build/chunks/deep/main.cjs": FIX,
    });
    expect(() => assertWsNativeFallback(BUILD, fixNested)).not.toThrow();
  });

  it("throws when the stub is bundled with nothing setting the env var", () => {
    const fs = fakeFs({ "/build/main.cjs": STUB });
    expect(() => assertWsNativeFallback(BUILD, fs)).toThrow(/#4208/);
  });

  it("throws when the only match is `ws`'s own read of the env var", () => {
    // GUARDRAIL. That read ships in every bundle containing `ws`; accepting it
    // would make this assertion pass on precisely the builds it exists to stop.
    const fs = fakeFs({ "/build/main.cjs": `${STUB}\n${WS_OWN_READ}` });
    expect(() => assertWsNativeFallback(BUILD, fs)).toThrow(/#4208/);
  });

  it("throws when the assignment is an empty string", () => {
    // GUARDRAIL. `ws` gates on `!process.env.WS_NO_BUFFER_UTIL`, so `= ""` is
    // falsy and leaves the probe — and the bug — fully in place.
    const fs = fakeFs({
      "/build/main.cjs": `${STUB}\nprocess.env.WS_NO_BUFFER_UTIL="";`,
    });
    expect(() => assertWsNativeFallback(BUILD, fs)).toThrow(/#4208/);
  });

  it("throws when the assignment targets an unrelated binding", () => {
    const fs = fakeFs({
      "/build/main.cjs": `${STUB}\nconst WS_NO_BUFFER_UTIL = "1";`,
    });
    expect(() => assertWsNativeFallback(BUILD, fs)).toThrow(/#4208/);
  });

  it('accepts any non-empty value, including "0"', () => {
    // Env values are strings; `"0"` is truthy in JS and does neutralize `ws`.
    const fs = fakeFs({
      "/build/main.cjs": `${STUB}\nprocess.env.WS_NO_BUFFER_UTIL = '0'`,
    });
    expect(() => assertWsNativeFallback(BUILD, fs)).not.toThrow();
  });

  it("ignores files that are not JS chunks", () => {
    // Sourcemaps carry the original source text, assignment included — reading
    // them would let a map vouch for a bundle that lost the fix.
    const fs = fakeFs({
      "/build/main.cjs": STUB,
      "/build/main.cjs.map": FIX,
    });
    expect(() => assertWsNativeFallback(BUILD, fs)).toThrow(/#4208/);
  });

  it("propagates a filesystem read error instead of passing the build", () => {
    // A build that cannot read its own output has not been verified.
    const fs = fakeFs(
      { "/build/main.cjs": STUB },
      {
        readFileSync: () => {
          throw new Error("EIO");
        },
      },
    );
    expect(() => assertWsNativeFallback(BUILD, fs)).toThrow("EIO");
  });
});
