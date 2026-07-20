// Product-owned content ships with Inspector. Per-user state is added in the
// Home row after it is read from Convex.
export interface ProductUpdateDefinition {
  slug: string;
  publishAt: number;
  title: string;
  body: string;
  tag?: string;
  href?: string;
  videoUrl?: string;
  videoPosterUrl?: string;
  previewVideoUrl?: string;
  hideControls?: boolean;
  archived?: boolean;
}

// Shared type for the rendered product-updates feed. Kept in its own file so
// the hover card and expanded panel can import it without creating an import
// cycle through the Home row.
export interface ProductUpdateEntry extends ProductUpdateDefinition {
  dismissed: boolean;
  isNew: boolean;
}
