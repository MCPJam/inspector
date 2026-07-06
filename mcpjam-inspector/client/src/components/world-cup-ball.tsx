// ⚽ World Cup 2026 celebration — TEMPORARY.
// To remove after the tournament: delete this file and the two <WorldCupBall />
// usages in components/mcp-sidebar.tsx (search for "WorldCupBall").

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A small soccer ball that sits next to the MCP Jam logo during the World Cup.
 * Click it for a little "kick" bounce. It renders inside the logo's navigation
 * button, so the click handler calls stopPropagation() to bounce without
 * navigating. The animation respects prefers-reduced-motion.
 */
export function WorldCupBall({ className }: { className?: string }) {
  const [kicking, setKicking] = useState(false);

  return (
    <span
      role="img"
      aria-label="Soccer ball"
      title="Go World Cup! ⚽"
      onClick={(e) => {
        e.stopPropagation();
        setKicking(true);
      }}
      onAnimationEnd={() => setKicking(false)}
      className={cn(
        "inline-flex cursor-pointer select-none",
        kicking && "wc-ball--kick",
        className
      )}
    >
      <style>{`
        @keyframes wc-ball-kick {
          0%   { transform: translateY(0) rotate(0deg); }
          30%  { transform: translateY(-6px) rotate(-25deg); }
          60%  { transform: translateY(0) rotate(12deg); }
          100% { transform: translateY(0) rotate(0deg); }
        }
        .wc-ball--kick { animation: wc-ball-kick 0.5s ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .wc-ball--kick { animation: none; }
        }
      `}</style>
      <svg
        viewBox="0 0 64 64"
        className="h-4 w-4"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <clipPath id="wc-ball-clip">
            <circle cx="32" cy="32" r="29" />
          </clipPath>
        </defs>
        <circle
          cx="32"
          cy="32"
          r="29"
          fill="#ffffff"
          stroke="#111827"
          strokeWidth="2"
        />
        {/* Real soccer-ball pattern: a truncated icosahedron projected onto a
            sphere — black pentagons + connected seams over the white hexagons.
            Geometry was generated and visually verified (see the design doc). */}
        <g clipPath="url(#wc-ball-clip)">
          <polygon points="32.00,22.04 22.53,28.92 26.15,40.05 37.85,40.05 41.47,28.92" fill="#111827" />
          <polygon points="20.30,58.06 26.15,56.16 20.30,48.11 10.83,45.03 10.83,51.18" fill="#111827" />
          <polygon points="3.60,28.92 7.21,33.90 13.06,25.85 13.06,15.89 7.21,17.79" fill="#111827" />
          <polygon points="56.79,17.79 50.94,15.89 50.94,25.85 56.79,33.90 60.40,28.92" fill="#111827" />
          <polygon points="26.15,4.04 22.53,9.01 32.00,12.09 41.47,9.01 37.85,4.04" fill="#111827" />
          <polygon points="53.17,51.18 53.17,45.03 43.70,48.11 37.85,56.16 43.70,58.06" fill="#111827" />
          <g fill="none" stroke="#111827" strokeWidth="0.8" strokeLinejoin="round">
            <polygon points="32.00,22.04 22.53,28.92 26.15,40.05 37.85,40.05 41.47,28.92" />
            <polygon points="20.30,58.06 26.15,56.16 20.30,48.11 10.83,45.03 10.83,51.18" />
            <polygon points="3.60,28.92 7.21,33.90 13.06,25.85 13.06,15.89 7.21,17.79" />
            <polygon points="56.79,17.79 50.94,15.89 50.94,25.85 56.79,33.90 60.40,28.92" />
            <polygon points="26.15,4.04 22.53,9.01 32.00,12.09 41.47,9.01 37.85,4.04" />
            <polygon points="53.17,51.18 53.17,45.03 43.70,48.11 37.85,56.16 43.70,58.06" />
            <polygon points="10.83,45.03 20.30,48.11 26.15,40.05 22.53,28.92 13.06,25.85 7.21,33.90" />
            <polygon points="43.70,48.11 37.85,40.05 26.15,40.05 20.30,48.11 26.15,56.16 37.85,56.16" />
            <polygon points="13.06,15.89 13.06,25.85 22.53,28.92 32.00,22.04 32.00,12.09 22.53,9.01" />
            <polygon points="32.00,12.09 32.00,22.04 41.47,28.92 50.94,25.85 50.94,15.89 41.47,9.01" />
            <polygon points="56.79,33.90 50.94,25.85 41.47,28.92 37.85,40.05 43.70,48.11 53.17,45.03" />
            <polygon points="7.21,46.21 10.83,51.18 10.83,45.03 7.21,33.90 3.60,28.92 3.60,35.08" />
            <polygon points="37.85,56.16 26.15,56.16 20.30,58.06 26.15,59.96 37.85,59.96 43.70,58.06" />
            <polygon points="20.30,5.94 10.83,12.82 7.21,17.79 13.06,15.89 22.53,9.01 26.15,4.04" />
            <polygon points="37.85,4.04 41.47,9.01 50.94,15.89 56.79,17.79 53.17,12.82 43.70,5.94" />
            <polygon points="60.40,35.08 60.40,28.92 56.79,33.90 53.17,45.03 53.17,51.18 56.79,46.21" />
          </g>
        </g>
      </svg>
    </span>
  );
}
