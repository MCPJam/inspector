import type { ImgHTMLAttributes, SyntheticEvent } from "react";
import {
  handleArtifactMediaError,
  handleArtifactMediaLoad,
  useFreshArtifactUrl,
} from "@/lib/artifact-urls";

type ArtifactImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
  alt: string;
};

/**
 * An `<img>` for an artifact link (a screenshot, a recorded render). It always
 * shows the freshest known link for the image, and when the link has expired
 * it asks the queries that minted it to re-run; the new link replaces the old
 * one without a reload. Any other `src` behaves exactly like a plain `<img>`.
 */
export function ArtifactImage({
  src,
  alt,
  onError,
  onLoad,
  ...rest
}: ArtifactImageProps) {
  const freshSrc = useFreshArtifactUrl(src);
  return (
    <img
      {...rest}
      src={freshSrc}
      alt={alt}
      onError={(event: SyntheticEvent<HTMLImageElement>) => {
        handleArtifactMediaError(freshSrc);
        onError?.(event);
      }}
      onLoad={(event: SyntheticEvent<HTMLImageElement>) => {
        handleArtifactMediaLoad(freshSrc);
        onLoad?.(event);
      }}
    />
  );
}
