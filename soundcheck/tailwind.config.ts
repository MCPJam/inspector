import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"]
      },
      colors: {
        ink: {
          950: "#0a0a0c",
          900: "#0f0f12",
          850: "#14141a",
          800: "#1a1a22",
          750: "#20202a",
          700: "#2a2a36",
          600: "#3a3a48",
          500: "#5a5a68",
          400: "#7a7a85",
          300: "#9a9aa0",
          200: "#c4c4c6",
          100: "#e8e7e3",
          50: "#f5f4ef"
        },
        signal: {
          go: "#7fd99a",
          stop: "#f08d87",
          wait: "#e8c366",
          info: "#8cb4d8"
        }
      },
      keyframes: {
        "pulse-soft": {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.6", transform: "scale(0.85)" }
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" }
        }
      },
      animation: {
        "pulse-soft": "pulse-soft 1.6s ease-in-out infinite",
        "fade-up": "fade-up 0.5s ease-out both"
      }
    }
  },
  plugins: []
};

export default config;
