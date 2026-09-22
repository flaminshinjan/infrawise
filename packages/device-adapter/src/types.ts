import type { DeviceKind } from "@lab/protocol";

export interface DeviceRef {
  id: string;
  adbSerial: string;
}

export interface DiscoveredDevice {
  adbSerial: string;
  kind: DeviceKind;
  model?: string;
}

export interface DeviceHealth {
  healthy: boolean;
  bootCompleted: boolean;
  responsive: boolean;
  detail?: string;
}

export interface DisplayInfo {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface EncodedFrame {
  codec: "jpeg" | "png";
  width: number;
  height: number;
  capturedAt: number;
  data: Uint8Array;
}

export interface StreamHandle {
  /** OS pids of capture subprocesses, persisted for orphan cleanup after kill -9 */
  pids: number[];
  mode: "screenrecord" | "screencap";
  stop(): Promise<void>;
}

export interface Point {
  x: number;
  y: number;
}

export interface StreamOptions {
  mode: "auto" | "screenrecord" | "screencap";
  fps: number;
  jpegQuality: number;
  onExit?: (reason: string) => void;
}

export interface DeviceAdapter {
  discover(): Promise<DiscoveredDevice[]>;
  /** Attach a TCP device (host:port), e.g. a tunneled emulator or remote phone. */
  connect?(target: string): Promise<void>;
  health(device: DeviceRef): Promise<DeviceHealth>;
  displayInfo(device: DeviceRef): Promise<DisplayInfo>;
  startStream(
    device: DeviceRef,
    onFrame: (frame: EncodedFrame) => void,
    options: StreamOptions,
  ): Promise<StreamHandle>;
  tap(device: DeviceRef, x: number, y: number): Promise<void>;
  swipe(
    device: DeviceRef,
    from: Point,
    to: Point,
    durationMs: number,
  ): Promise<void>;
  typeText(device: DeviceRef, text: string): Promise<void>;
  key(device: DeviceRef, key: "BACK" | "HOME"): Promise<void>;
  launch(device: DeviceRef, app: string): Promise<void>;
  cleanup(device: DeviceRef): Promise<void>;
}
