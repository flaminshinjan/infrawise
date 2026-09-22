import { execFile, spawn, type ChildProcess } from "node:child_process";

const ADB = process.env.ADB_PATH ?? "adb";

export class AdbError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr?: string,
  ) {
    super(message);
    this.name = "AdbError";
  }
}

/** Serial validation: adb serials are alphanumeric plus [-._:], e.g. emulator-5554 */
export function assertValidSerial(serial: string): void {
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(serial)) {
    throw new AdbError(`invalid adb serial`, []);
  }
}

/**
 * Run an adb command with an argument array (never a shell string) and a hard
 * timeout. Returns stdout as utf8.
 */
export function adbExec(
  serial: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<string> {
  assertValidSerial(serial);
  const fullArgs = ["-s", serial, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      ADB,
      fullArgs,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new AdbError(
              `adb ${args[0]} failed: ${err.message}`,
              fullArgs,
              stderr?.toString(),
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** Same but returns raw bytes (for exec-out screencap). */
export function adbExecBinary(
  serial: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<Buffer> {
  assertValidSerial(serial);
  const fullArgs = ["-s", serial, ...args];
  return new Promise((resolve, reject) => {
    execFile(
      ADB,
      fullArgs,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new AdbError(
              `adb ${args[0]} failed: ${err.message}`,
              fullArgs,
              stderr?.toString(),
            ),
          );
        } else {
          resolve(stdout as Buffer);
        }
      },
    );
  });
}

export function adbExecNoSerial(
  args: string[],
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ADB,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new AdbError(
              `adb failed: ${err.message}`,
              args,
              stderr?.toString(),
            ),
          );
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/** Spawn a long-lived adb subprocess (streaming); caller owns lifecycle. */
export function adbSpawn(serial: string, args: string[]): ChildProcess {
  assertValidSerial(serial);
  return spawn(ADB, ["-s", serial, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function spawnProcess(cmd: string, args: string[]): ChildProcess {
  return spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
}
