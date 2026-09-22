import type { NormalizedPoint } from "./messages.js";

/**
 * Client-side: convert a pointer position inside the viewport container into
 * normalized device-content coordinates, removing letterbox offsets.
 * Returns null when the pointer is outside the rendered device content.
 */
export function pointerToNormalized(
  pointerX: number,
  pointerY: number,
  containerWidth: number,
  containerHeight: number,
  deviceWidth: number,
  deviceHeight: number,
): NormalizedPoint | null {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    deviceWidth <= 0 ||
    deviceHeight <= 0
  ) {
    return null;
  }
  const scale = Math.min(
    containerWidth / deviceWidth,
    containerHeight / deviceHeight,
  );
  const renderedWidth = deviceWidth * scale;
  const renderedHeight = deviceHeight * scale;
  const offsetX = (containerWidth - renderedWidth) / 2;
  const offsetY = (containerHeight - renderedHeight) / 2;

  const x = (pointerX - offsetX) / renderedWidth;
  const y = (pointerY - offsetY) / renderedHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * Server-side: convert normalized content coordinates to integer device pixels.
 * Rotation is applied here so a portrait-normalized point lands on the right
 * physical pixel; the initial implementation locks emulators to rotation 0.
 */
export function normalizedToDevice(
  point: NormalizedPoint,
  deviceWidth: number,
  deviceHeight: number,
  rotation: 0 | 90 | 180 | 270 = 0,
): { x: number; y: number } {
  const clamp = (v: number, max: number) =>
    Math.min(max - 1, Math.max(0, Math.round(v * max)));
  let nx = point.x;
  let ny = point.y;
  switch (rotation) {
    case 90:
      [nx, ny] = [point.y, 1 - point.x];
      break;
    case 180:
      [nx, ny] = [1 - point.x, 1 - point.y];
      break;
    case 270:
      [nx, ny] = [1 - point.y, point.x];
      break;
  }
  return { x: clamp(nx, deviceWidth), y: clamp(ny, deviceHeight) };
}
