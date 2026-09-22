/**
 * Real-device smoke test against one running emulator (default emulator-5554):
 * discover -> display info -> stream (collect frames) -> tap -> text -> Back/
 * Home -> stop stream -> cleanup. Exits non-zero on any failure.
 *
 * Usage: pnpm smoke [serial]
 */
import { AdbAndroidAdapter } from "@lab/device-adapter";

const serial = process.argv[2] ?? "emulator-5554";
const adapter = new AdbAndroidAdapter({ maxTextLength: 512 });
const ref = { id: serial, adbSerial: serial };

function step(name: string): void {
  process.stdout.write(`\n== ${name}\n`);
}

async function main(): Promise<void> {
  step("discover");
  const devices = await adapter.discover();
  console.log(devices);
  if (!devices.some((d) => d.adbSerial === serial)) {
    throw new Error(
      `${serial} not found; start emulators first (make emulators)`,
    );
  }

  step("health");
  const health = await adapter.health(ref);
  console.log(health);
  if (!health.healthy) throw new Error("device unhealthy");

  step("displayInfo");
  const info = await adapter.displayInfo(ref);
  console.log(info);

  step("stream: collecting frames for 6s (tapping to force motion)");
  let frames = 0;
  let bytes = 0;
  let mode = "";
  const handle = await adapter.startStream(
    ref,
    (frame) => {
      frames += 1;
      bytes += frame.data.byteLength;
    },
    { mode: "auto", fps: 15, jpegQuality: 7 },
  );
  mode = handle.mode;
  // screenrecord only emits on content change; poke the screen while collecting
  for (let i = 0; i < 4; i++) {
    await adapter.key(ref, "HOME");
    await adapter.swipe(ref, { x: 360, y: 900 }, { x: 360, y: 400 }, 250);
    await new Promise((r) => setTimeout(r, 1200));
  }
  await handle.stop();
  console.log({ mode, frames, kilobytes: Math.round(bytes / 1024) });
  if (frames === 0) throw new Error("stream produced zero frames");

  step("tap center");
  await adapter.tap(
    ref,
    Math.floor(info.width / 2),
    Math.floor(info.height / 2),
  );

  step("type text");
  await adapter.typeText(ref, "hello lab 123");

  step("keys BACK + HOME");
  await adapter.key(ref, "BACK");
  await adapter.key(ref, "HOME");

  step("cleanup");
  await adapter.cleanup(ref);

  console.log("\nSMOKE OK");
}

main().catch((err) => {
  console.error("\nSMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
