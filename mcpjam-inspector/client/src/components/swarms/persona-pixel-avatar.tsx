/**
 * Cursor-style 8-bit persona sprites — deterministic per seed, idle bob + blink.
 * Pure SVG (no asset pack) so each roster row gets a little personality without
 * shipping sprite sheets. Optional shape/palette overrides persist via
 * `personas.avatarShape` / `personas.avatarPalette` (backend).
 */

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type Cell = "." | "O" | "S" | "H" | "T" | "P" | "E" | "A" | "L";

type Palette = {
  outline: string;
  skin: string;
  hair: string;
  top: string;
  pants: string;
  accent: string;
};

const PALETTES: Palette[] = [
  {
    outline: "#1a1a1a",
    skin: "#f0c4a0",
    hair: "#3d2314",
    top: "#e85d4c",
    pants: "#3b4a6b",
    accent: "#f4d35e",
  },
  {
    outline: "#1a1a1a",
    skin: "#d4a574",
    hair: "#1f1f1f",
    top: "#4a90d9",
    pants: "#2c3e50",
    accent: "#7bed9f",
  },
  {
    outline: "#1a1a1a",
    skin: "#ffe0bd",
    hair: "#c0392b",
    top: "#9b59b6",
    pants: "#34495e",
    accent: "#f39c12",
  },
  {
    outline: "#1a1a1a",
    skin: "#8d5524",
    hair: "#2c1810",
    top: "#27ae60",
    pants: "#1a252f",
    accent: "#e74c3c",
  },
  {
    outline: "#1a1a1a",
    skin: "#f5d0c5",
    hair: "#f7d794",
    top: "#fd79a8",
    pants: "#636e72",
    accent: "#00cec9",
  },
  {
    outline: "#1a1a1a",
    skin: "#c68642",
    hair: "#4a3728",
    top: "#0984e3",
    pants: "#2d3436",
    accent: "#fdcb6e",
  },
];

/** 12×14 pixel silhouettes. `.` empty, letters map to palette slots. */
const SHAPES: Cell[][][] = [
  // Classic bob-cut
  [
    "....HHHH....",
    "...HHHHHH...",
    "..SSSSSSSS..",
    "..SE.E.ESS..",
    "..SSSSSSSS..",
    "...TTTTTT...",
    "..ATATTTTA..",
    ".AA.TTTT.AA.",
    "....TTTT....",
    "....PP.PP...",
    "....PP.PP...",
    "....LL.LL...",
  ].map((row) => row.split("") as Cell[]),
  // Cap / explorer
  [
    "...OOOOOO...",
    "..OHHHHHHO..",
    "..SSSSSSSS..",
    "..SE.E.ESS..",
    "..SSSSSSSS..",
    "...TTTTTT...",
    "..TATTTTAT..",
    ".A..TTTT..A.",
    "....TTTT....",
    "....PP.PP...",
    "....PP.PP...",
    "....LL.LL...",
  ].map((row) => row.split("") as Cell[]),
  // Spiky hair
  [
    "..H..HH..H..",
    "...HHHHHH...",
    "..SSSSSSSS..",
    "..SE.E.ESS..",
    "..SSSSSSSS..",
    "...TTTTTT...",
    "..ATATATTA..",
    "AA..TTTT..AA",
    "....TTTT....",
    "....PP.PP...",
    "....PP.PP...",
    "....LL.LL...",
  ].map((row) => row.split("") as Cell[]),
  // Ponytail
  [
    ".....HHH.H..",
    "....HHHHHH..",
    "..SSSSSSSS..",
    "..SE.E.ESS..",
    "..SSSSSSSS..",
    "...TTTTTT...",
    "..TATTTTAT..",
    ".A..TTTT..A.",
    "....TTTT....",
    "....PP.PP...",
    "....PP.PP...",
    "....LL.LL...",
  ].map((row) => row.split("") as Cell[]),
  // Short crop + scarf accent
  [
    "....HHHH....",
    "...HHHHHH...",
    "..SSSSSSSS..",
    "..SE.E.ESS..",
    "..SSSSSSSS..",
    "...AAAAAA...",
    "..TTTTTTTT..",
    ".A..TTTT..A.",
    "....TTTT....",
    "....PP.PP...",
    "....PP.PP...",
    "....LL.LL...",
  ].map((row) => row.split("") as Cell[]),
  // Tall hair / wizard vibe
  [
    ".....HH.....",
    "....HHHH....",
    "...HHHHHH...",
    "..SSSSSSSS..",
    "..SE.E.ESS..",
    "..SSSSSSSS..",
    "...TTTTTT...",
    "..ATATTTTA..",
    "AA..TTTT..AA",
    "....TTTT....",
    "....PP.PP...",
    "....LL.LL...",
  ].map((row) => row.split("") as Cell[]),
];

/** Keep in sync with backend `PERSONA_AVATAR_SHAPE_COUNT`. */
export const PERSONA_PIXEL_SHAPE_COUNT = SHAPES.length;
/** Keep in sync with backend `PERSONA_AVATAR_PALETTE_COUNT`. */
export const PERSONA_PIXEL_PALETTE_COUNT = PALETTES.length;

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function cellColor(cell: Cell, palette: Palette): string | null {
  switch (cell) {
    case "O":
      return palette.outline;
    case "S":
      return palette.skin;
    case "H":
      return palette.hair;
    case "T":
      return palette.top;
    case "P":
      return palette.pants;
    case "L":
      return palette.pants;
    case "E":
      return palette.outline;
    case "A":
      return palette.accent;
    default:
      return null;
  }
}

function withBlink(shape: Cell[][], blinking: boolean): Cell[][] {
  if (!blinking) return shape;
  return shape.map((row) =>
    row.map((cell) => (cell === "E" ? "S" : cell)),
  );
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

export function PersonaPixelAvatar({
  seed,
  shapeIndex: shapeOverride,
  paletteIndex: paletteOverride,
  size = "md",
  active = false,
  className,
}: {
  /** Stable id (persona `_id`) — picks shape + palette when overrides absent. */
  seed: string;
  /** Persisted look override (`personas.avatarShape`). */
  shapeIndex?: number | null;
  /** Persisted look override (`personas.avatarPalette`). */
  paletteIndex?: number | null;
  size?: "sm" | "md" | "lg";
  /** Selected / focused — slightly peppier bob. */
  active?: boolean;
  className?: string;
}) {
  const { shapeIndex, paletteIndex } = resolvePersonaPixelLook(seed, {
    shapeIndex: shapeOverride,
    paletteIndex: paletteOverride,
  });
  const shape = SHAPES[shapeIndex]!;
  const palette = PALETTES[paletteIndex]!;
  const [blinking, setBlinking] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (reduceMotion) return;
    let timeout: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const schedule = () => {
      timeout = setTimeout(
        () => {
          if (cancelled) return;
          setBlinking(true);
          timeout = setTimeout(() => {
            if (cancelled) return;
            setBlinking(false);
            schedule();
          }, 120);
        },
        2200 + (hashSeed(seed) % 1800),
      );
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [seed, reduceMotion]);

  const frame = withBlink(shape, blinking && !reduceMotion);
  const rows = frame.length;
  const cols = frame[0]?.length ?? 12;
  const px = size === "lg" ? 3 : size === "sm" ? 2 : 2.5;
  const width = cols * px;
  const height = rows * px;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-end justify-center",
        !reduceMotion &&
          (active
            ? "animate-persona-pixel-bob-active"
            : "animate-persona-pixel-bob"),
        className,
      )}
      style={{ width, height: height + (size === "lg" ? 4 : 2) }}
      aria-hidden
      data-testid="persona-pixel-avatar"
      data-shape={shapeIndex}
      data-palette={paletteIndex}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${cols} ${rows}`}
        shapeRendering="crispEdges"
        className="block"
        style={{ imageRendering: "pixelated" }}
      >
        {frame.flatMap((row, y) =>
          row.map((cell, x) => {
            const fill = cellColor(cell, palette);
            if (!fill) return null;
            return (
              <rect
                key={`${x}-${y}`}
                x={x}
                y={y}
                width={1}
                height={1}
                fill={fill}
              />
            );
          }),
        )}
      </svg>
    </span>
  );
}
