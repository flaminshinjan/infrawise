import type { ChildProcess } from "node:child_process";
import {
  adbExec,
  adbExecBinary,
  adbExecNoSerial,
  adbSpawn,
  spawnProcess,
  AdbError,
  assertValidSerial,
} from "./exec.js";
// (adbExecBinary is used both by the screencap fallback loop and the
// first-frame primer in the screenrecord path)
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

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
const KEYCODES = { BACK: "4", HOME: "3" } as const;
/** screenrecord hard-caps a single recording; we restart before it ends. */
const SCREENRECORD_SEGMENT_SECONDS = 175;

export interface AdbAdapterOptions {
  /** package to force-stop during cleanup, if any */
  cleanupPackage?: string;
  maxTextLength?: number;
}

export class AdbAndroidAdapter implements DeviceAdapter {
  constructor(private readonly options: AdbAdapterOptions = {}) {}

  async connect(target: string): Promise<void> {
    if (!/^[A-Za-z0-9.\-_[\]:]+:\d{1,5}$/.test(target)) {
      throw new AdbError("invalid adb connect target", []);
    }
    await adbExecNoSerial(["connect", target], 8000);
  }

  async discover(): Promise<DiscoveredDevice[]> {
    const out = await adbExecNoSerial(["devices", "-l"]);
    const devices: DiscoveredDevice[] = [];
    for (const line of out.split("\n").slice(1)) {
      const match = line.trim().match(/^(\S+)\s+device(\s|$)/);
      if (!match || !match[1]) continue;
      const serial = match[1];
      devices.push({
        adbSerial: serial,
        kind: serial.startsWith("emulator-")
          ? "ANDROID_EMULATOR"
          : "ANDROID_PHYSICAL",
        model: line.match(/model:(\S+)/)?.[1],
      });
    }
    return devices;
  }

  async health(device: DeviceRef): Promise<DeviceHealth> {
    try {
      const boot = (
        await adbExec(
          device.adbSerial,
          ["shell", "getprop", "sys.boot_completed"],
          4000,
        )
      ).trim();
      const echo = (
        await adbExec(device.adbSerial, ["shell", "echo", "ok"], 4000)
      ).trim();
      const bootCompleted = boot === "1";
      const responsive = echo === "ok";
      return {
        healthy: bootCompleted && responsive,
        bootCompleted,
        responsive,
      };
    } catch (err) {
      return {
        healthy: false,
        bootCompleted: false,
        responsive: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async displayInfo(device: DeviceRef): Promise<DisplayInfo> {
    const out = await adbExec(device.adbSerial, ["shell", "wm", "size"]);
    // "Physical size: 720x1280" (optionally followed by "Override size: ...")
    const line =
      out.match(/Override size:\s*(\d+)x(\d+)/) ??
      out.match(/Physical size:\s*(\d+)x(\d+)/);
    if (!line)
      throw new AdbError(`cannot parse wm size output`, ["wm", "size"], out);
    return {
      width: Number(line[1]),
      height: Number(line[2]),
      rotation: 0, // lab devices are locked portrait; see README limitations
    };
  }

  async tap(device: DeviceRef, x: number, y: number): Promise<void> {
    assertIntCoord(x);
    assertIntCoord(y);
    await adbExec(device.adbSerial, [
      "shell",
      "input",
      "tap",
      String(x),
      String(y),
    ]);
  }

  async swipe(
    device: DeviceRef,
    from: Point,
    to: Point,
    durationMs: number,
  ): Promise<void> {
    for (const v of [from.x, from.y, to.x, to.y]) assertIntCoord(v);
    const dur = Math.max(20, Math.min(5000, Math.round(durationMs)));
    await adbExec(device.adbSerial, [
      "shell",
      "input",
      "swipe",
      String(from.x),
      String(from.y),
      String(to.x),
      String(to.y),
      String(dur),
    ]);
  }

  async typeText(device: DeviceRef, text: string): Promise<void> {
    const max = this.options.maxTextLength ?? 512;
    if (text.length === 0 || text.length > max) {
      throw new AdbError(`text length out of bounds (1..${max})`, []);
    }
    // `input text` supports printable ASCII only; reject the rest explicitly
    // rather than typing garbage.
    if (!/^[\x20-\x7e]+$/.test(text)) {
      throw new AdbError("text must be printable ASCII", []);
    }
    // adb shell re-parses arguments on the device-side shell, so the payload is
    // single-quoted with quote splicing; spaces use input's %s convention.
    const escaped = text.replace(/'/g, `'\\''`).replace(/ /g, "%s");
    await adbExec(
      device.adbSerial,
      ["shell", `input text '${escaped}'`],
      20_000,
    );
  }

  async key(device: DeviceRef, key: "BACK" | "HOME"): Promise<void> {
    await adbExec(device.adbSerial, [
      "shell",
      "input",
      "keyevent",
      KEYCODES[key],
    ]);
  }

  async cleanup(device: DeviceRef): Promise<void> {
    // Idempotent: dismiss any IME/dialog, go Home, optionally stop the demo app.
    await adbExec(device.adbSerial, [
      "shell",
      "input",
      "keyevent",
      KEYCODES.BACK,
    ]);
    await adbExec(device.adbSerial, [
      "shell",
      "input",
      "keyevent",
      KEYCODES.HOME,
    ]);
    if (this.options.cleanupPackage) {
      if (!/^[A-Za-z0-9._]+$/.test(this.options.cleanupPackage)) {
        throw new AdbError("invalid cleanup package name", []);
      }
      await adbExec(device.adbSerial, [
        "shell",
        "am",
        "force-stop",
        this.options.cleanupPackage,
      ]);
    }
  }

  async startStream(
    device: DeviceRef,
    onFrame: (frame: EncodedFrame) => void,
    options: StreamOptions,
  ): Promise<StreamHandle> {
    assertValidSerial(device.adbSerial);
    const display = await this.displayInfo(device);
    if (options.mode === "screencap") {
      return startScreencapLoop(device, display, onFrame, options);
    }
    try {
      return await startScreenrecordStream(device, display, onFrame, options);
    } catch (err) {
      if (options.mode === "screenrecord") throw err;
      return startScreencapLoop(device, display, onFrame, options);
    }
  }
}

function assertIntCoord(v: number): void {
  if (!Number.isInteger(v) || v < 0 || v > 100_000) {
    throw new AdbError(`invalid coordinate ${v}`, []);
  }
}

/**
 * Primary stream: `adb exec-out screenrecord` H.264 piped into ffmpeg, which
 * emits concatenated JPEGs (image2pipe/mjpeg). screenrecord only produces
 * frames when the screen content changes, so idle screens emit ~0 fps — the
 * consumer keeps showing the last frame.
 *
 * screenrecord caps a single recording at 180 s, so the adb side restarts on a
 * timer; one long-lived ffmpeg keeps decoding across segments because raw
 * Annex-B H.264 segments concatenate cleanly (each starts with SPS/PPS + IDR).
 */
async function startScreenrecordStream(
  device: DeviceRef,
  display: DisplayInfo,
  onFrame: (frame: EncodedFrame) => void,
  options: StreamOptions,
): Promise<StreamHandle> {
  let stopped = false;
  let adbProc: ChildProcess | null = null;
  let segmentTimer: NodeJS.Timeout | null = null;

  // NOTE: low-latency flags (-fflags nobuffer, -flags low_delay, -fps_mode
  // passthrough) silently produce zero output frames for a raw H.264 pipe on
  // ffmpeg 8; the plain demux/encode path streams reliably with ~1s startup.
  const ffmpeg = spawnProcess(FFMPEG, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "h264",
    "-i",
    "pipe:0",
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-strict",
    "unofficial",
    "-q:v",
    String(options.jpegQuality),
    "pipe:1",
  ]);
  ffmpeg.stderr?.on("data", () => void 0);

  const parser = new JpegStreamParser((data) => {
    onFrame({
      codec: "jpeg",
      width: display.width,
      height: display.height,
      capturedAt: Date.now(),
      data,
    });
  });
  ffmpeg.stdout?.on("data", (chunk: Buffer) => parser.push(chunk));

  const pids: number[] = [];
  if (ffmpeg.pid) pids.push(ffmpeg.pid);

  const startSegment = () => {
    if (stopped) return;
    adbProc = adbSpawn(device.adbSerial, [
      "exec-out",
      "screenrecord",
      "--output-format=h264",
      `--time-limit=${SCREENRECORD_SEGMENT_SECONDS}`,
      "--bit-rate",
      "6000000",
      "-",
    ]);
    if (adbProc.pid) pids.push(adbProc.pid);
    adbProc.stdout?.on("data", (chunk: Buffer) => {
      ffmpeg.stdin?.write(chunk);
    });
    adbProc.on("exit", (code) => {
      if (stopped) return;
      // Segment rollover (time limit) restarts immediately; a crash right
      // after start means screenrecord is unsupported -> surface as exit.
      startSegment();
      void code;
    });
    adbProc.on("error", () => {
      if (!stopped) options.onExit?.("adb spawn failed");
    });
  };

  // Fail fast if screenrecord is unsupported: wait briefly for either process
  // exit (bad) or survival (good).
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    startSegment();
    const probe = adbProc!;
    const timer = setTimeout(() => settle(resolve), 1500);
    probe.on("exit", (code) => {
      clearTimeout(timer);
      settle(() =>
        reject(
          new AdbError(`screenrecord exited immediately (code ${code})`, []),
        ),
      );
    });
  });

  ffmpeg.on("exit", () => {
    if (!stopped) options.onExit?.("ffmpeg exited");
  });

  // screenrecord emits frames only when content changes, so an idle screen
  // would show nothing at session start. Prime the stream with one screencap
  // so the viewer immediately sees the current screen.
  void adbExecBinary(device.adbSerial, ["exec-out", "screencap", "-p"], 15_000)
    .then((png) => {
      if (!stopped) {
        onFrame({
          codec: "png",
          width: display.width,
          height: display.height,
          capturedAt: Date.now(),
          data: png,
        });
      }
    })
    .catch(() => void 0);

  // Restart segments slightly before screenrecord's own cap; belt-and-braces
  // alongside the exit handler above.
  segmentTimer = setInterval(
    () => {
      adbProc?.kill("SIGTERM");
    },
    (SCREENRECORD_SEGMENT_SECONDS - 5) * 1000,
  );

  return {
    pids,
    mode: "screenrecord",
    async stop() {
      stopped = true;
      if (segmentTimer) clearInterval(segmentTimer);
      adbProc?.kill("SIGKILL");
      ffmpeg.stdin?.end();
      ffmpeg.kill("SIGKILL");
    },
  };
}

/** Fallback stream: periodic `screencap -p` PNGs. Slow (~1 fps) but universal. */
function startScreencapLoop(
  device: DeviceRef,
  display: DisplayInfo,
  onFrame: (frame: EncodedFrame) => void,
  options: StreamOptions,
): StreamHandle {
  let stopped = false;
  let consecutiveFailures = 0;
  const intervalMs = Math.max(200, Math.round(1000 / options.fps));

  const loop = async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        const png = await adbExecBinary(
          device.adbSerial,
          ["exec-out", "screencap", "-p"],
          15_000,
        );
        consecutiveFailures = 0;
        if (stopped) return;
        onFrame({
          codec: "png",
          width: display.width,
          height: display.height,
          capturedAt: started,
          data: png,
        });
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          if (!stopped) options.onExit?.("screencap failing repeatedly");
          return;
        }
      }
      const elapsed = Date.now() - started;
      await new Promise((r) =>
        setTimeout(r, Math.max(0, intervalMs - elapsed)),
      );
    }
  };
  void loop();

  return {
    pids: [],
    mode: "screencap",
    async stop() {
      stopped = true;
    },
  };
}

/**
 * Splits a concatenated JPEG byte stream into individual frames by scanning
 * for EOI (FFD9). Safe because within JPEG entropy-coded data FF is always
 * stuffed (FF00) or a restart marker (FFD0-D7), so FFD9 only terminates a frame.
 */
export class JpegStreamParser {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly onJpeg: (data: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buffer =
      this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let searchFrom = 0;
    for (;;) {
      const eoi = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), searchFrom);
      if (eoi === -1) break;
      const frame = this.buffer.subarray(0, eoi + 2);
      // Frames must start with SOI; anything else is resync garbage.
      if (frame[0] === 0xff && frame[1] === 0xd8) {
        this.onJpeg(Buffer.from(frame));
      }
      this.buffer = this.buffer.subarray(eoi + 2);
      searchFrom = 0;
    }
    // Bound memory if a frame never terminates (encoder wedged).
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = Buffer.alloc(0);
  }
}
