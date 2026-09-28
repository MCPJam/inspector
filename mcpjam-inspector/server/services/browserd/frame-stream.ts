/**
 * The daemon's frame stream, re-exported.
 *
 * THE CODEC MOVED to `shared/browserd-frame-stream.ts` in V-4b, and it moved
 * for one reason: the BROWSER now reads these records. Once the pane stopped
 * taking base64 in a JSON envelope and started taking the daemon's own bytes,
 * a decoder had to exist on both sides of the relay — and the failure mode of
 * two copies of a chunk-safe byte reader is not a compile error, it is a pane
 * that loses its place in a stream and can never find it again.
 *
 * This file stays because two dozen server modules import it by this path, and
 * because `bundle-freshness.test.ts` names it as one of the daemon bundle's
 * required inputs. Everything it exports is the shared module's.
 *
 * THE MOVE IS A DAEMON-GRAPH EDIT, and its cost is worth stating: it rotates
 * `bundleHash`. Before V-4a that meant every live hosted browser relaunched
 * mid-use on deploy. After V-4a it means each session reports
 * `upgradeAvailable` and relaunches the first moment nobody is holding the
 * lease, watching, or driving it — which is the whole reason V-4a comes first
 * in this wave.
 */
export {
  FRAME_STREAM_VERSION,
  FRAME_STREAM_VERSION_VIDEO,
  FRAME_STREAM_MAX_PAYLOAD_BY_KIND,
  FRAME_STREAM_HEADER_BYTES,
  FRAME_STREAM_KIND,
  FRAME_STREAM_MAX_PAYLOAD_BYTES,
  encodeFrameStreamRecord,
  createFrameStreamDecoder,
  type FrameStreamKind,
  type FrameStreamEndReason,
  type FrameStreamFrame,
  type FrameStreamHeartbeat,
  type FrameStreamStats,
  type FrameStreamEnd,
  type FrameStreamVideo,
  type FrameStreamRecord,
  type FrameStreamDecodeResult,
} from "../../../shared/browserd-frame-stream";
