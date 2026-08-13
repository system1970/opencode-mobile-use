import { execFile } from "node:child_process"
import net from "node:net"
import { promisify } from "node:util"
import { pickDevice, resolveAdb } from "./adb.ts"

const execFileAsync = promisify(execFile)

// Local adb server (already running â€” it's what `adb` clients talk to).
// Speaking its wire protocol directly avoids spawning adb.exe per frame
// (~30-50ms on Windows), leaving just a ~2ms TCP round-trip.
const ADB_SERVER_PORT = Number(process.env.ANDROID_ADB_SERVER_PORT ?? 5037)
let socketRetryAt = 0
let socketFails = 0

// Resolving the adb binary and listing devices spawns processes; cache both
// so a frame is a single `exec-out screencap` call. Re-resolve only on failure
// (device unplugged, adb restarted, etc.).
let cachedAdb: string | undefined
let cachedSerial: string | undefined

// Live-view display scaling: screencap encodes at the phone's logical
// resolution, so shrinking it makes each frame cheaper to produce and
// transfer. 1/3 of physical â‰ˆ 9x fewer pixels than full-res (the sidebar
// shows only 36x30 cells, so it stays oversampled). Lower = faster but softer
// in the enlarged viewer. Set once per device; remember what to restore it to.
const SCALE_DIVISOR = 1
let scaledSerial: string | undefined
let previousOverride: string | null = null
let scaleFailed = false

async function refreshCache(adbPath?: string) {
  const adb = await resolveAdb(adbPath)
  const { serial } = await pickDevice(undefined, adb, 4_000)
  // scaleFailed is per-device: a phone that rejects `wm size` must not be
  // retried every frame, but a different phone gets a fresh chance.
  if (serial !== cachedSerial) scaleFailed = false
  cachedAdb = adb
  cachedSerial = serial
}

/**
 * Halve the display resolution via `wm size` so screencap encodes ~4x fewer
 * pixels. Runs once per device; swallows errors (some ROMs disallow it) and
 * never retries a failed device until the serial changes.
 */
async function ensureScaled(): Promise<void> {
  if (SCALE_DIVISOR <= 1) {
    // Never scale — but undo any leftover override (from earlier sessions or
    // older plugin versions) once per device so the display stays native.
    if (!scaleFailed && scaledSerial !== cachedSerial && cachedAdb && cachedSerial) {
      try {
        const out = (
          await execFileAsync(cachedAdb, ["-s", cachedSerial, "shell", "wm", "size"], {
            encoding: "buffer",
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            timeout: 5_000,
          })
        ).stdout.toString("utf8")
        if (/Override size:/.test(out)) {
          await execFileAsync(cachedAdb, ["-s", cachedSerial, "shell", "wm", "size", "reset"], {
            encoding: "buffer",
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            timeout: 5_000,
          })
        }
        scaledSerial = cachedSerial
      } catch {
        scaleFailed = true
      }
    }
    return
  }
  if (scaleFailed || scaledSerial === cachedSerial) return
  try {
    const out = (
      await execFileAsync(cachedAdb!, ["-s", cachedSerial!, "shell", "wm", "size"], {
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        timeout: 5_000,
      })
    ).stdout.toString("utf8")
    const override = /Override size: (\d+)x(\d+)/.exec(out)
    const target = overrideTarget(out)
    if (!target) {
      scaleFailed = true
      return
    }
    previousOverride = override ? `${override[1]}x${override[2]}` : null
    if (previousOverride === target) {
      scaledSerial = cachedSerial
      return
    }
    await execFileAsync(cachedAdb!, ["-s", cachedSerial!, "shell", "wm", "size", target], {
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      timeout: 5_000,
    })
    scaledSerial = cachedSerial
  } catch {
    scaleFailed = true
  }
}

/** The scaled override for a `wm size` output, or null when unparseable.
 * Rounded to even dimensions — odd display sizes are flaky on some devices. */
function overrideTarget(out: string): string | null {
  const physical = /Physical size: (\d+)x(\d+)/.exec(out)
  if (!physical) return null
  const even = (n: number) => Math.round(n / 2) * 2
  return `${Math.max(160, even(Number(physical[1]) / SCALE_DIVISOR))}x${Math.max(320, even(Number(physical[2]) / SCALE_DIVISOR))}`
}

/** Capture the phone screen as raw PNG bytes via `adb exec-out screencap -p`. */
export async function capturePng(adbPath?: string): Promise<Buffer> {
  if (!cachedAdb || !cachedSerial) {
    await refreshCache(adbPath)
  }
  try {
    await ensureScaled()
    return await screencap()
  } catch (error) {
    cachedAdb = undefined
    cachedSerial = undefined
    await refreshCache(adbPath)
    await ensureScaled()
    return await screencap()
  }
}

/**
 * Restore the display to its pre-scaling resolution (`wm size reset` when the
 * phone had no override). Best-effort â€” swallows errors. Safe to call when
 * nothing was scaled.
 */
export async function restoreDisplay(): Promise<void> {
  const serial = scaledSerial
  const previous = previousOverride
  scaledSerial = undefined
  previousOverride = null
  scaleFailed = false
  if (!serial || !cachedAdb) return
  try {
    await execFileAsync(
      cachedAdb!,
      ["-s", serial, "shell", "wm", "size", previous ?? "reset"],
      { encoding: "buffer", maxBuffer: 4 * 1024 * 1024, windowsHide: true, timeout: 5_000 },
    )
  } catch {
    /* best-effort â€” the phone may already be gone */
  }
}

/**
 * One native-resolution frame (for the enlarged viewer): temporarily clears
 * the scaled override, captures, then re-applies it so the live loop stays
 * cheap. Throws when no device is being streamed.
 */
export async function captureFullRes(): Promise<Buffer> {
  const adb = cachedAdb
  const serial = cachedSerial
  if (!adb || !serial) throw new Error("No device connected")
  const wasScaled = scaledSerial === serial
  const previous = previousOverride
  if (wasScaled) {
    try {
      await execFileAsync(adb, ["-s", serial, "shell", "wm", "size", "reset"], {
        encoding: "buffer",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        timeout: 5_000,
      })
    } catch {
      /* capture anyway at whatever size the display reports */
    }
    scaledSerial = undefined
  }
  try {
    const { stdout } = await execFileAsync(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      timeout: 20_000,
    })
    if (!stdout || stdout.length === 0) throw new Error("screencap returned empty output")
    return stdout
  } finally {
    if (wasScaled) {
      try {
        const out = (
          await execFileAsync(adb, ["-s", serial, "shell", "wm", "size"], {
            encoding: "buffer",
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            timeout: 5_000,
          })
        ).stdout.toString("utf8")
        const target = previous ?? overrideTarget(out)
        if (target) {
          await execFileAsync(adb, ["-s", serial, "shell", "wm", "size", target], {
            encoding: "buffer",
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
            timeout: 5_000,
          })
        }
      } catch {
        /* the live loop re-scales on its own */
      }
      scaledSerial = serial
    }
  }
}

async function screencap(): Promise<Buffer> {
  if (Date.now() >= socketRetryAt) {
    try {
      return await socketScreencap()
    } catch {
      if (++socketFails >= 3) {
        socketRetryAt = Date.now() + 60_000
        socketFails = 0
      }
    }
  }
  const { stdout } = await execFileAsync(
    cachedAdb!,
    ["-s", cachedSerial!, "exec-out", "screencap", "-p"],
    {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  )
  if (!stdout || stdout.length === 0) throw new Error("screencap returned empty output")
  return stdout
}

// â”€â”€ raw adb-server protocol (fast path) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function hex4(s: string): string {
  return `${Buffer.byteLength(s, "utf8").toString(16).toUpperCase().padStart(4, "0")}${s}`
}

function connectAdbServer(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: ADB_SERVER_PORT })
    sock.setNoDelay(true)
    const onError = (err: Error) => {
      sock.off("connect", onConnect)
      reject(err)
    }
    const onConnect = () => {
      sock.off("error", onError)
      resolve(sock)
    }
    sock.once("connect", onConnect)
    sock.once("error", onError)
  })
}

function readExactly(sock: net.Socket, n: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let got = 0
    const cleanup = () => {
      clearTimeout(timer)
      sock.off("data", onData)
      sock.off("error", onError)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`adb: timed out reading ${n} bytes (got ${got})`))
    }, timeoutMs)
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      got += chunk.length
      if (got >= n) {
        cleanup()
        resolve(Buffer.concat(chunks).subarray(0, n))
      }
    }
    const onError = (err: Error) => {
      cleanup()
      reject(err)
    }
    sock.on("data", onData)
    sock.on("error", onError)
  })
}

async function adbServiceReply(sock: net.Socket, service: string): Promise<void> {
  sock.write(hex4(service))
  const head = await readExactly(sock, 4, 5_000)
  if (head.toString() === "OKAY") return
  const len = parseInt((await readExactly(sock, 4, 5_000)).toString(), 16)
  const msg = await readExactly(sock, len, 5_000)
  throw new Error(`adb ${service}: ${msg.toString()}`)
}

/** Screencap over the adb server socket. `exec:` output is raw (no PTY) and
 * byte-identical to `adb exec-out` on tested devices; some adbd versions
 * append an exit-code trailer, which is stripped if present. */
async function socketScreencap(): Promise<Buffer> {
  const sock = await connectAdbServer()
  try {
    await adbServiceReply(sock, `host:transport:${cachedSerial}`)
    await adbServiceReply(sock, "exec:screencap -p")
    const data: Buffer[] = []
    const body = await new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        sock.off("data", onData)
        sock.off("error", onError)
        sock.off("end", onEnd)
        sock.off("close", onEnd)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("adb: timed out waiting for screencap output"))
      }, 15_000)
      const onData = (chunk: Buffer) => {
        data.push(chunk)
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const onEnd = () => {
        cleanup()
        resolve(Buffer.concat(data))
      }
      sock.on("data", onData)
      sock.on("error", onError)
      sock.on("end", onEnd)
      sock.on("close", onEnd)
    })
    const trailer = /(\r?\n)ExitCode: -?\d+$/.exec(body.toString("latin1"))
    const stripped = trailer ? body.subarray(0, body.length - trailer[0].length) : body
    if (stripped.length === 0) throw new Error("screencap returned empty output")
    return stripped
  } finally {
    sock.destroy()
  }
}

/** Run a shell command over the adb server socket (no adb.exe spawn).
 * Returns stdout as text; throws on transport failure. */
export async function socketShell(serial: string, command: string): Promise<string> {
  const sock = await connectAdbServer()
  try {
    await adbServiceReply(sock, `host:transport:${serial}`)
    await adbServiceReply(sock, `exec:${command}`)
    const data: Buffer[] = []
    const body = await new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        sock.off("data", onData)
        sock.off("error", onError)
        sock.off("end", onEnd)
        sock.off("close", onEnd)
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("adb: timed out waiting for shell output"))
      }, 60_000)
      const onData = (chunk: Buffer) => {
        data.push(chunk)
      }
      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }
      const onEnd = () => {
        cleanup()
        resolve(Buffer.concat(data))
      }
      sock.on("data", onData)
      sock.on("error", onError)
      sock.on("end", onEnd)
      sock.on("close", onEnd)
    })
    const trailer = /(\r?\n)ExitCode: -?\d+$/.exec(body.toString("latin1"))
    const stripped = trailer ? body.subarray(0, body.length - trailer[0].length) : body
    return stripped.toString("utf8")
  } finally {
    sock.destroy()
  }
}

export function pngDataUri(png: Buffer): string {
  return `data:image/png;base64,${png.toString("base64")}`
}

/**
 * Cheap change detector: PNG signature + IHDR (dims) + total length plus a
 * probe of the IDAT payload near 1/4 and 3/4 into the file, so frames that
 * differ only in compressed content are still detected while identical
 * captures are skipped.
 */
export function pngSample(png: Buffer): string {
  const a = Math.min(1_024, png.length)
  const b = Math.min(1_024, Math.max(0, Math.floor(png.length * 0.25) - 512))
  const c = Math.min(1_024, Math.max(0, Math.floor(png.length * 0.75) - 512))
  return [
    png.subarray(0, a).toString("hex"),
    png.subarray(b, b + a).toString("hex"),
    png.subarray(c, c + a).toString("hex"),
    png.length,
  ].join(":")
}
