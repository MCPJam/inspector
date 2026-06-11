// Shared type for the productUpdates feed. Kept in its own file so the
// hover card and expanded panel can both import without creating an
// import cycle through the row component that fetches them.
export interface ProductUpdateEntry {
  _id: string;
  slug: string;
  publishAt: number;
  title: string;
  body: string;
  tag?: string;
  href?: string;
  videoUrl?: string;
  videoPosterUrl?: string;
  previewVideoUrl?: string;
  dismissed: boolean;
  isNew: boolean;
}
