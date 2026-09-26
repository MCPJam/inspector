import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactImage } from "@/components/ui/artifact-image";
import {
  registerArtifactUrls,
  resetArtifactUrlsForTests,
  useArtifactUrlEpoch,
} from "@/lib/artifact-urls";

function signedImageUrl(storageId: string, expiresAtSeconds: number) {
  const encode = (value: string) =>
    btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const body = encode(
    JSON.stringify({ v: 1, s: storageId, k: "image", e: expiresAtSeconds }),
  );
  return `https://test.convex.site/web/artifact?t=${body}.${encode("sig")}`;
}

beforeEach(() => {
  resetArtifactUrlsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ArtifactImage", () => {
  it("shows the freshest known link and swaps in a fresher one without remounting", () => {
    const stale = signedImageUrl("kg-shot", 1_800_000_000);
    render(<ArtifactImage src={stale} alt="step screenshot" />);
    const img = screen.getByAltText("step screenshot");
    expect(img.getAttribute("src")).toBe(stale);

    const fresh = signedImageUrl("kg-shot", 1_800_003_600);
    act(() => registerArtifactUrls({ screenshotUrl: fresh }));
    expect(screen.getByAltText("step screenshot")).toBe(img);
    expect(img.getAttribute("src")).toBe(fresh);
  });

  it("asks for fresh links when an artifact image fails, and still calls onError", () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useArtifactUrlEpoch());
    render(
      <ArtifactImage
        src={signedImageUrl("kg-shot", 1_800_000_000)}
        alt="render"
        onError={onError}
      />,
    );
    act(() => {
      fireEvent.error(screen.getByAltText("render"));
    });
    expect(result.current).toEqual(expect.any(Number));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("lets an image that loaded ask for a fresh link again, and still calls onLoad (MJ-005)", () => {
    // Two hours before the link expires, so each failure spends the image's
    // one renewal; the clock steps past the refresh throttle between them.
    let now = (1_800_000_000 - 7_200) * 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const onLoad = vi.fn();
    const { result } = renderHook(() => useArtifactUrlEpoch());
    render(
      <ArtifactImage
        src={signedImageUrl("kg-shot", 1_800_000_000)}
        alt="render"
        onLoad={onLoad}
      />,
    );
    const img = screen.getByAltText("render");

    act(() => {
      fireEvent.error(img);
    });
    const first = result.current;
    expect(first).toEqual(expect.any(Number));

    now += 60_000;
    act(() => {
      fireEvent.error(img);
    });
    expect(result.current).toBe(first);

    act(() => {
      fireEvent.load(img);
    });
    expect(onLoad).toHaveBeenCalledTimes(1);

    now += 60_000;
    act(() => {
      fireEvent.error(img);
    });
    expect(result.current).toBeGreaterThan(first!);
  });

  it("behaves like a plain image for any other source", () => {
    const { result } = renderHook(() => useArtifactUrlEpoch());
    render(<ArtifactImage src="https://example.com/logo.png" alt="logo" />);
    act(() => {
      fireEvent.error(screen.getByAltText("logo"));
    });
    expect(screen.getByAltText("logo").getAttribute("src")).toBe(
      "https://example.com/logo.png",
    );
    expect(result.current).toBeUndefined();
  });
});
