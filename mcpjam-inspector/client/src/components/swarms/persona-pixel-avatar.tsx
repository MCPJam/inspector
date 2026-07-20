/**
 * Generated 8-bit "pixel golem" persona avatars — faceted stone workers with a
 * floating sensor head. Deterministic per seed; optional family/mineral
 * overrides persist via `personas.avatarShape` / `personas.avatarPalette`.
 * Motion is CSS-only (head hop + sensor/levitation pulse).
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";

export type PersonaPixelState = "idle" | "thinking" | "running" | "error";

type Mineral = {
  name: string;
  dark: string;
  mid: string;
  light: string;
  glow: string;
};

type Family = {
  name: string;
  bw: [number, number];
  bh: [number, number];
  legH: [number, number];
  hw: [number, number];
  hh: [number, number];
  taper?: boolean;
  legs?: 2 | 3;
  arms?: boolean;
  crest?: boolean;
  shoulder?: boolean;
  gapExtra?: boolean;
};

type GolemRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  opacity?: number;
  className?: string;
};

type GolemParts = {
  body: GolemRect[];
  head: GolemRect[];
  headDelay: number;
};

const GRID_W = 16;
const GRID_H = 19;
const ERROR_GLOW = "#c9584a";

const FAMILIES: Family[] = [
  {
    name: "Brute",
    bw: [4, 5],
    bh: [4, 5],
    legH: [1, 2],
    hw: [2, 3],
    hh: [2, 3],
    taper: true,
    arms: true,
  },
  {
    name: "Stele",
    bw: [2, 3],
    bh: [6, 7],
    legH: [1, 1],
    hw: [2, 2],
    hh: [3, 4],
  },
  {
    name: "Runt",
    bw: [2, 3],
    bh: [3, 4],
    legH: [1, 2],
    hw: [2, 3],
    hh: [2, 2],
    arms: true,
  },
  {
    name: "Tripod",
    bw: [3, 4],
    bh: [3, 5],
    legH: [2, 3],
    hw: [2, 2],
    hh: [2, 3],
    taper: true,
    legs: 3,
  },
  {
    name: "Warden",
    bw: [3, 4],
    bh: [4, 6],
    legH: [1, 2],
    hw: [3, 3],
    hh: [2, 3],
    arms: true,
    crest: true,
    shoulder: true,
  },
  {
    name: "Waif",
    bw: [2, 2],
    bh: [4, 5],
    legH: [2, 3],
    hw: [2, 3],
    hh: [2, 3],
    arms: true,
    gapExtra: true,
  },
];

const MINERALS: Mineral[] = [
  {
    name: "Basalt",
    dark: "#22262b",
    mid: "#3c444d",
    light: "#5e6a75",
    glow: "#e8945c",
  },
  {
    name: "Jade",
    dark: "#1d332a",
    mid: "#32584a",
    light: "#568a70",
    glow: "#a9e6c0",
  },
  {
    name: "Oxide",
    dark: "#3a2420",
    mid: "#6b3d2e",
    light: "#9c6246",
    glow: "#f0b078",
  },
  {
    name: "Lapis",
    dark: "#1d2740",
    mid: "#334570",
    light: "#54679b",
    glow: "#9ec1f0",
  },
  {
    name: "Bone",
    dark: "#5c5346",
    mid: "#8b7f6b",
    light: "#c4b696",
    glow: "#f2ddab",
  },
  {
    name: "Amethyst",
    dark: "#2d2340",
    mid: "#4c3a6b",
    light: "#755f9c",
    glow: "#c9a8ef",
  },
];

/** Keep in sync with backend `PERSONA_AVATAR_SHAPE_COUNT`. */
export const PERSONA_PIXEL_SHAPE_COUNT = FAMILIES.length;
/** Keep in sync with backend `PERSONA_AVATAR_PALETTE_COUNT`. */
export const PERSONA_PIXEL_PALETTE_COUNT = MINERALS.length;

export const PERSONA_PIXEL_FAMILY_NAMES = FAMILIES.map((f) => f.name);
export const PERSONA_PIXEL_MINERAL_NAMES = MINERALS.map((m) => m.name);

/** Byte-identical to the previous sprite hasher — do not change. */
function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function fnv1a(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pulseClass(state: PersonaPixelState, kind: "sensor" | "gap"): string | undefined {
  if (state === "error") return undefined;
  if (state === "thinking" && kind === "sensor") {
    return "animate-persona-golem-flicker";
  }
  if (state === "running") return "animate-persona-golem-pulse-fast";
  return "animate-persona-golem-pulse";
}

function generatePixelGolem(
  seed: string,
  familyIndex: number,
  mineralIndex: number,
  state: PersonaPixelState,
): GolemParts {
  const rng = mulberry32(fnv1a(seed));
  const F = FAMILIES[familyIndex % FAMILIES.length]!;
  const mat = MINERALS[mineralIndex % MINERALS.length]!;
  const ri = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));

  const bw = ri(F.bw[0], F.bw[1]);
  const bh = ri(F.bh[0], F.bh[1]);
  const legH = ri(F.legH[0], F.legH[1]);
  const hw = ri(F.hw[0], F.hw[1]);
  const hh = ri(F.hh[0], F.hh[1]);
  const gap = 1 + (F.gapExtra ? 1 : 0);
  const legs = F.legs ?? 2;

  const cxL = 7;
  const cxR = 8;
  const groundY = GRID_H - 2;
  const bodyBot = groundY - legH;
  const bodyTop = bodyBot - bh + 1;
  const headBot = bodyTop - gap - 1;
  const headTop = headBot - hh + 1;

  const grid: number[][] = Array.from({ length: GRID_H }, () =>
    Array(GRID_W).fill(0),
  );
  const put = (x: number, y: number, v: number) => {
    if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) grid[y]![x] = v;
  };

  for (let y = bodyTop; y <= bodyBot; y++) {
    let w = bw;
    if (F.taper && y === bodyTop) w = Math.max(1, bw - 1);
    for (let d = 0; d < w; d++) {
      put(cxR + d, y, 1);
      put(cxL - d, y, 1);
    }
  }
  if (F.shoulder) {
    put(cxR + bw, bodyTop, 1);
    put(cxL - bw, bodyTop, 1);
  }
  // Chipped corners (asymmetry)
  if (rng() < 0.45) {
    put(cxR + (F.taper ? Math.max(0, bw - 2) : bw - 1), bodyTop, 0);
  }
  if (rng() < 0.45) {
    put(cxL - (bw - 1), bodyBot, 0);
  }

  const lx = Math.min(bw - 1, 1 + Math.floor(rng() * 2));
  for (let y = bodyBot + 1; y <= groundY; y++) {
    put(cxR + lx, y, 1);
    put(cxL - lx, y, 1);
    if (legs === 3) {
      put(cxL, y, 1);
      put(cxR, y, 1);
    }
  }

  if (F.arms && rng() < 0.85) {
    const al = ri(2, 3);
    for (let y = bodyTop + 1; y < Math.min(bodyTop + 1 + al, bodyBot); y++) {
      put(cxR + bw, y, 1);
      put(cxL - bw, y, 1);
    }
  }

  for (let y = headTop; y <= headBot; y++) {
    let w = hw;
    if (y === headTop && hh > 2 && rng() < 0.6) w = hw - 1;
    for (let d = 0; d < Math.max(1, w); d++) {
      put(cxR + d, y, 2);
      put(cxL - d, y, 2);
    }
  }
  if (F.crest && rng() < 0.85) {
    put(rng() < 0.5 ? cxL : cxR, headTop - 1, 2);
    if (rng() < 0.4) {
      put(rng() < 0.5 ? cxL - 1 : cxR + 1, headTop - 1, 2);
    }
  }

  const glowCol = state === "error" ? ERROR_GLOW : mat.glow;
  const senCls = pulseClass(state, "sensor");
  const gapCls = pulseClass(state, "gap");
  const empty = (x: number, y: number) => !(grid[y] && grid[y]![x]);

  const body: GolemRect[] = [];
  const head: GolemRect[] = [];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const v = grid[y]![x]!;
      if (!v) continue;
      let col = mat.mid;
      if (empty(x, y - 1)) col = mat.light;
      else if (empty(x + 1, y) || empty(x, y + 1)) col = mat.dark;
      if (rng() < 0.1) col = col === mat.dark ? mat.mid : mat.dark;
      const rect: GolemRect = { x, y, width: 1, height: 1, fill: col };
      if (v === 2) head.push(rect);
      else body.push(rect);
    }
  }

  // Sensor: visor or single dot
  const sy = headTop + Math.floor(hh / 2);
  if (rng() < 0.35) {
    for (let x = cxL; x <= cxR; x++) {
      head.push({
        x,
        y: sy,
        width: 1,
        height: 1,
        fill: glowCol,
        className: senCls,
      });
    }
  } else {
    const sx =
      rng() < 0.5
        ? cxL - Math.floor(rng() * Math.max(1, hw - 1))
        : cxR + Math.floor(rng() * Math.max(1, hw - 1));
    head.push({
      x: sx,
      y: sy,
      width: 1,
      height: 1,
      fill: glowCol,
      className: senCls,
    });
  }

  // Levitation glow in the gap row
  body.push({
    x: cxL,
    y: bodyTop - 1,
    width: 2,
    height: 1,
    fill: glowCol,
    opacity: 0.85,
    className: gapCls,
  });
  // Ground shadow
  body.push({
    x: cxL - bw,
    y: GRID_H - 1,
    width: bw * 2 + 2,
    height: 0.8,
    fill: "#000",
    opacity: 0.22,
  });

  return {
    body,
    head,
    headDelay: -(rng() * 2.6),
  };
}

export function resolvePersonaPixelVariant(seed: string): {
  shapeIndex: number;
  paletteIndex: number;
} {
  const hash = hashSeed(seed || "persona");
  return {
    shapeIndex: hash % PERSONA_PIXEL_SHAPE_COUNT,
    paletteIndex:
      Math.floor(hash / PERSONA_PIXEL_SHAPE_COUNT) % PERSONA_PIXEL_PALETTE_COUNT,
  };
}

/** Wrap an index into `[0, count)`. */
export function wrapPersonaPixelIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  const n = Math.trunc(index);
  return ((n % count) + count) % count;
}

/**
 * Resolve the look for a persona: explicit saved indices win; otherwise seed
 * from `_id` so existing personas keep a stable default.
 */
export function resolvePersonaPixelLook(
  seed: string,
  overrides?: {
    shapeIndex?: number | null;
    paletteIndex?: number | null;
  },
): { shapeIndex: number; paletteIndex: number } {
  const seeded = resolvePersonaPixelVariant(seed);
  return {
    shapeIndex:
      overrides?.shapeIndex === undefined || overrides.shapeIndex === null
        ? seeded.shapeIndex
        : wrapPersonaPixelIndex(
            overrides.shapeIndex,
            PERSONA_PIXEL_SHAPE_COUNT,
          ),
    paletteIndex:
      overrides?.paletteIndex === undefined || overrides.paletteIndex === null
        ? seeded.paletteIndex
        : wrapPersonaPixelIndex(
            overrides.paletteIndex,
            PERSONA_PIXEL_PALETTE_COUNT,
          ),
  };
}

function cellPx(size: "sm" | "md" | "lg"): number {
  if (size === "sm") return 1.5;
  if (size === "lg") return 2.75;
  return 2;
}

export function PersonaPixelAvatar({
  seed,
  shapeIndex: shapeOverride,
  paletteIndex: paletteOverride,
  size = "md",
  active = false,
  state = "idle",
  className,
}: {
  /** Stable id (persona `_id`) — picks family + mineral when overrides absent. */
  seed: string;
  /** Persisted look override (`personas.avatarShape`) — body family. */
  shapeIndex?: number | null;
  /** Persisted look override (`personas.avatarPalette`) — mineral. */
  paletteIndex?: number | null;
  size?: "sm" | "md" | "lg";
  /** Selected / focused — slightly peppier bob. */
  active?: boolean;
  /** Activity language: light does the status work. */
  state?: PersonaPixelState;
  className?: string;
}) {
  const { shapeIndex, paletteIndex } = resolvePersonaPixelLook(seed, {
    shapeIndex: shapeOverride,
    paletteIndex: paletteOverride,
  });

  const parts = useMemo(
    () => generatePixelGolem(seed, shapeIndex, paletteIndex, state),
    [seed, shapeIndex, paletteIndex, state],
  );

  const px = cellPx(size);
  const width = GRID_W * px;
  const height = GRID_H * px;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-end justify-center",
        active
          ? "animate-persona-pixel-bob-active"
          : "animate-persona-pixel-bob",
        className,
      )}
      style={{ width, height: height + (size === "lg" ? 4 : 2) }}
      aria-hidden
      data-testid="persona-pixel-avatar"
      data-shape={shapeIndex}
      data-palette={paletteIndex}
      data-state={state}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${GRID_W} ${GRID_H}`}
        shapeRendering="crispEdges"
        className="block"
        style={{ imageRendering: "pixelated" }}
      >
        {parts.body.map((r, i) => (
          <rect
            key={`b-${i}`}
            x={r.x}
            y={r.y}
            width={r.width}
            height={r.height}
            fill={r.fill}
            opacity={r.opacity}
            className={r.className}
          />
        ))}
        <g
          className="animate-persona-golem-head"
          style={{ animationDelay: `${parts.headDelay}s` }}
        >
          {parts.head.map((r, i) => (
            <rect
              key={`h-${i}`}
              x={r.x}
              y={r.y}
              width={r.width}
              height={r.height}
              fill={r.fill}
              opacity={r.opacity}
              className={r.className}
            />
          ))}
        </g>
      </svg>
    </span>
  );
}
