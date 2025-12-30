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
    MIN: 0,
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
