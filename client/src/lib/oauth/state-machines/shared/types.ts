/**
 * Shared types for OAuth state machines
 */

/**
 * Action definition for sequence diagram
 * Used to build the visual representation of OAuth flow steps
 */
export interface DiagramAction {
  id: string;
  label: string;
  description: string;
  from: string;
  to: string;
  details?: Array<{ label: string; value: any }>;
}
