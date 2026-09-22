/**
 * Cosmetic device profiles: map a streamed resolution to a Pixel model so the
 * phone frame shows the right proportions, camera cutout, and label. The lab
 * sets each emulator to a real Pixel resolution (scripts/apply-device-profiles),
 * and the app reads width/height from `adb wm size`, so these line up
 * automatically. Unknown resolutions fall back to a generic frame built from
 * the actual aspect ratio.
 */

export type CameraStyle = "center" | "left" | "none";

export interface DeviceProfile {
  name: string;
  /** real screen resolution this profile represents */
  resolution: string;
  camera: CameraStyle;
  /** CSS aspect-ratio value "w / h" */
  aspect: string;
  /** screen corner radius in px (visual) */
  radius: number;
}

const KNOWN: Record<string, Omit<DeviceProfile, "aspect">> = {
  "1080x2400": {
    name: "Pixel 8",
    resolution: "1080 × 2400",
    camera: "center",
    radius: 34,
  },
  "1080x2340": {
    name: "Pixel 4a",
    resolution: "1080 × 2340",
    camera: "left",
    radius: 26,
  },
  "1080x2160": {
    name: "Pixel 3",
    resolution: "1080 × 2160",
    camera: "none",
    radius: 22,
  },
  "1440x3120": {
    name: "Pixel 7 Pro",
    resolution: "1440 × 3120",
    camera: "center",
    radius: 40,
  },
  "1344x2992": {
    name: "Pixel 9 Pro XL",
    resolution: "1344 × 2992",
    camera: "center",
    radius: 40,
  },
  "720x1280": {
    name: "Emulator",
    resolution: "720 × 1280",
    camera: "center",
    radius: 30,
  },
};

export function resolveProfile(width: number, height: number): DeviceProfile {
  const key = `${width}x${height}`;
  const aspect = `${width} / ${height}`;
  const known = KNOWN[key];
  if (known) return { ...known, aspect };
  // generic: taller than ~19:9 gets a center punch-hole, else a plain bezel
  const ratio = height / width;
  return {
    name: "Android device",
    resolution: `${width} × ${height}`,
    camera: ratio >= 2.1 ? "center" : "none",
    aspect,
    radius: 30,
  };
}
