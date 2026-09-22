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
  // Keyed by the STREAMED resolution (half of each Pixel's real size, exact
  // same aspect ratio); `resolution` shows the model's real full-size spec.
  "720x1600": {
    name: "Pixel 8",
    resolution: "1080 × 2400",
    camera: "center",
    radius: 34,
  },
  "720x1560": {
    name: "Pixel 4a",
    resolution: "1080 × 2340",
    camera: "left",
    radius: 26,
  },
  "720x1440": {
    name: "Pixel 3",
    resolution: "1080 × 2160",
    camera: "none",
    radius: 22,
  },
  // full-size variants (local runs that skip the scaled profiles)
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
