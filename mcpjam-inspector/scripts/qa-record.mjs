/**
 * Record a Playwright page as a short video for a QA result.
 *
 *   import { startRecording } from "<repo>/mcpjam-inspector/scripts/qa-record.mjs";
 *   const recording = await startRecording(page);
 *   // …the steps a reviewer should see…
 *   const { path } = await recording.stop("/tmp/qa/echo.mp4");
 *
 * Playwright's own `recordVideo` captures this app as blank white frames, so
 * this records with the Chrome DevTools screencast and encodes the frames in a
 * Chrome page with MediaRecorder, which needs no ffmpeg. Encoding replays the
 * frames in real time, so keep clips to the steps that matter (under a minute).
 * The result is MP4 where Chrome can encode it, WebM otherwise.
 */

import { writeFileSync } from "node:fs";

export async function startRecording(
  page,
  { quality = 70, maxWidth = 1400 } = {},
) {
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  let stopped = false;
  let ackError = null;
  cdp.on("Page.screencastFrame", async (frame) => {
    frames.push({ data: frame.data, timestamp: frame.metadata.timestamp });
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    } catch (error) {
      // An ack racing the stop is harmless; any other failure stalls frames.
      if (!stopped) ackError = error;
    }
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality,
    maxWidth,
    everyNthFrame: 1,
  });

  return {
    async stop(outPath) {
      stopped = true;
      await cdp.send("Page.stopScreencast");
      await cdp.detach();
      if (frames.length === 0) {
        throw new Error(
          `No frames were captured${ackError ? ` (${ackError.message})` : ""}; the page may not have been painting.`,
        );
      }
      const encoder = await page.context().newPage();
      try {
        await encoder.bringToFront();
        const { base64, mimeType } = await encoder.evaluate(
          encodeFrames,
          frames,
        );
        const path = mimeType.startsWith("video/webm")
          ? outPath.replace(/\.mp4$/, ".webm")
          : outPath;
        writeFileSync(path, Buffer.from(base64, "base64"));
        return {
          path,
          mimeType,
          frames: frames.length,
          seconds: frames.at(-1).timestamp - frames[0].timestamp,
        };
      } finally {
        await encoder.close();
        await page.bringToFront();
      }
    },
  };
}

/** Runs in the encoder page: draws each frame at its time into a recorded canvas. */
async function encodeFrames(frames) {
  const bitmap = async (data) =>
    createImageBitmap(
      await (await fetch(`data:image/jpeg;base64,${data}`)).blob(),
    );
  const first = await bitmap(frames[0].data);
  const canvas = document.createElement("canvas");
  canvas.width = first.width;
  canvas.height = first.height;
  document.body.append(canvas);
  const context = canvas.getContext("2d");
  context.drawImage(first, 0, 0);
  const mimeType = [
    "video/mp4;codecs=avc1.640028",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm",
  ].find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(canvas.captureStream(30), {
    mimeType,
    videoBitsPerSecond: 4_000_000,
  });
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const finished = new Promise((done) => {
    recorder.onstop = done;
  });
  recorder.start(250);
  const startedAt = performance.now();
  for (let i = 1; i < frames.length; i += 1) {
    const image = await bitmap(frames[i].data);
    const due = (frames[i].timestamp - frames[0].timestamp) * 1000;
    const wait = due - (performance.now() - startedAt);
    if (wait > 0) await new Promise((done) => setTimeout(done, wait));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  // Hold the last frame long enough to be seen.
  await new Promise((done) => setTimeout(done, 750));
  recorder.stop();
  await finished;
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { base64: btoa(binary), mimeType };
}
