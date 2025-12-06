/**
 * UI Playground Constants
 *
 * Centralized constants for magic numbers and configuration values
 * used throughout the UI Playground components.
 */

// Panel size configuration (percentages)
export const PANEL_SIZES = {
  LEFT: {
    DEFAULT: 25,
    MIN: 15,
    MAX: 40,
  },
  CENTER: {
    DEFAULT_WITH_PANELS: 45,
    DEFAULT_WITHOUT_PANELS: 70,
    MIN: 30,
  },
  RIGHT: {
    DEFAULT: 30,
    MIN: 20,
    MAX: 50,
  },
} as const;

// Animation/timing durations (milliseconds)
export const DURATIONS = {
  HIGHLIGHT_FLASH: 2000,
} as const;
