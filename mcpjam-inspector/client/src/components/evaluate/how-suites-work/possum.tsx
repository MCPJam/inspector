/**
 * Stand-in MCPJam possum holding a jam jar. No mascot art exists yet; this
 * file is the only place to swap when it does. Decorative, so it is hidden
 * from assistive tech. Raw colours are part of the drawing, not theme tokens.
 */
export function Possum({ size = 120 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 96 82"
      width={size}
      height={(size * 82) / 96}
      className="tut-bob shrink-0"
      aria-hidden="true"
    >
      <g className="tut-wave" style={{ transformOrigin: "20px 60px" }}>
        <path
          d="M20 60 C 6 60, 3 46, 12 43 C 18 41, 21 48, 16 50"
          fill="none"
          stroke="#F2A5A0"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </g>
      <ellipse cx="40" cy="58" rx="24" ry="18" fill="#9CA3AF" />
      <ellipse cx="44" cy="62" rx="14" ry="11" fill="#E5E7EB" />
      <ellipse cx="30" cy="75" rx="6" ry="3" fill="#F2A5A0" />
      <ellipse cx="50" cy="75" rx="6" ry="3" fill="#F2A5A0" />
      <circle cx="51" cy="21" r="6.5" fill="#2D2D2D" />
      <circle cx="51" cy="21" r="3.2" fill="#F2A5A0" />
      <circle cx="63" cy="18" r="6.5" fill="#2D2D2D" />
      <circle cx="63" cy="18" r="3.2" fill="#F2A5A0" />
      <path
        d="M44 33 C 44 20, 61 15, 70 23 C 76 28, 84 31, 89 34 C 85 39, 74 42, 65 42 C 53 43, 44 40, 44 33 Z"
        fill="#F5F5F4"
        stroke="#D4D4D8"
        strokeWidth="1"
      />
      <circle cx="65" cy="29" r="2.6" fill="#2D2D2D" />
      <circle cx="65.9" cy="28.1" r="0.9" fill="#FFFFFF" />
      <circle cx="89" cy="34" r="2.8" fill="#E86A8A" />
      <path
        d="M71 37 q4 3 8 0"
        fill="none"
        stroke="#2D2D2D"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <g transform="translate(60 47)">
        <rect x="1" y="0" width="13" height="4" rx="1.5" fill="#2D2D2D" />
        <rect
          x="0"
          y="3"
          width="15"
          height="16"
          rx="4"
          fill="#FBFBFB"
          stroke="#2D2D2D"
          strokeWidth="1.5"
        />
        <path
          d="M1 10 H14 V15 a3 3 0 0 1 -3 3 H4 a3 3 0 0 1 -3 -3 Z"
          fill="#F2735B"
        />
      </g>
      <path
        d="M55 55 q3 2 6 0"
        fill="none"
        stroke="#9CA3AF"
        strokeWidth="5"
        strokeLinecap="round"
      />
    </svg>
  );
}
