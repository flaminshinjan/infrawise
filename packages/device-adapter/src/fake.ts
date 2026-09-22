import type {
  DeviceAdapter,
  DeviceHealth,
  DeviceRef,
  DiscoveredDevice,
  DisplayInfo,
  EncodedFrame,
  Point,
  StreamHandle,
  StreamOptions,
} from "./types.js";

export interface FakeInvocation {
  method: string;
  serial: string;
  args: unknown[];
  at: number;
}

interface FakeDeviceConfig {
  adbSerial: string;
  width?: number;
  height?: number;
  healthy?: boolean;
}

/**
 * Deterministic in-memory adapter for tests. Records every invocation and
 * allows injecting failures and latency per method.
 */
export class FakeAdapter implements DeviceAdapter {
  readonly invocations: FakeInvocation[] = [];
  private devices = new Map<string, Required<FakeDeviceConfig>>();
  private failures = new Map<string, Error>();
  private latencyMs = 0;
  private streams = new Map<
    string,
    { emit: (frame: EncodedFrame) => void; stopped: boolean }
  >();

  addDevice(config: FakeDeviceConfig): void {
    this.devices.set(config.adbSerial, {
      adbSerial: config.adbSerial,
      width: config.width ?? 720,
      height: config.height ?? 1280,
      healthy: config.healthy ?? true,
    });
  }

  setHealthy(serial: string, healthy: boolean): void {
    const d = this.devices.get(serial);
    if (d) d.healthy = healthy;
  }

  /** Make the named method throw for all devices until cleared. */
  failOn(method: string, error = new Error(`fake ${method} failure`)): void {
    this.failures.set(method, error);
  }

  clearFailure(method: string): void {
    this.failures.delete(method);
  }

  setLatency(ms: number): void {
    this.latencyMs = ms;
  }

  callsOf(method: string, serial?: string): FakeInvocation[] {
    return this.invocations.filter(
      (i) =>
        i.method === method && (serial === undefined || i.serial === serial),
    );
  }

  /** Push a synthetic frame into an active stream (for backpressure tests). */
  emitFrame(serial: string, frame: EncodedFrame): boolean {
    const stream = this.streams.get(serial);
    if (!stream || stream.stopped) return false;
    stream.emit(frame);
    return true;
  }

  private async invoke(
    method: string,
    serial: string,
    args: unknown[],
  ): Promise<void> {
    if (this.latencyMs > 0)
      await new Promise((r) => setTimeout(r, this.latencyMs));
    const failure = this.failures.get(method);
    if (failure) throw failure;
    if (serial && !this.devices.has(serial)) {
      throw new Error(`fake adapter: unknown device ${serial}`);
    }
    this.invocations.push({ method, serial, args, at: Date.now() });
  }

  async discover(): Promise<DiscoveredDevice[]> {
    await this.invoke("discover", "", []);
    return [...this.devices.values()].map((d) => ({
      adbSerial: d.adbSerial,
      kind: "ANDROID_EMULATOR",
    }));
  }

  async health(device: DeviceRef): Promise<DeviceHealth> {
    await this.invoke("health", device.adbSerial, []);
    const healthy = this.devices.get(device.adbSerial)?.healthy ?? false;
    return { healthy, bootCompleted: healthy, responsive: healthy };
  }

  async displayInfo(device: DeviceRef): Promise<DisplayInfo> {
    await this.invoke("displayInfo", device.adbSerial, []);
    const d = this.devices.get(device.adbSerial)!;
    return { width: d.width, height: d.height, rotation: 0 };
  }

  async startStream(
    device: DeviceRef,
    onFrame: (frame: EncodedFrame) => void,
    _options: StreamOptions,
  ): Promise<StreamHandle> {
    await this.invoke("startStream", device.adbSerial, []);
    const entry = { emit: onFrame, stopped: false };
    this.streams.set(device.adbSerial, entry);
    return {
      pids: [],
      mode: "screencap",
      stop: async () => {
        entry.stopped = true;
        this.invocations.push({
          method: "stopStream",
          serial: device.adbSerial,
          args: [],
          at: Date.now(),
        });
      },
    };
  }

  async tap(device: DeviceRef, x: number, y: number): Promise<void> {
    await this.invoke("tap", device.adbSerial, [x, y]);
  }

  async swipe(
    device: DeviceRef,
    from: Point,
    to: Point,
    durationMs: number,
  ): Promise<void> {
    await this.invoke("swipe", device.adbSerial, [from, to, durationMs]);
  }

  async typeText(device: DeviceRef, text: string): Promise<void> {
    await this.invoke("typeText", device.adbSerial, [text]);
  }

  async key(device: DeviceRef, key: "BACK" | "HOME"): Promise<void> {
    await this.invoke("key", device.adbSerial, [key]);
  }

  async cleanup(device: DeviceRef): Promise<void> {
    await this.invoke("cleanup", device.adbSerial, []);
  }
}
