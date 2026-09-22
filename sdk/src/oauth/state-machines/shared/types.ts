/**
 * Shared types for OAuth state machines
 */

/**
 * Action definition for sequence diagram
 * Used to build the visual representation of OAuth flow steps
 */
/** One `label: value` row under a diagram arrow. */
export interface DiagramDetail {
  label: string;
  value: any;
}

export interface DiagramAction {
  id: string;
  label: string;
  description: string;
  from: string;
  to: string;
  details?: DiagramDetail[];
}
