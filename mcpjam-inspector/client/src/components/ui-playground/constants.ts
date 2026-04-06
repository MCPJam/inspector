/**
 * UI Playground Constants
 *
 * Centralized constants for magic numbers and configuration values
 * used throughout the UI Playground components.
 */

// Panel size configuration (percentages)
export const PANEL_SIZES = {
  LEFT: {
    DEFAULT: 30,
    /** Minimum % width when expanded; drag-to-hide uses `collapsible` → same strip as the hide button */
    MIN: 10,
    MAX: 40,
  },
  CENTER: {
    DEFAULT_WITH_PANELS: 70,
    DEFAULT_WITHOUT_PANELS: 100,
    MIN: 30,
  },
} as const;

// Animation/timing durations (milliseconds)
export const DURATIONS = {
  HIGHLIGHT_FLASH: 2000,
} as const;
