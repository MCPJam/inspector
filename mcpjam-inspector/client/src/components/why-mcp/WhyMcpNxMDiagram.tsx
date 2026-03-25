import { memo } from "react";
import { LayoutGroup, motion } from "framer-motion";
import { useTheme } from "next-themes";
import asanaSrc from "@repo/assets/why-mcp/asana.svg";
import claudeSrc from "@repo/assets/why-mcp/claude.png";
import githubDarkSrc from "@repo/assets/why-mcp/github-dark.png";
import githubLightSrc from "@repo/assets/why-mcp/github-light.svg";
import googleSrc from "@repo/assets/why-mcp/google.png";
import openaiSrc from "@repo/assets/why-mcp/openai.png";
import slackSrc from "@repo/assets/why-mcp/slack.png";
import { springGentle, useDiagramMotion, VIEWPORT_ONCE } from "./diagram-motion";

type NodeSpec = {
  x: number;
  y: number;
  key: string;
  src: string;
  /** Used in dark mode (e.g. GitHub mark inverted for the active theme). */
  srcDark?: string;
  label: string;
};

const LEFT: NodeSpec[] = [
  { x: 18, y: 22, key: "claude", src: claudeSrc, label: "Claude" },
  { x: 18, y: 52, key: "gpt", src: openaiSrc, label: "OpenAI" },
  { x: 18, y: 82, key: "gemini", src: googleSrc, label: "Google Gemini" },
];

const RIGHT: NodeSpec[] = [
  {
    x: 82,
    y: 22,
    key: "github",
    src: githubLightSrc,
    srcDark: githubDarkSrc,
    label: "GitHub",
  },
  { x: 82, y: 52, key: "slack", src: slackSrc, label: "Slack" },
  { x: 82, y: 82, key: "asana", src: asanaSrc, label: "Asana" },
];

const PAIRS: [number, number][] = [
  [0, 0], [0, 1], [0, 2],
  [1, 0], [1, 1], [1, 2],
  [2, 0], [2, 1], [2, 2],
];

const HUB = { x: 50, y: 52 };

const panelVariants = {
  hidden: { opacity: 0, y: 18, scale: 0.98 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: springGentle,
  },
};

const listVariants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.12 },
  },
};

function MeshLines({ reduce }: { reduce: boolean }) {
  return (
    <g>
      {PAIRS.map(([ci, ti], i) => {
        const a = LEFT[ci];
        const b = RIGHT[ti];
        const d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
        return (
          <motion.path
            key={`${ci}-${ti}`}
            d={d}
            fill="none"
            stroke="url(#nxm-orange)"
            strokeWidth={0.9}
            strokeDasharray="3.5 3"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={VIEWPORT_ONCE}
            transition={{ duration: 0.42, delay: reduce ? 0 : i * 0.035, ease: "easeOut" }}
          />
        );
      })}
    </g>
  );
}

function HubLines() {
  return (
    <g>
      {LEFT.map((c, i) => (
        <motion.path
          key={`in-${i}`}
          d={`M ${c.x} ${c.y} L ${HUB.x} ${HUB.y}`}
          fill="none"
          stroke="url(#nxm-blue)"
          strokeWidth={1.15}
          strokeLinecap="round"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={VIEWPORT_ONCE}
          transition={{ duration: 0.45, delay: 0.05 + i * 0.06, ease: "easeOut" }}
        />
      ))}
      {RIGHT.map((t, i) => (
        <motion.path
          key={`out-${i}`}
          d={`M ${HUB.x} ${HUB.y} L ${t.x} ${t.y}`}
          fill="none"
          stroke="url(#nxm-blue)"
          strokeWidth={1.15}
          strokeLinecap="round"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={VIEWPORT_ONCE}
          transition={{ duration: 0.45, delay: 0.1 + i * 0.06, ease: "easeOut" }}
        />
      ))}
    </g>
  );
}

function HubNode({ reduce }: { reduce: boolean }) {
  return (
    <motion.g
      initial={{ scale: 0.88, opacity: 0 }}
      whileInView={{ scale: 1, opacity: 1 }}
      viewport={VIEWPORT_ONCE}
      transition={springGentle}
    >
      <motion.text
        x={HUB.x}
        y={HUB.y + 3}
        textAnchor="middle"
        className="pointer-events-none fill-blue-600 text-[8px] font-mono font-bold dark:fill-blue-400"
        animate={
          reduce
            ? {}
            : { y: [HUB.y + 3, HUB.y + 1, HUB.y + 3] }
        }
        transition={reduce ? { duration: 0 } : { duration: 3, repeat: Infinity, ease: "easeInOut" }}
      >
        MCP
      </motion.text>
    </motion.g>
  );
}

function NodeDots() {
  const { resolvedTheme } = useTheme();
  const hrefFor = (n: NodeSpec) =>
    resolvedTheme === "dark" && n.srcDark != null ? n.srcDark : n.src;

  const glyph = (n: NodeSpec, side: "L" | "R", delay: number) => (
    <motion.g
      key={`${side}-${n.key}`}
      initial={{ scale: 0.6, opacity: 0 }}
      whileInView={{ scale: 1, opacity: 1 }}
      viewport={VIEWPORT_ONCE}
      transition={{ ...springGentle, delay }}
    >
      <circle
        cx={n.x}
        cy={n.y}
        r={10}
        className="fill-card stroke-muted-foreground/35 dark:stroke-muted-foreground/45"
        strokeWidth={1}
      />
      <g transform={`translate(${n.x - 6} ${n.y - 6})`}>
        <title>{n.label}</title>
        <image
          href={hrefFor(n)}
          width={12}
          height={12}
          preserveAspectRatio="xMidYMid meet"
        />
      </g>
    </motion.g>
  );

  return (
    <>
      {LEFT.map((n, i) => glyph(n, "L", i * 0.04))}
      {RIGHT.map((n, i) => glyph(n, "R", 0.06 + i * 0.04))}
    </>
  );
}

function NxMSvg({ mode, reduce }: { mode: "nm" | "hub"; reduce: boolean }) {
  const a11yLabel =
    mode === "nm"
      ? "Without MCP: each AI host is fully meshed to each tool (N × M)."
      : "With MCP: each host and tool connects once through the hub (N + M).";

  return (
    <svg
      viewBox="0 0 100 100"
      className="h-36 w-full max-w-[220px] sm:max-w-none"
      role="img"
      aria-label={a11yLabel}
    >
      <defs>
        <linearGradient id="nxm-orange" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="rgb(251 146 60 / 0.35)" />
          <stop offset="100%" stopColor="rgb(234 88 12 / 0.65)" />
        </linearGradient>
        <linearGradient id="nxm-blue" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgb(59 130 246 / 0.25)" />
          <stop offset="50%" stopColor="rgb(59 130 246 / 0.85)" />
          <stop offset="100%" stopColor="rgb(59 130 246 / 0.25)" />
        </linearGradient>
      </defs>

      {mode === "nm" ? <MeshLines reduce={reduce} /> : null}
      {mode === "hub" ? (
        <>
          <HubLines />
          <HubNode reduce={reduce} />
        </>
      ) : null}

      <NodeDots />
    </svg>
  );
}

export const WhyMcpNxMDiagram = memo(function WhyMcpNxMDiagram() {
  const { reduce } = useDiagramMotion();

  return (
    <LayoutGroup>
      <motion.div
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5"
        initial="hidden"
        whileInView="show"
        viewport={VIEWPORT_ONCE}
        variants={listVariants}
      >
        <motion.div
          variants={panelVariants}
          className="relative overflow-hidden rounded-2xl border border-orange-200/50 bg-gradient-to-b from-orange-50/90 to-card shadow-sm dark:border-orange-900/40 dark:from-orange-950/30 dark:to-card"
        >
          <div className="border-b border-orange-200/40 bg-orange-500/[0.07] px-3 py-2.5 text-center dark:border-orange-900/35 dark:bg-orange-500/10">
            <span className="text-[11px] font-semibold tracking-tight text-orange-900/90 dark:text-orange-200/90">
              Without MCP
            </span>
          </div>
          <div className="flex flex-col items-center px-3 py-4 pb-5">
            <NxMSvg mode="nm" reduce={reduce} />
          </div>
        </motion.div>

        <motion.div
          variants={panelVariants}
          className="relative overflow-hidden rounded-2xl border border-blue-200/50 bg-gradient-to-b from-blue-50/90 to-card shadow-sm dark:border-blue-900/40 dark:from-blue-950/30 dark:to-card"
        >
          <div className="border-b border-blue-200/40 bg-blue-500/[0.07] px-3 py-2.5 text-center dark:border-blue-900/35 dark:bg-blue-500/10">
            <span className="text-[11px] font-semibold tracking-tight text-blue-900/90 dark:text-blue-200/90">
              With MCP
            </span>
          </div>
          <div className="flex flex-col items-center px-3 py-4 pb-5">
            <NxMSvg mode="hub" reduce={reduce} />
          </div>
        </motion.div>
      </motion.div>
    </LayoutGroup>
  );
});
