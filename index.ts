import { Plugin } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  clipboardSet,
  escapeInputText,
  keycodeFor,
  parseUiDump,
  pickDevice,
  runAdb,
  type RunResult,
} from "./adb.ts"
import { annotateScreenshot, decodePng, downscale, encodePng } from "./annotate.ts"
import { socketShell } from "./capture.ts"
import { renderPlaceholderPng } from "./placeholder.ts"
import { SKILLS } from "./skills.ts"

const noArgsSchema = { type: "object", properties: {}, additionalProperties: false }

// ── dump freshness cache ────────────────────────────────────────────────────
// uiautomator dump costs ~2.4s (device-side idle wait). The agent's loop calls
// dump repeatedly; when no mutating action happened since the last dump and
// the cache is fresh (<15s), the screen is unchanged — serve the cached
// hierarchy instantly.
let dumpCache: { serial: string; at: number; focus: string; xml: string } | null = null
let lastActionAt = 0

function markAction(): void {
  lastActionAt = Date.now()
}

// ── UI dump resilience ─────────────────────────────────────────────────────
// `uiautomator dump` fails on three fronts: continuously-animating screens
// (it waits for the UI to reach "idle" and can hang forever), stale
// uiautomator processes that poison later attempts, and huge Compose/WebView
// trees that outlive fixed timeouts. These helpers address all three.

const ANIMATION_SETTINGS = [
  "window_animation_scale",
  "transition_animation_scale",
  "animator_duration_scale",
]

async function getAnimationScales(
  serial: string,
  adbPath: string | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    ANIMATION_SETTINGS.map(async (k) => {
      const r = await runAdb(["shell", "settings", "get", "global", k], {
        serial,
        adbPath,
        timeoutMs: 8_000,
      }).catch(() => null)
      out[k] = (r?.stdout.toString("utf8") ?? "").trim()
    }),
  )
  return out
}

async function setAnimationScales(
  serial: string,
  adbPath: string | undefined,
  scales: Record<string, string>,
): Promise<void> {
  await Promise.all(
    ANIMATION_SETTINGS.map((k) =>
      runAdb(["shell", "settings", "put", "global", k, scales[k] || "0"], {
        serial,
        adbPath,
        timeoutMs: 8_000,
      }).catch(() => null),
    ),
  )
}

async function killStaleUiAutomator(
  serial: string,
  adbPath: string | undefined,
): Promise<void> {
  // `[u]iautomator` bracket trick so pkill doesn't match our own shell's
  // command line and kill the session it is running in.
  await runAdb(["shell", "pkill -f '[u]iautomator'; killall uiautomator 2>/dev/null; true"], {
    serial,
    adbPath,
    timeoutMs: 10_000,
  }).catch(() => {})
}


function renderDump(
  chosen: string,
  focusLine: string,
  xml: string,
  maxNodes: number | undefined,
  annotate: boolean | undefined,
  cached: boolean,
  adbPath: string | undefined,
): any {
  const nodes = parseUiDump(xml, maxNodes ?? 300)
  if (nodes.length === 0) {
    return textResult(
      "No tappable/visible elements found in the UI dump. Take a screenshot to see what is actually on screen (the screen may be off, locked, or showing an animation).",
    )
  }
  const lines = nodes.map((n, i) => {
    const parts = [
      `#${i}`,
      n.bounds ? `[${n.bounds.join(",")}]` : "[no-bounds]",
      n.text ? `text="${n.text}"` : null,
      n.desc ? `desc="${n.desc}"` : null,
      n.klass.replace(/^android\.widget\./, "") || null,
      n.clickable ? "clickable" : null,
    ]
      .filter(Boolean)
      .join(" ")
    return parts
  })
  const note = cached ? "\n(cached — screen unchanged since the last dump)" : ""
  const text = textResult(
    `Focused window: ${focusLine}${note}\nUI elements (${nodes.length}) on ${chosen}:\n${lines.join("\n")}\n\nIf the elements don't match the focused window, the dump may be stale — retry. Tap the center of an element's bounds. For example [100,200,500,300] → tap 300 250.`,
  )
  if (!annotate) return text
  return (async () => {
    const shot = await runAdb(["exec-out", "screencap", "-p"], { serial: chosen, adbPath, timeoutMs: 15_000 })
    if (shot.code !== 0 || shot.stdout.length === 0) return text
    try {
      const annotated = annotateScreenshot(
        shot.stdout,
        nodes.map((n) => (n.bounds ? { left: n.bounds[0], top: n.bounds[1], right: n.bounds[2], bottom: n.bounds[3] } : null)),
      )
      const dir = join(tmpdir(), "opencode-mobile-use")
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `ui-annotated-${chosen.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${Date.now()}.png`)
      writeFileSync(file, annotated)
      return {
        content: [
          ...text.content,
          {
            type: "file",
            uri: pathToFileURL(file).href,
            mime: "image/png",
            name: "phone-ui-annotated.png",
          },
        ],
      }
    } catch {
      return text
    }
  })()
}

const serialSchema = {
  serial: {
    type: "string",
    description: "ADB serial of the device (optional when exactly one device is connected)",
  },
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

async function runOrThrow(
  args: string[],
  opts: { adbPath?: string; serial: string; timeoutMs?: number },
  label: string,
): Promise<RunResult> {
  const result = await runAdb(args, opts)
  if (result.code !== 0) {
    throw new Error(`${label} failed (exit ${result.code}): ${String(result.stderr ?? "").trim() || "no error output"}`)
  }
  return result
}

// ── Unicode typing via ADBKeyboard ─────────────────────────────────────────
// https://github.com/senzhk/ADBKeyBoard — a virtual IME that receives text via
// broadcasts. ADB_INPUT_B64 (base64 payload) avoids every shell-quoting pitfall
// and supports full Unicode. The user's real keyboard is restored afterwards.
const ADB_IME = "com.android.adbkeyboard/.AdbIME"

async function typeWithAdbKeyboard(
  text: string,
  serial: string,
  adbPath: string | undefined,
): Promise<boolean> {
  const imes = await runAdb(["shell", "ime", "list", "-s"], { serial, adbPath, timeoutMs: 10_000 }).catch(() => null)
  if (!imes || !imes.stdout.toString("utf8").includes(ADB_IME)) return false
  const current = (
    await runAdb(["shell", "settings", "get", "secure", "default_input_method"], {
      serial,
      adbPath,
      timeoutMs: 10_000,
    }).catch(() => null)
  )?.stdout.toString("utf8").trim()
  const wasAdb = current === ADB_IME
  if (!wasAdb) {
    const set = await runAdb(["shell", "ime", "set", ADB_IME], { serial, adbPath, timeoutMs: 10_000 }).catch(() => null)
    if (!set || set.code !== 0) return false
  }
  // Wait for the framework to bind the new IME AND serve an input connection
  // to the focused view (mServedView non-null). NEVER tap: switching the IME
  // changes the keyboard height, which MOVES the focused field — a tap at
  // pre-switch coordinates hits whatever is there now (e.g. a sticker).
  // Note: Samsung's dumpsys input_method has NO mCurMethodId line (session
  // hash instead) — poll `default_input_method` (what `ime set` writes) plus
  // mServedView.
  let ready = false
  for (let i = 0; i < 7; i++) {
    const [m, s] = await Promise.all([
      runAdb(["shell", "settings", "get", "secure", "default_input_method"], {
        serial,
        adbPath,
        timeoutMs: 10_000,
      }).catch(() => null),
      runAdb(["shell", "dumpsys", "input_method", "|", "grep", "mServedView"], {
        serial,
        adbPath,
        timeoutMs: 10_000,
      }).catch(() => null),
    ])
    const bound = m?.stdout.toString("utf8").trim() === ADB_IME
    const served = /mServedView[=:]\s*(?!null)/.test(s?.stdout.toString("utf8") ?? "")
    if (bound && served) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  if (!ready) return false
  const b64 = Buffer.from(text, "utf8").toString("base64")
  const r = await runAdb(
    ["shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", b64],
    { serial, adbPath, timeoutMs: 10_000 },
  ).catch(() => null)
  if (!wasAdb && current) {
    await runAdb(["shell", "ime", "set", current], { serial, adbPath, timeoutMs: 10_000 }).catch(() => {})
    // Let the layout settle back before the agent's next action.
    for (let i = 0; i < 5; i++) {
      const m = await runAdb(["shell", "settings", "get", "secure", "default_input_method"], {
        serial,
        adbPath,
        timeoutMs: 10_000,
      }).catch(() => null)
      if (m?.stdout.toString("utf8").trim() === current) break
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  return !!r && r.code === 0
}

export default Plugin.define({
  id: "mobile.use",
  setup: async (ctx) => {
    const adbPath =
      typeof ctx.options?.adbPath === "string" ? ctx.options.adbPath : undefined

    const pick = (serial?: string) => pickDevice(serial, adbPath)

    // ── phone-vision subagent ────────────────────────────────────────────────
    // The agent API only supports update/remove (no add), so try an upsert on
    // the phone-vision id; if the runtime rejects unknown ids, skip silently —
    // the skill guidance then falls back to the user's own vision agent.
    try {
      await ctx.agent.transform((agents) => {
        agents.update("phone-vision", (agent) => {
          agent.mode = "subagent"
          agent.model = { providerID: "opencode", id: "mimo-v2.5-free" } as any
          agent.description = "Describes phone screenshots for agents without vision" as any
          agent.system =
            "You are the phone-vision assistant for the mobile-use plugin. Given a screenshot file path of an Android phone screen, describe what is on screen exhaustively and precisely: quote all visible text verbatim, describe icons, layout, status bar contents, dialogs, and overlays, and give approximate positions when asked. The requesting agent cannot see images — your description is its eyes." as any
        })
      })
    } catch {
      /* agent upsert unsupported — config-defined agents still work */
    }


    // ── skills (app-specific automation guides) ─────────────────────────────
    await ctx.skill.transform((skills) => {
      for (const skill of SKILLS) {
        skills.add(skill)
      }
    })

    await ctx.tool.transform((tools) => {
      // ── device listing ─────────────────────────────────────────────────────
      tools.add({
        name: "phone_devices",
        description:
          "List Android devices connected via adb (serial, model, state). Use this first to confirm a device is online and to learn its serial for other phone tools.",
        input: noArgsSchema,
        execute: async () => {
          const { listDevices } = await import("./adb.ts")
          const devices = await listDevices(adbPath)
          if (devices.length === 0) {
            return textResult(
              "No Android devices found. Plug in a phone with USB debugging enabled (Settings > Developer options > USB debugging), or start an emulator.",
            )
          }
          const lines = devices.map((d) =>
            [
              `${d.state === "device" ? "OK" : "!!"} ${d.serial}`,
              d.model ? `model=${d.model}` : null,
              d.product ? `product=${d.product}` : null,
            ]
              .filter(Boolean)
              .join("  "),
          )
          return textResult(lines.join("\n"))
        },
        options: { codemode: false },
      })

      // ── screenshot (the agent's eyes) ──────────────────────────────────────
      tools.add({
        name: "phone_screenshot",
        description:
          "Capture the connected Android phone screen as a PNG image attachment. Use this before and after actions to observe and verify. Pass demo: true for a generated placeholder (no device needed). Pass small: true for a downscaled image (long edge 1600px) that costs fewer tokens — scale coordinates back to device pixels by the reported factor before tapping. Pass scale: N (integer divisor) to downscale by dividing the full resolution by N (e.g. scale: 2 = half size) — scale coordinates back to device pixels by the reported factor before tapping.\n\nIf your model can't see images, use the vision tiers in strict order — never skip a tier: (1) your own model if it supports image input; (2) only if it can't, the user's own 'vision' subagent if they have one set up; (3) only if neither exists, 'phone-vision' as the final fallback — pass the returned file path to describe it instead.",
        input: {
          type: "object",
          properties: {
            ...serialSchema,
            demo: {
              type: "boolean",
              description: "Return a generated placeholder phone image instead of capturing a real device",
            },
            small: {
              type: "boolean",
              description: "Downscale the screenshot (long edge 1600px) to save tokens",
            },
            scale: {
              type: "integer",
              minimum: 2,
              description: "Integer downscale divisor: 2 = half resolution, 3 = third, etc. Overrides small.",
            },
          },
          additionalProperties: false,
        },
        execute: async ({ serial, demo, small, scale }: any) => {
          if (demo) {
            const dir = join(tmpdir(), "opencode-mobile-use")
            mkdirSync(dir, { recursive: true })
            const file = join(dir, `placeholder-${Date.now()}.png`)
            writeFileSync(file, renderPlaceholderPng())
            return {
              content: [
                {
                  type: "text",
                  text: `Generated placeholder phone screen (demo mode) to ${file}. Connect a real device and retry without demo: true to capture the actual screen.`,
                },
                {
                  type: "file",
                  uri: pathToFileURL(file).href,
                  mime: "image/png",
                  name: "phone-placeholder.png",
                },
              ],
            }
          }
          const { serial: chosen } = await pick(serial)
          const [shot, size] = await Promise.all([
            runAdb(["exec-out", "screencap", "-p"], { serial: chosen, adbPath, timeoutMs: 15_000 }),
            runAdb(["shell", "wm", "size"], { serial: chosen, adbPath, timeoutMs: 10_000 }).catch(() => null),
          ])
          if (shot.code !== 0 || shot.stdout.length === 0) {
            throw new Error(
              `Screencap failed (exit ${shot.code}): ${shot.stderr.trim() || "empty output"}`,
            )
          }
          const sizeOut = size?.stdout.toString("utf8") ?? ""
          const dims =
            /Override size: (\d+)x(\d+)/.exec(sizeOut) ?? /(\d+)x(\d+)/.exec(sizeOut)
          const dir = join(tmpdir(), "opencode-mobile-use")
          mkdirSync(dir, { recursive: true })
          let png = shot.stdout
          let detail = dims ? ` (${dims[1]}x${dims[2]})` : ""
          if (small || scale) {
            try {
              const decoded = decodePng(shot.stdout)
              const maxLongEdge = scale
                ? Math.max(1, Math.round(Math.max(decoded.width, decoded.height) / scale))
                : 1600
              const scaled = downscale(decoded.rgba, decoded.width, decoded.height, maxLongEdge)
              png = encodePng(scaled.rgba, scaled.width, scaled.height)
              const sx = decoded.width / scaled.width
              const sy = decoded.height / scaled.height
              detail = ` (${scaled.width}x${scaled.height}, downscaled from ${decoded.width}x${decoded.height} — multiply image coordinates by ${sx.toFixed(2)}x${sy.toFixed(2)} for device pixels)`
            } catch {
              detail = detail || " (downscale failed — full size)"
            }
          }
          const file = join(dir, `screen-${chosen.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${Date.now()}.png`)
          writeFileSync(file, png)
          return {
            content: [
              {
                type: "text",
                text: `Captured screenshot of ${chosen}${detail} to ${file}`,
              },
              {
                type: "file",
                uri: pathToFileURL(file).href,
                mime: "image/png",
                name: "phone-screen.png",
              },
            ],
          }
        },
        options: { codemode: false },
      })

      // ── UI hierarchy (finding things by text) ─────────────────────────────
      tools.add({
        name: "phone_dump_ui",
        description:
          "Dump the current screen's UI hierarchy as a list of elements with text, content-description, class, clickable flag and pixel bounds. Use this to locate UI elements and compute tap coordinates: the center of bounds is (left+right)/2, (top+bottom)/2. Elements without text are usually icons — match them against a screenshot. Pass annotate: true to also get a screenshot with numbered overlays matching the #N element IDs.",
        input: {
          type: "object",
          properties: {
            ...serialSchema,
            maxNodes: {
              type: "integer",
              description: "Maximum number of elements to return (default 300)",
            },
            annotate: {
              type: "boolean",
              description: "Also return a screenshot with numbered overlays matching the element IDs",
            },
          },
          additionalProperties: false,
        },
        execute: async ({ serial, maxNodes, annotate }: any) => {
          const { serial: chosen } = await pick(serial)
          // Fast path: the screen hasn't changed since the last dump (no
          // mutating action, dump younger than the freshness bound) — return
          // the cached hierarchy instantly instead of paying uiautomator's
          // ~2.4s idle wait.
          const now = Date.now()
          if (
            dumpCache &&
            dumpCache.serial === chosen &&
            lastActionAt < dumpCache.at &&
            now - dumpCache.at < 15_000
          ) {
            return renderDump(chosen, dumpCache.focus, dumpCache.xml, maxNodes, annotate, true, adbPath)
          }
          // Foreground window — cross-check for stale dumps. uiautomator can
          // return a cached hierarchy (e.g. after an app switch), so the agent
          // needs to know what SHOULD be on screen. Combined with the dump in
          // one shell call (over the adb-server socket) to save round-trips.
          const HIERARCHY = /<hierarchy[\s\S]*<\/hierarchy>/
          const extract = (out: string): string => HIERARCHY.exec(out)?.[0] ?? ""
          let focusLine = "unknown"
          let xml = ""

          // Round 1 — fast path: focus + dump to /dev/tty, hard-bounded by
          // `timeout` so a non-idling screen can't hang the socket read past
          // its deadline. Kill a stuck uiautomator between attempts — some
          // builds hang forever and poison every later dump.
          const ttyCommand = `dumpsys window | grep mCurrentFocus; timeout 12 uiautomator dump /dev/tty`
          for (let attempt = 0; attempt < 2 && !xml; attempt++) {
            let out = ""
            try {
              out = await socketShell(chosen, ttyCommand)
            } catch {
              const r = await runAdb(["shell", ttyCommand], { serial: chosen, adbPath, timeoutMs: 25_000 }).catch(() => null)
              out = r?.stdout.toString("utf8") ?? ""
            }
            focusLine = out.split("\n").find((l) => l.includes("mCurrentFocus"))?.trim() ?? focusLine
            xml = extract(out)
            if (!xml) {
              await killStaleUiAutomator(chosen, adbPath)
              await new Promise((resolve) => setTimeout(resolve, 500))
            }
          }

          // Round 2 — heavy path: switch animations off so the UI can reach
          // the idle state uiautomator requires (a running progress bar or
          // video preview never idles), kill stale processes, then dump to a
          // file — faster than /dev/tty, and huge Compose/WebView trees get a
          // generous deadline instead of being cut off mid-write.
          if (!xml) {
            const prev = await getAnimationScales(chosen, adbPath)
            try {
              await setAnimationScales(chosen, adbPath, {})
              await killStaleUiAutomator(chosen, adbPath)
              for (let attempt = 0; attempt < 2 && !xml; attempt++) {
                const path = `/sdcard/window_dump_${Date.now()}_${attempt}.xml`
                const r = await runAdb(
                  ["shell", `timeout 45 uiautomator dump ${path}`],
                  { serial: chosen, adbPath, timeoutMs: 60_000 },
                )
                if (r.code === 0) {
                  const cat = await runAdb(["shell", "cat", path], {
                    serial: chosen,
                    adbPath,
                    timeoutMs: 20_000,
                  }).catch(() => null)
                  xml = extract(cat?.stdout.toString("utf8") ?? "")
                }
                await runAdb(["shell", "rm", "-f", path], {
                  serial: chosen,
                  adbPath,
                  timeoutMs: 10_000,
                }).catch(() => {})
                if (!xml) {
                  await killStaleUiAutomator(chosen, adbPath)
                  await new Promise((resolve) => setTimeout(resolve, 600))
                }
              }
            } finally {
              await setAnimationScales(chosen, adbPath, prev)
            }
          }

          // Round 3 — last resort: while media is playing, the mini-player's
          // progress bar keeps the UI from ever reaching the idle state
          // uiautomator requires ("could not get idle state"). Pause playback,
          // dump, then always resume.
          if (!xml) {
            await runAdb(["shell", "cmd media_session dispatch pause"], {
              serial: chosen,
              adbPath,
              timeoutMs: 10_000,
            }).catch(() => null)
            await new Promise((resolve) => setTimeout(resolve, 800))
            try {
              const path = `/sdcard/window_dump_${Date.now()}_media.xml`
              const r = await runAdb(["shell", `timeout 20 uiautomator dump ${path}`], {
                serial: chosen,
                adbPath,
                timeoutMs: 30_000,
              })
              if (r.code === 0) {
                const cat = await runAdb(["shell", "cat", path], {
                  serial: chosen,
                  adbPath,
                  timeoutMs: 20_000,
                }).catch(() => null)
                xml = extract(cat?.stdout.toString("utf8") ?? "")
              }
              await runAdb(["shell", "rm", "-f", path], {
                serial: chosen,
                adbPath,
                timeoutMs: 10_000,
              }).catch(() => {})
            } finally {
              await runAdb(["shell", "cmd media_session dispatch play"], {
                serial: chosen,
                adbPath,
                timeoutMs: 10_000,
              }).catch(() => null)
            }
            if (xml) focusLine = `${focusLine} (media was paused briefly for the dump)`
          }

          if (!xml) {
            // Graceful degradation: don't blind-throw — report the focused
            // window so the agent at least knows the app, and point at the
            // screenshot fallback.
            return textResult(
              `Focused window: ${focusLine}\nUI dump failed after all fallbacks — the screen is likely animating continuously or uses a non-dumpable surface (WebView/Flutter/canvas). Take a screenshot instead.`,
            )
          }
          dumpCache = { serial: chosen, at: Date.now(), focus: focusLine, xml }
          return renderDump(chosen, focusLine, xml, maxNodes, annotate, false, adbPath)
        },
        options: { codemode: false },
      })

      // ── input: tap / swipe / type / key ───────────────────────────────────
      tools.add({
        name: "phone_tap",
        description:
          "Tap at pixel coordinates on the phone screen. Get coordinates from phone_dump_ui bounds (center) or by reasoning from the last screenshot. Coordinates are in the screenshot's pixel space (see phone_screenshot for screen size). After tapping, verify the result with phone_screenshot or phone_dump_ui before the next step. If the screen looks unchanged after an action, do NOT repeat the same action — dump the UI, check logcat, or reconsider.",
        input: {
          type: "object",
          properties: {
            x: { type: "integer", description: "X pixel coordinate" },
            y: { type: "integer", description: "Y pixel coordinate" },
            ...serialSchema,
          },
          additionalProperties: false,
          required: ["x", "y"],
        },
        execute: async ({ x, y, serial }: any) => {
          const { serial: chosen } = await pick(serial)
          await runOrThrow(
            ["shell", "input", "tap", String(x), String(y)],
            { serial: chosen, adbPath },
            "tap",
          )
          markAction()
          return textResult(`Tapped ${chosen} at (${x}, ${y})`)
        },
        options: { codemode: false },
      })

      tools.add({
        name: "phone_swipe",
        description:
          "Swipe (drag) from one pixel coordinate to another on the phone screen. Use for scrolling, swiping away notifications, unlocking (swipe up), and flinging (short durationMs). After swiping, verify the result with phone_screenshot or phone_dump_ui before the next step. If the screen looks unchanged after an action, do NOT repeat the same action — dump the UI, check logcat, or reconsider.",
        input: {
          type: "object",
          properties: {
            x1: { type: "integer", description: "Start X" },
            y1: { type: "integer", description: "Start Y" },
            x2: { type: "integer", description: "End X" },
            y2: { type: "integer", description: "End Y" },
            durationMs: {
              type: "integer",
              description: "Duration in ms (default 300; smaller = faster fling, larger = slower drag)",
            },
            ...serialSchema,
          },
          additionalProperties: false,
          required: ["x1", "y1", "x2", "y2"],
        },
        execute: async ({
          x1,
          y1,
          x2,
          y2,
          durationMs,
          serial,
        }: any) => {
          const { serial: chosen } = await pick(serial)
          const args = ["shell", "input", "swipe", String(x1), String(y1), String(x2), String(y2)]
          if (durationMs) args.push(String(durationMs))
          await runOrThrow(args, { serial: chosen, adbPath }, "swipe")
          markAction()
          return textResult(`Swiped ${chosen} from (${x1},${y1}) to (${x2},${y2})${durationMs ? ` over ${durationMs}ms` : ""}`)
        },
        options: { codemode: false },
      })

      tools.add({
        name: "phone_type",
        description:
          "Type text into the focused field on the phone (tap the field first). Clean ASCII (no '%') uses 'input text' directly (fast, no IME switching). Anything else (Unicode, emojis, '%') tries clipboard+paste first, then ADBKeyboard as the last resort — the IME is switched, bound, typed, and restored with NO taps in between (switching IME moves the field; tapping old coordinates hits whatever is under them now). After typing, verify the result with phone_screenshot or phone_dump_ui before the next step. If the text didn't land, re-tap the field from a FRESH dump and retry.",
        input: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to type" },
            ...serialSchema,
          },
          additionalProperties: false,
          required: ["text"],
        },
        execute: async ({ text, serial }: any) => {
          const { serial: chosen } = await pick(serial)
          const markTyped = () => {
            markAction()
            return textResult(`Typed "${text}" on ${chosen}`)
          }
          if (!/[^\x00-\x7F]/.test(text) && !text.includes("%")) {
            await runOrThrow(
              ["shell", "input", "text", escapeInputText(text)],
              { serial: chosen, adbPath },
              "input text",
            )
            return markTyped()
          }
          // Non-ASCII or '%': clipboard + paste keyevents first — zero layout
          // risk. Some devices (Samsung + Gboard) eat injected paste
          // keyevents; when that happens we fall through to ADBKeyboard.
          if (await clipboardSet(chosen, text, adbPath)) {
            const pasted = await runAdb(["shell", "input", "keyevent", "279"], {
              serial: chosen,
              adbPath,
              timeoutMs: 10_000,
            }).catch(() => null)
            if (pasted && pasted.code === 0) return markTyped()
            const combo = await runAdb(["shell", "cmd", "input", "keycombination", "CTRL_LEFT", "V"], {
              serial: chosen,
              adbPath,
              timeoutMs: 10_000,
            }).catch(() => null)
            if (combo && combo.code === 0) return markTyped()
          }
          // Last resort: ADBKeyboard IME broadcast — no taps, waits for the
          // bound + served input connection.
          const typed = await typeWithAdbKeyboard(text, chosen, adbPath)
          if (typed) return markTyped()
          throw new Error(
            `Typing "${text}" failed: clipboard paste didn't take and ADBKeyboard is not installed (install com.android.adbkeyboard and try again)`,
          )
        },
        options: { codemode: false },
      })

      tools.add({
        name: "phone_key",
        description:
          "Send a hardware key press. Accepts friendly names: back, home, recents (app_switch), menu, enter, tab, space, delete, escape, power, volume_up, volume_down, camera, search, dpad_up/down/left/right, center — or an Android KEYCODE name/number. After pressing, verify the result with phone_screenshot or phone_dump_ui before the next step.",
        input: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key name, e.g. back, home, recents, power" },
            ...serialSchema,
          },
          additionalProperties: false,
          required: ["key"],
        },
        execute: async ({ key, serial }: any) => {
          const { serial: chosen } = await pick(serial)
          const code = /^\d+$/.test(key) ? Number(key) : keycodeFor(key)
          await runOrThrow(
            ["shell", "input", "keyevent", String(code)],
            { serial: chosen, adbPath },
            "keyevent",
          )
          markAction()
          return textResult(`Sent key "${key}" (${code}) to ${chosen}`)
        },
        options: { codemode: false },
      })

      tools.add({
        name: "phone_clear",
        description:
          "Clear the focused text field without an IME switch: select-all (Ctrl+A via cmd input keycombination, Android 13+) then Delete. Falls back to the ADBKeyboard ADB_CLEAR_TEXT broadcast if the combo is unavailable. Tap the field first. After clearing, verify the field is empty before typing.",
        input: {
          type: "object",
          properties: {
            ...serialSchema,
          },
          additionalProperties: false,
        },
        execute: async ({ serial }: any) => {
          const { serial: chosen } = await pick(serial)
          const combo = await runAdb(
            ["shell", "cmd", "input", "keycombination", "CTRL_LEFT", "A", ";", "input", "keyevent", "67"],
            { serial: chosen, adbPath, timeoutMs: 10_000 },
          ).catch(() => null)
          const comboOut = combo ? `${combo.stdout.toString("utf8")} ${combo.stderr}`.toLowerCase() : ""
          if (!combo || combo.code !== 0 || /unknown|error/.test(comboOut)) {
            await runOrThrow(
              ["shell", "am", "broadcast", "-a", "ADB_CLEAR_TEXT"],
              { serial: chosen, adbPath },
              "ADB_CLEAR_TEXT",
            )
          }
          markAction()
          return textResult(`Cleared the focused field on ${chosen}`)
        },
        options: { codemode: false },
      })

      tools.add({
        name: "phone_media",
        description:
          "Control media playback or volume via the active media session (works regardless of which window has focus — more reliable than media keyevents). Actions: play, pause, play-pause, stop, next, previous, mute, headsethook, rewind, fast-forward. Volume: pass volume (0-15, stream 3 = music by default) to set, or getVolume to read the current index. After an action, verify with dumpsys media_session (phone_shell) or the app UI.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["play", "pause", "play-pause", "stop", "next", "previous", "mute", "headsethook", "rewind", "fast-forward"],
              description: "Media session action to dispatch",
            },
            volume: { type: "number", description: "Set stream volume to this index (0-15)" },
            getVolume: { type: "boolean", description: "Read the current stream volume index" },
            stream: { type: "number", description: "Audio stream for volume (default 3 = music)" },
            ...serialSchema,
          },
          additionalProperties: false,
        },
        execute: async ({ action, volume, getVolume, stream, serial }: any) => {
          const { serial: chosen } = await pick(serial)
          const s = String(stream ?? 3)
          let args: string[]
          if (getVolume) {
            args = ["shell", "cmd", "media_session", "volume", "--stream", s, "--get"]
          } else if (volume != null) {
            args = ["shell", "cmd", "media_session", "volume", "--stream", s, "--set", String(volume)]
          } else if (action) {
            args = ["shell", "cmd", "media_session", "dispatch", action]
          } else {
            throw new Error("phone_media needs an action, a volume, or getVolume")
          }
          const result = await runOrThrow(args, { serial: chosen, adbPath, timeoutMs: 10_000 }, "media")
          const out = result.stdout.toString("utf8").trimEnd()
          markAction()
          return textResult(getVolume ? `Volume: ${out || "(no output)"}` : out || `Sent media ${action ?? `volume ${volume}`} to ${chosen}`)
        },
        options: { codemode: false },
      })

      // ── app / environment ──────────────────────────────────────────────────
      tools.add({
        name: "phone_open",
        description:
          "Launch an app by package name (e.g. com.instagram.android). Resolves the launcher activity, launches with --activity-no-animation and waits for the launch to land (-W); reports whether it was a cold/warm launch or an existing task brought to front. Deep links / specific screens: use phone_shell with 'am start -a android.intent.action.VIEW -d <uri> <pkg>'.",
        input: {
          type: "object",
          properties: {
            package: { type: "string", description: "Android package name of the app to launch" },
            ...serialSchema,
          },
          additionalProperties: false,
          required: ["package"],
        },
        execute: async ({ package: pkg, serial }: any) => {
          const { serial: chosen } = await pick(serial)
          const resolved = await runAdb(
            ["shell", "cmd", "package", "resolve-activity", "--brief", pkg],
            { serial: chosen, adbPath, timeoutMs: 15_000 },
          ).catch(() => null)
          const out = resolved?.stdout.toString("utf8").trim() ?? ""
          const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
          const comp = [...lines].reverse().find((l) => l.startsWith(`${pkg}/`) && !/^error/i.test(l))
          if (!comp) {
            throw new Error(
              `Could not resolve a launcher activity for ${pkg} (${out || "no resolve-activity output"}). Is it installed?`,
            )
          }
          const launch = await runOrThrow(
            ["shell", "am", "start", "-W", "--activity-no-animation", "-n", comp],
            { serial: chosen, adbPath, timeoutMs: 20_000 },
            "launch app",
          )
          const launchOut = launch.stdout.toString("utf8")
          const status = /Status:\s*(\w+)/.exec(launchOut)?.[1]
          const state = /LaunchState:\s*(\w+)/.exec(launchOut)?.[1]
          const warning = /Warning:\s*(.*)/.exec(launchOut)?.[1]
          markAction()
          return textResult(
            `Launched ${comp} on ${chosen}.${status ? ` Status: ${status}` : ""}${state ? `, LaunchState: ${state}` : ""}${warning ? ` — ${warning}` : ""}${/Error/i.test(launchOut) ? " (launch reported an error)" : ""}`,
          )
        },
        options: { codemode: false },
      })

      tools.add({
        name: "phone_install",
        description:
          "Install an APK on the phone. Pass the absolute path to a .apk file on this machine.",
        input: {
          type: "object",
          properties: {
            apkPath: { type: "string", description: "Absolute path to the APK file on this machine" },
            replace: { type: "boolean", description: "Reinstall/update keeping app data (default true)" },
            ...serialSchema,
          },
          additionalProperties: false,
          required: ["apkPath"],
        },
        execute: async ({ apkPath, replace, serial }: any) => {
          if (!existsSync(apkPath)) {
            throw new Error(`APK not found at ${apkPath}`)
          }
          const { serial: chosen } = await pick(serial)
          const args = ["install"]
          if (replace !== false) args.push("-r")
          args.push(apkPath)
          const result = await runOrThrow(args, { serial: chosen, adbPath, timeoutMs: 180_000 }, "install")
          const out = result.stdout.toString("utf8").trim()
          if (/^Success/m.test(out)) {
            markAction()
            return textResult(`Installed ${apkPath} on ${chosen}`)
          }
          throw new Error(`Install failed: ${out || result.stderr.trim()}`)
        },
        options: { codemode: false },
      })

      tools.add({
        name: "phone_logcat",
        description:
          "Read recent logcat output from the phone. Useful for crash traces, app errors, and verifying app behavior. The filter follows logcat syntax, e.g. 'ActivityManager:E *:S' or a tag like 'ReactNative'.",
        input: {
          type: "object",
          properties: {
            lines: { type: "integer", description: "Number of most recent lines (default 300)" },
            filter: { type: "string", description: "logcat filter expression, e.g. AndroidRuntime:E *:S" },
            ...serialSchema,
          },
          additionalProperties: false,
        },
        execute: async ({ lines, filter, serial }: any) => {
          const { serial: chosen } = await pick(serial)
          const args = ["logcat", "-d", "-t", String(lines ?? 300)]
          if (filter) args.push(filter)
          const result = await runOrThrow(args, { serial: chosen, adbPath, timeoutMs: 15_000 }, "logcat")
          const out = result.stdout.toString("utf8").trimEnd()
          return textResult(out ? out.slice(-60_000) : "(empty logcat)")
        },
        options: { codemode: false },
      })

      tools.add({
        name: "phone_shell",
        description:
          "Run an arbitrary adb shell command on the phone and return its output (long commands up to 120s; pass timeoutMs to extend). Escape hatch for anything the other phone tools don't cover (e.g. 'pm list packages', 'dumpsys battery', 'settings put global window_animation_scale 0').",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to run on the device" },
            timeoutMs: { type: "number", description: "Optional timeout in ms (default 120000)" },
            ...serialSchema,
          },
          additionalProperties: false,
          required: ["command"],
        },
        execute: async ({ command, serial, timeoutMs }: any) => {
          const { serial: chosen } = await pick(serial)
          const result = await runOrThrow(
            ["shell", command],
            { serial: chosen, adbPath, timeoutMs: Math.max(1_000, timeoutMs ?? 120_000) },
            `shell "${command.slice(0, 80)}"`,
          )
          const out = result.stdout.toString("utf8").trimEnd()
          return textResult(out || "(no output)")
        },
        options: { codemode: false },
      })

      tools.add({
        name: "phone_adb",
        description:
          "Run an adb command on this computer against the connected phone, e.g. 'pair 192.168.1.5:37001' or 'connect 192.168.1.5:37999' (wireless pairing), 'disconnect', 'kill-server'. Returns adb's output. Prefer the other phone tools for device operations; use this for host-side adb commands.",
        input: {
          type: "object",
          properties: {
            args: {
              type: "array",
              items: { type: "string" },
              description: "adb arguments (without the leading 'adb'), e.g. ['pair', '192.168.1.5:37001', '123456']",
            },
          },
          additionalProperties: false,
          required: ["args"],
        },
        execute: async ({ args }: any) => {
          const { listDevices, runAdb } = await import("./adb.ts")
          await listDevices(adbPath)
          const result = await runAdb(args, { adbPath, timeoutMs: 20_000 })
          const out = result.stdout.toString("utf8").trimEnd()
          const err = String(result.stderr ?? "").trimEnd()
          if (result.code !== 0) {
            return textResult(`adb ${args.join(" ")} failed (exit ${result.code}): ${err || out || "no output"}`)
          }
          return textResult(out || err || "(no output)")
        },
        options: { codemode: false },
      })
    })
  },
})

