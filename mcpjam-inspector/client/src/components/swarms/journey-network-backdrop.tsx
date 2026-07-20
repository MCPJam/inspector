import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

type Rgb = { r: number; g: number; b: number };

type Node = {
  x: number;
  y: number;
  ox: number;
  oy: number;
  phase: number;
};

type Edge = { a: number; b: number };

type Journey = {
  nodes: Node[];
  edges: Edge[];
  path: number[];
  color: Rgb;
  edgeIndex: number;
  t: number;
  speed: number;
  dash: number;
  pulse: number;
};

/** Muted jewel tones — low saturation, premium feel. */
const PALETTE: Rgb[] = [
  { r: 196, g: 112, b: 96 },
  { r: 96, g: 148, b: 168 },
  { r: 140, g: 124, b: 176 },
  { r: 176, g: 140, b: 88 },
  { r: 104, g: 148, b: 128 },
  { r: 168, g: 108, b: 132 },
  { r: 112, g: 132, b: 172 },
  { r: 148, g: 128, b: 96 },
];

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isDarkTheme(el: HTMLElement): boolean {
  return (
    el.classList.contains("dark") ||
    !!el.closest(".dark") ||
    document.documentElement.classList.contains("dark")
  );
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeJourney(
  ax: number,
  ay: number,
  scale: number,
  color: Rgb,
  rand: () => number,
  startT: number,
  pulse: number,
): Journey {
  const sx = 64 * scale;
  const sy = 44 * scale;
  const tilt = (rand() - 0.5) * 0.28;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);

  // Sparse fork: start → two branches → soft converge → tip
  const raw: Array<[number, number]> = [
    [-sx * 2.0, 0],
    [-sx * 0.7, -sy],
    [sx * 0.55, -sy * 0.95],
    [-sx * 0.75, sy * 0.95],
    [sx * 0.5, sy * 0.55],
    [sx * 1.65, sy * 0.1],
  ];

  const nodes: Node[] = raw.map(([x, y], i) => {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    return {
      x: ax + rx,
      y: ay + ry,
      ox: ax + rx,
      oy: ay + ry,
      phase: i * 0.9 + rand() * Math.PI,
    };
  });

  const edges: Edge[] = [
    { a: 0, b: 1 },
    { a: 1, b: 2 },
    { a: 0, b: 3 },
    { a: 3, b: 4 },
    { a: 4, b: 5 },
    { a: 2, b: 5 },
  ];

  const path = [0, 2, 3, 4, 5, 1];

  return {
    nodes,
    edges,
    path,
    color,
    edgeIndex: Math.floor(rand() * path.length),
    t: startT,
    speed: 0.12 + rand() * 0.1,
    dash: rand() * 20,
    pulse,
  };
}

function scatterJourneys(w: number, h: number): Journey[] {
  const rand = mulberry32(Math.floor(w * 13 + h * 29) || 1);
  // More presence, still breathable — scale with pane size
  const count = w < 640 ? 4 : w < 1100 ? 6 : 8;
  const journeys: Journey[] = [];

  // Hand-placed anchors across the pane (loose grid, not a pile-up)
  const layout: Array<[number, number]> = [
    [0.22, 0.28],
    [0.55, 0.22],
    [0.82, 0.3],
    [0.18, 0.55],
    [0.48, 0.5],
    [0.78, 0.58],
    [0.32, 0.78],
    [0.68, 0.8],
    [0.9, 0.72],
    [0.1, 0.78],
  ];

  for (let i = 0; i < count; i++) {
    const [nx, ny] = layout[i]!;
    const jitterX = (rand() - 0.5) * 0.05;
    const jitterY = (rand() - 0.5) * 0.045;
    journeys.push(
      makeJourney(
        w * (nx + jitterX),
        h * (ny + jitterY),
        0.7 + rand() * 0.4,
        PALETTE[i % PALETTE.length]!,
        rand,
        rand(),
        i * 1.3,
      ),
    );
  }

  return journeys;
}

function rgba(c: Rgb, a: number) {
  return `rgba(${c.r},${c.g},${c.b},${a})`;
}

/**
 * Quiet, premium journey constellation for the Swarms empty pane.
 * Few sparse graphs, muted color, slow travelers, soft vignette.
 */
export function JourneyNetworkBackdrop({
  className,
  message = "Select a persona to see its journeys.",
}: {
  className?: string;
  message?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let journeys: Journey[] = [];
    let w = 0;
    let h = 0;
    let dpr = 1;
    let lastTs = 0;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      journeys = scatterJourneys(w, h);
    };

    const drawFrame = (ts: number) => {
      const dark = isDarkTheme(wrap);
      const reduce = prefersReducedMotion();
      const dt = lastTs ? Math.min(0.048, (ts - lastTs) / 1000) : 0.016;
      lastTs = ts;

      ctx.clearRect(0, 0, w, h);

      // Soft atmospheric wash — keeps the canvas from feeling flat/cheap
      const wash = ctx.createRadialGradient(
        w * 0.5,
        h * 0.48,
        0,
        w * 0.5,
        h * 0.48,
        Math.max(w, h) * 0.55,
      );
      if (dark) {
        wash.addColorStop(0, "rgba(255,255,255,0.018)");
        wash.addColorStop(1, "rgba(255,255,255,0)");
      } else {
        wash.addColorStop(0, "rgba(40,44,52,0.03)");
        wash.addColorStop(1, "rgba(40,44,52,0)");
      }
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, h);

      const edgeAlpha = dark ? 0.16 : 0.12;
      const nodeStroke = dark
        ? "rgba(210, 214, 220, 0.28)"
        : "rgba(70, 76, 86, 0.22)";
      const nodeFill = dark
        ? "rgba(12, 12, 14, 0.55)"
        : "rgba(255, 255, 253, 0.65)";

      for (const j of journeys) {
        for (const n of j.nodes) {
          n.phase += dt * 0.28;
          const amp = reduce ? 0 : 1.1;
          n.x = n.ox + Math.sin(n.phase) * amp;
          n.y = n.oy + Math.cos(n.phase * 0.85) * amp * 0.6;
        }

        const activeIdx = j.path[j.edgeIndex] ?? 0;
        const active = j.edges[activeIdx]!;

        if (!reduce) {
          j.t += dt * j.speed;
          j.dash += dt * 14;
          if (j.t >= 1) {
            j.t = 0;
            j.edgeIndex = (j.edgeIndex + 1) % j.path.length;
          }
        }

        // Edges — hairline, almost whisper-quiet
        for (let i = 0; i < j.edges.length; i++) {
          const e = j.edges[i]!;
          const a = j.nodes[e.a]!;
          const b = j.nodes[e.b]!;
          const isActive = i === activeIdx;

          ctx.lineWidth = isActive ? 1.1 : 0.9;
          if (isActive) {
            ctx.strokeStyle = rgba(j.color, dark ? 0.32 : 0.24);
            ctx.setLineDash([3.5, 7]);
            ctx.lineDashOffset = -j.dash;
          } else {
            ctx.strokeStyle = dark
              ? `rgba(190,196,205,${edgeAlpha})`
              : `rgba(80,86,96,${edgeAlpha})`;
            ctx.setLineDash([]);
            ctx.lineDashOffset = 0;
          }
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;

        const from = j.nodes[active.a]!;
        const to = j.nodes[active.b]!;
        // Smoothstep for premium easing
        const u = reduce ? 0.45 : j.t;
        const ease = u * u * (3 - 2 * u);
        const tx = from.x + (to.x - from.x) * ease;
        const ty = from.y + (to.y - from.y) * ease;

        // Quiet trail
        if (!reduce) {
          for (let k = 1; k <= 3; k++) {
            const tt = Math.max(0, ease - k * 0.08);
            const px = from.x + (to.x - from.x) * tt;
            const py = from.y + (to.y - from.y) * tt;
            ctx.beginPath();
            ctx.arc(px, py, 1.4, 0, Math.PI * 2);
            ctx.fillStyle = rgba(j.color, 0.06 * (1 - k / 4));
            ctx.fill();
          }
        }

        // Nodes — small rings, no checkmarks
        for (const n of j.nodes) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = nodeFill;
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = nodeStroke;
          ctx.stroke();
        }

        // Active tip — soft bloom + crisp core
        const breath = reduce
          ? 1
          : 0.82 + 0.18 * Math.sin(ts / 900 + j.pulse);
        const glowR = 26 * breath;
        const grad = ctx.createRadialGradient(tx, ty, 0, tx, ty, glowR);
        grad.addColorStop(0, rgba(j.color, dark ? 0.38 : 0.28));
        grad.addColorStop(0.35, rgba(j.color, dark ? 0.12 : 0.09));
        grad.addColorStop(1, rgba(j.color, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(tx, ty, glowR, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(tx, ty, 2.6 * breath, 0, Math.PI * 2);
        ctx.fillStyle = rgba(j.color, dark ? 0.85 : 0.75);
        ctx.fill();
      }

      if (!reduce) raf = requestAnimationFrame(drawFrame);
    };

    resize();
    if (prefersReducedMotion()) {
      drawFrame(performance.now());
    } else {
      raf = requestAnimationFrame(drawFrame);
    }

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const onMotion = () => {
      cancelAnimationFrame(raf);
      lastTs = 0;
      if (prefersReducedMotion()) drawFrame(performance.now());
      else raf = requestAnimationFrame(drawFrame);
    };
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", onMotion);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mq.removeEventListener("change", onMotion);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className={cn(
        "relative flex h-full min-h-[280px] w-full items-center justify-center overflow-hidden bg-background",
        className,
      )}
      data-testid="journey-network-backdrop"
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <canvas
          ref={canvasRef}
          aria-hidden
          className="absolute inset-0 h-full w-full opacity-90"
          style={{
            maskImage:
              "radial-gradient(110% 95% at 50% 48%, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.32) 48%, rgba(0,0,0,0) 86%)",
            WebkitMaskImage:
              "radial-gradient(110% 95% at 50% 48%, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.32) 48%, rgba(0,0,0,0) 86%)",
          }}
        />
      </div>
      <p className="relative z-10 max-w-[16rem] text-center text-sm tracking-wide text-muted-foreground/80">
        {message}
      </p>
    </div>
  );
}
