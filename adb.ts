import { execFile } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { homedir, platform } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

// execFile with encoding:"buffer" yields Buffers even on failure (err.stderr),
// and callers do .trim() on stderr — always normalize to a string.
const toStr = (x: unknown): string =>
  Buffer.isBuffer(x) ? x.toString("utf8") : String(x ?? "")

export interface AdbDevice {
  serial: string
  state: string
  model?: string
  product?: string
  device?: string
}

/**
 * Fold duplicate listings of the same physical phone: with wireless debugging
 * on, adb sees it twice — once via the direct TCP connection (`ip:port`) and
 * once via mDNS discovery (`adb-<serial>-<salt>._adb-tls-connect._tcp`).
 * Both entries carry the same model/product/device fields, so group on those
 * and prefer the direct TCP entry.
 */
export function dedupeDevices(devices: AdbDevice[]): AdbDevice[] {
  const online = devices.filter((d) => d.state === "device")
  if (online.length < 2) return devices
  const others = devices.filter((d) => d.state !== "device")
  const groups = new Map<string, AdbDevice[]>()
  for (const d of online) {
    const key = [d.model, d.product, d.device].map((v) => v ?? "").join("|")
    if (!key) continue
    const list = groups.get(key) ?? []
    list.push(d)
    groups.set(key, list)
  }
  const kept: AdbDevice[] = []
  for (const list of groups.values()) {
    if (list.length === 1) {
      kept.push(list[0])
      continue
    }
    const preferred = list.find((d) => d.serial.includes(":")) ?? list[0]
    kept.push(preferred)
  }
  return [...others, ...kept]
}

export interface RunResult {
  stdout: Buffer
  stderr: string
  code: number
}

function candidatePaths(adbPath?: string): string[] {
  const candidates: string[] = []
  if (adbPath) candidates.push(adbPath)
  const env = process.env
  for (const key of ["MOBILE_ADB_PATH", "ADB_PATH"]) {
    if (env[key]) candidates.push(env[key])
  }
  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    candidates.push(
      join(local, "Android", "Sdk", "platform-tools", "adb.exe"),
      join(local, "Programs", "scrcpy", "adb.exe"),
      join(homedir(), "platform-tools", "adb.exe"),
      join("C:", "Android", "platform-tools", "adb.exe"),
    )
  } else {
    candidates.push(
      "/usr/bin/adb",
      "/usr/local/bin/adb",
      join(homedir(), "Library", "Android", "sdk", "platform-tools", "adb"),
      join(homedir(), "Android", "Sdk", "platform-tools", "adb"),
    )
  }
  return candidates
}

export async function resolveAdb(adbPath?: string): Promise<string> {
  const direct = candidatePaths(adbPath).find((p) => existsSync(p))
  if (direct) return direct
  for (const entry of (process.env.PATH ?? "").split(platform() === "win32" ? ";" : ":")) {
    if (!entry) continue
    const candidate = join(entry, platform() === "win32" ? "adb.exe" : "adb")
    if (existsSync(candidate)) return candidate
  }
  if (platform() === "win32") {
    const winGet = join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages")
    if (existsSync(winGet)) {
      for (const pkg of readdirSync(winGet)) {
        if (!pkg.toLowerCase().includes("scrcpy")) continue
        const found = findAdbRecursive(join(winGet, pkg), 4)
        if (found) return found
      }
    }
  }
  throw new Error(
    "adb not found. Install Android platform-tools (winget install Google.PlatformTools) or scrcpy (winget install Genymobile.scrcpy), or set MOBILE_ADB_PATH in your config.",
  )
}

function findAdbRecursive(dir: string, depth: number): string | undefined {
  if (depth < 0) return undefined
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (entry === (platform() === "win32" ? "adb.exe" : "adb")) return full
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    try {
      if (statSync(full).isDirectory() && (isAbsolute(full) || full.startsWith(dir))) {
        const found = findAdbRecursive(full, depth - 1)
        if (found) return found
      }
    } catch {
      /* skip */
    }
  }
  return undefined
}

export async function runAdb(
  args: string[],
  opts: { adbPath?: string; serial?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  const adb = await resolveAdb(opts.adbPath)
  const fullArgs = opts.serial ? ["-s", opts.serial, ...args] : args
  try {
    const { stdout, stderr } = await execFileAsync(adb, fullArgs, {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      timeout: opts.timeoutMs ?? 30_000,
    })
    return { stdout, stderr: toStr(stderr), code: 0 }
  } catch (err: any) {
    const code = typeof err.code === "number" ? err.code : 1
    return {
      stdout: err.stdout ?? Buffer.alloc(0),
      stderr: toStr(err.stderr ?? String(err.message ?? err)),
      code,
    }
  }
}

export async function listDevices(
  adbPath?: string,
  timeoutMs = 5_000,
  raw = false,
): Promise<AdbDevice[]> {
  const result = await runAdb(["devices", "-l"], { adbPath, timeoutMs })
  const devices: AdbDevice[] = []
  for (const line of result.stdout.toString("utf8").split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue
    // mDNS rediscoveries append a counter to the service name that CONTAINS A
    // SPACE: `adb-RZGL61TDYQL-pAXli0 (2)._adb-tls-connect._tcp device ...`.
    // Splitting on whitespace breaks the serial. Instead, find the state token
    // (the first token that is a known adb state) and treat everything before
    // it as the serial.
    const tokens = line.trim().split(/\s+/)
    const stateIdx = tokens.findIndex((t) =>
      /^(device|offline|unauthorized|authorizing|connecting|recovery|sideload|bootloader|host|disconnected|no permissions)/.test(t),
    )
    if (stateIdx < 1) continue
    const serial = tokens.slice(0, stateIdx).join(" ")
    const state = tokens[stateIdx]
    const rest = tokens.slice(stateIdx + 1)
    if (!serial || serial === "*") continue
    const device: AdbDevice = { serial, state }
    for (const kv of rest) {
      const [key, value] = kv.split(":")
      if (!key || value === undefined) continue
      if (key === "model") device.model = value.replace(/_/g, " ")
      if (key === "product") device.product = value
      if (key === "device") device.device = value
    }
    devices.push(device)
  }
  return raw ? devices : dedupeDevices(devices)
}

export async function pickDevice(
  serial: string | undefined,
  adbPath?: string,
  timeoutMs = 5_000,
): Promise<{ serial: string; devices: AdbDevice[] }> {
  const devices = await listDevices(adbPath, timeoutMs)
  const available = devices.filter((d) => d.state === "device")
  if (serial) {
    const match = available.find((d) => d.serial === serial)
    if (!match) {
      const known = devices.find((d) => d.serial === serial)
      if (known) throw new Error(`Device ${serial} is ${known.state}. Is USB debugging authorized?`)
      throw new Error(`Device ${serial} not found. Connected devices: ${available.map((d) => d.serial).join(", ") || "none"}`)
    }
    return { serial, devices: available }
  }
  if (available.length === 0) {
    throw new Error(
      "No Android device connected. Plug in a phone with USB debugging enabled (or start an emulator), then retry.",
    )
  }
  if (available.length > 1) {
    throw new Error(
      `Multiple devices connected (${available.map((d) => d.serial).join(", ")}). Pass a serial to choose one.`,
    )
  }
  return { serial: available[0].serial, devices: available }
}

// ── input helpers ────────────────────────────────────────────────────────────

/** Escape text for `adb shell input text`: shell metacharacters get backslash-escaped, spaces become %s. */
export function escapeInputText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([&|;<>()$`"'*~])/g, "\\$1")
    .replace(/ /g, "%s")
}

/**
 * Set the device clipboard via `cmd clipboard set-primary-clip` (Android 13+;
 * Samsung ships it). The text travels base64 and is decoded ON-DEVICE so
 * Windows codepage mangling of non-ASCII argv can't corrupt it. Returns true
 * on success.
 */
export async function clipboardSet(
  serial: string,
  text: string,
  adbPath: string | undefined,
): Promise<boolean> {
  const b64 = Buffer.from(text, "utf8").toString("base64")
  const r = await runAdb(
    ["shell", "cmd", "clipboard", "set-primary-clip", "--text", `"$(printf %s ${b64} | base64 -d)"`],
    { serial, adbPath, timeoutMs: 10_000 },
  ).catch(() => null)
  if (!r) return false
  const out = `${r.stdout.toString("utf8")} ${r.stderr}`.toLowerCase()
  return r.code === 0 && !out.includes("no shell command") && !out.includes("error:")
}

export const KEYCODES: Record<string, number> = {
  home: 3,
  back: 4,
  call: 5,
  endcall: 6,
  "0": 7,
  "1": 8,
  "2": 9,
  "3": 10,
  "4": 11,
  "5": 12,
  "6": 13,
  "7": 14,
  "8": 15,
  "9": 16,
  dpad_up: 19,
  dpad_down: 20,
  dpad_left: 21,
  dpad_right: 22,
  center: 23,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  camera: 27,
  clear: 28,
  menu: 82,
  search: 84,
  enter: 66,
  tab: 61,
  space: 62,
  delete: 67,
  backspace: 67,
  escape: 111,
  app_switch: 187,
  recents: 187,
  wakeup: 224,
  paste: 279,
  media_play: 126,
  media_pause: 127,
  media_play_pause: 85,
  media_stop: 86,
  media_next: 87,
  media_previous: 88,
  headsethook: 79,
  ctrl_left: 113,
  shift_left: 59,
  alt_left: 57,
  meta_left: 117,
  "=": 70,
  ",": 55,
  ".": 56,
}

export function keycodeFor(key: string): number {
  const normalized = key.replace(/^KEYCODE_/i, "").toLowerCase()
  const code = KEYCODES[normalized]
  if (code === undefined) {
    throw new Error(
      `Unknown key "${key}". Use a friendly name (back, home, recents, menu, enter, power, volume_up, volume_down, dpad_up, tab, space, delete, escape, app_switch) or an Android KEYCODE name/number.`,
    )
  }
  return code
}

// ── UI dump parsing ──────────────────────────────────────────────────────────

export interface UiNode {
  text: string
  desc: string
  klass: string
  clickable: boolean
  bounds: [number, number, number, number] | null
}

export function parseUiDump(xml: string, maxNodes = 300): UiNode[] {
  const nodes: UiNode[] = []
  for (const m of xml.matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attrs = m[1]
    const get = (name: string) => {
      const am = new RegExp(`${name}="([^"]*)"`).exec(attrs)
      return am ? am[1] : ""
    }
    const text = get("text")
    const desc = get("content-desc")
    const klass = get("class")
    const clickable = get("clickable") === "true"
    if (!text && !desc && !clickable) continue
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(get("bounds"))
    nodes.push({
      text,
      desc,
      klass,
      clickable,
      bounds: b ? [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])] : null,
    })
    if (nodes.length >= maxNodes) break
  }
  return nodes
}
