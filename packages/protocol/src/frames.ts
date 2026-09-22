/**
 * Binary frame wire format (WebSocket binary messages, server -> client).
 *
 * Fixed 24-byte little-endian header followed by the encoded image payload:
 *
 *   offset  size  field
 *   0       u8    protocol version (1)
 *   1       u8    codec (1 = JPEG, 2 = PNG)
 *   2       u16   width  (device pixels)
 *   4       u16   height (device pixels)
 *   6       u16   reserved (0)
 *   8       u32   frame sequence (per stream, monotonically increasing)
 *   12      u32   lease fence of the producing session
 *   16      f64   capture timestamp (ms since epoch, server clock)
 */
export const FRAME_HEADER_BYTES = 24;
export const FRAME_PROTOCOL_VERSION = 1;

export const FrameCodec = {
  JPEG: 1,
  PNG: 2,
} as const;
export type FrameCodecId = (typeof FrameCodec)[keyof typeof FrameCodec];

export interface FrameMeta {
  codec: FrameCodecId;
  width: number;
  height: number;
  seq: number;
  fence: number;
  capturedAt: number;
}

export function encodeFrame(meta: FrameMeta, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buf.buffer);
  view.setUint8(0, FRAME_PROTOCOL_VERSION);
  view.setUint8(1, meta.codec);
  view.setUint16(2, meta.width, true);
  view.setUint16(4, meta.height, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, meta.seq, true);
  view.setUint32(12, meta.fence, true);
  view.setFloat64(16, meta.capturedAt, true);
  buf.set(payload, FRAME_HEADER_BYTES);
  return buf;
}

export function decodeFrameHeader(data: ArrayBuffer): FrameMeta | null {
  if (data.byteLength < FRAME_HEADER_BYTES) return null;
  const view = new DataView(data);
  if (view.getUint8(0) !== FRAME_PROTOCOL_VERSION) return null;
  return {
    codec: view.getUint8(1) as FrameCodecId,
    width: view.getUint16(2, true),
    height: view.getUint16(4, true),
    seq: view.getUint32(8, true),
    fence: view.getUint32(12, true),
    capturedAt: view.getFloat64(16, true),
  };
}
