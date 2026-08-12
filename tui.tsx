/** @jsxImportSource @opentui/solid */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { Plugin } from "@opencode-ai/plugin/tui"
import { RGBA } from "@opentui/core"
import { createSignal, Show } from "solid-js"
import { listDevices, runAdb, type AdbDevice } from "./adb.ts"
import { captureFullRes, capturePng, pngDataUri, pngSample, restoreDisplay } from "./capture.ts"

const execFileAsync = promisify(execFile)

const GREEN = RGBA.fromInts(80, 200, 120, 255)
const YELLOW = RGBA.fromInts(240, 180, 60, 255)
const RED = RGBA.fromInts(230, 90, 90, 255)

// Sidebar content area is 42 cols wide minus host + widget padding (~36).
const IMAGE_W = 36
const IMAGE_H = 30
// Self-chaining frame loop: pause this long between captures so it runs as
// fast as the phone can deliver frames; idle-poll this slowly with no phone.
const FRAME_GAP_MS = 20
const IDLE_MS = 1_000

interface ReadyInfo {
  device: AdbDevice
  wireless: boolean
  battery?: number
}

type PhoneState =
  | { kind: "ready"; info: ReadyInfo }
  | { kind: "multiple"; count: number }
  | { kind: "unauthorized"; serial: string }
  | { kind: "reconnecting"; address: string }
  | { kind: "no-device" }
  | { kind: "no-adb"; message: string }

export default Plugin.define({
  id: "mobile.use",
  setup: async (ctx) => {
    // Start with the no-device card immediately: the slot may only render once,
    // so the first render must be useful, not empty.
    const [state, setState] = createSignal<PhoneState>({ kind: "no-device" })
    const [store, mutate] = ctx.storage.store("mobile-use", {
      initial: { onboarded: false, lastAddress: "" },
    })

    // Hot reloads can leave two plugin generations alive, so a slash command
    // fires twice (two keymap layers). storage.memory is shared across
    // generations — use it as a short cooldown to drop duplicate dispatches.
    const [lastRun, setLastRun] = ctx.storage.memory("mobile-command-last", {
      initial: { at: 0 },
    })
    const guard = (): boolean => {
      const now = Date.now()
      if (now - lastRun.at < 2_000) return false
      setLastRun((d) => {
        d.at = now
      })
      return true
    }

    // Hot reloads leave the previous generation's slot registered (its cleanup
    // is not always run), stacking duplicate widgets. storage.memory is shared
    // across generations, so stash the unregister there and call the stale one
    // before registering ours.
    const [widgetReg, setWidgetReg] = ctx.storage.memory("mobile-widget-registration", {
      initial: { unregister: null as (() => void) | null },
    })

    // ── sidebar widget refresh ──────────────────────────────────────────────
    // The plugin bundle carries its own Solid instance, so signal changes can't
    // re-render the host-mounted widget. The host DOES re-invoke the slot
    // callback whenever the slot registry changes, so to refresh the widget we
    // unregister and re-register the slot — but only when content changes.
    let unregisterWidget: (() => void) | null = null
    let registerWidget: () => void = () => {}
    const reRegister = () => {
      unregisterWidget?.()
      registerWidget()
    }

    const widgetKey = (s: PhoneState): string => {
      switch (s.kind) {
        case "ready": {
          const info = s.info
          const battery =
            typeof info.battery === "number" ? `${Math.round(info.battery / 10) * 10}%` : null
          return `ready|${info.device.model ?? info.device.serial}|${info.wireless}|${battery}`
        }
        case "multiple":
          return `multiple|${s.count}`
        case "unauthorized":
          return `unauthorized|${s.serial}`
        case "reconnecting":
          return `reconnecting|${s.address}`
        case "no-adb":
          return `no-adb|${s.message}`
        case "no-device":
          return "no-device"
      }
    }
    // The host invokes the slot callback synchronously inside registerWidget(),
    // reading state() at that moment, so publish the new state BEFORE re-registering.
    const updateState = (next: PhoneState) => {
      const previousKey = widgetKey(state())
      setState(next)
      if (next.kind !== "ready") {
        frameUri = undefined
        frameSample = ""
        frameFailed = false
      }
      if (widgetKey(next) !== previousKey) {
        reRegister()
      }
    }

    // ── live frame loop ─────────────────────────────────────────────────────
    let frameUri: string | undefined
    let frameSample = ""
    let frameFailed = false
    let capturing = false
    // Self-chaining setTimeout: the next capture is scheduled only after the
    // current one finishes, so no setInterval pile-up — the loop runs as fast
    // as the phone can deliver frames, and slows to an idle poll when no
    // phone is connected.
    let frameTimer: ReturnType<typeof setTimeout> | undefined
    // Every widget refresh re-mounts the image element and re-transfers it
    // over the terminal image protocol (sixel on Windows Terminal) — cap the
    // render rate so the TUI host and terminal don't saturate. The newest
    // frameUri is still tracked for the viewer.
    const MIN_RENDER_GAP_MS = 250
    let lastRenderAt = 0
    const scheduleNextFrame = (delay: number) => {
      frameTimer = setTimeout(() => void captureFrame(), delay)
    }
    const captureFrame = async () => {
      if (state().kind !== "ready") {
        scheduleNextFrame(IDLE_MS)
        return
      }
      if (capturing) {
        scheduleNextFrame(FRAME_GAP_MS)
        return
      }
      capturing = true
      try {
        const png = await capturePng()
        const sample = pngSample(png)
        if (sample !== frameSample) {
          frameSample = sample
          frameUri = pngDataUri(png)
          frameFailed = false
          const now = Date.now()
          if (now - lastRenderAt >= MIN_RENDER_GAP_MS) {
            lastRenderAt = now
            reRegister()
          }
        }
      } catch {
        if (!frameUri && !frameFailed) {
          frameFailed = true
          reRegister()
        }
      } finally {
        capturing = false
        scheduleNextFrame(FRAME_GAP_MS)
      }
    }
    // First capture kicks off immediately at setup; the chain self-perpetuates
    // from there (idle-polling at IDLE_MS until a phone shows up).
    void captureFrame()

    // ── first-run onboarding: re-shows on every plugin load until the first
    //    phone connects, then never again ────────────────────────────────────
    if (store.onboarded !== true) {
      const welcome = setTimeout(() => {
        ctx.ui.toast.show({
          title: "mobile-use",
          message:
            "Ready — I can control your Android phone. Run /phone-connect to pair it wirelessly.",
          variant: "info",
          duration: 12_000,
        })
        void ctx.attention.notify({
          title: "mobile-use is ready",
          message: "I can control your Android phone. Run /phone-connect to pair it.",
          notification: true,
          sound: { name: "done" },
        })
      }, 2_500)
      setTimeout(() => clearTimeout(welcome), 15_000)
    }

    // ── device status + auto-reconnect ───────────────────────────────────────
    let lastReconnectAt = 0
    let reconnectFails = 0
    // Keep the last battery level across refreshes: a failed read (slow remote
    // link, timeout) must not flip the status line between "· 15%" and "· —"
    // and trigger a re-render every 3s.
    let lastBattery: number | undefined

    const refresh = async () => {
      try {
        const devices = await listDevices(undefined, 3_000)
        const online = devices.filter((d) => d.state === "device")
        const unauthorized = devices.find((d) => d.state === "unauthorized")
        if (online.length === 1) {
          reconnectFails = 0
          const device = online[0]
          const wireless = device.serial.includes(":") || device.serial.includes("_adb")
          if (wireless) {
            const bat = await runAdb(["shell", "dumpsys", "battery"], {
              serial: device.serial,
              timeoutMs: 4_000,
            }).catch(() => null)
            const level = /level: (\d+)/.exec(bat?.stdout.toString("utf8") ?? "")
            if (level) lastBattery = Number(level[1])
          } else {
            lastBattery = undefined
          }
          updateState({ kind: "ready", info: { device, wireless, battery: lastBattery } })
          if (store.onboarded !== true) {
            void mutate((d) => {
              d.onboarded = true
            })
            ctx.ui.toast.show({
              title: "Phone connected",
              message:
                "The phone's screen is now live in the sidebar. I can see and control it.",
              variant: "success",
              duration: 8_000,
            })
          }
        } else if (online.length > 1) {
          reconnectFails = 0
          updateState({ kind: "multiple", count: online.length })
        } else if (unauthorized) {
          updateState({ kind: "unauthorized", serial: unauthorized.serial })
        } else {
          const interval = reconnectFails > 3 ? 60_000 : 20_000
          if (store.lastAddress && Date.now() - lastReconnectAt > interval) {
            lastReconnectAt = Date.now()
            const r = await runAdb(["connect", store.lastAddress], { timeoutMs: 4_000 })
            if (r.code === 0) {
              const retry = await listDevices(undefined, 3_000)
              const back = retry.filter((d) => d.state === "device")
              if (back.length > 0) {
                reconnectFails = 0
                updateState({ kind: "ready", info: { device: back[0], wireless: true } })
                return
              }
            }
            reconnectFails++
            if (reconnectFails <= 2) {
              updateState({ kind: "reconnecting", address: store.lastAddress })
              return
            }
          }
          updateState({ kind: "no-device" })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/adb not found/i.test(message)) {
          updateState({ kind: "no-adb", message: "winget install Google.PlatformTools" })
        } else {
          updateState({ kind: "no-adb", message: message.slice(0, 60) })
        }
      }
    }

    // ── help in chat ────────────────────────────────────────────────────────
    const helpLines = [
      "mobile-use — control your Android phone",
      "",
      "The agent can see your phone's screen and control it: taps, typing,",
      "swipes, app launches, UI inspection, and log reading.",
      "",
      "LIVE VIEW",
      "  The phone's screen renders live in the sidebar while connected.",
      "  Click it to open a larger preview.",
      "",
      "CONNECT",
      "  · Wireless (recommended): run /phone-connect — it walks you through",
      "    pairing. The phone reconnects automatically afterwards.",
      "  · Remote (anywhere): run /phone-connect-remote — pairs over your",
      "    Tailscale network (phone + PC on the same Tailscale account) so the",
      "    phone is reachable from anywhere.",
      "  · Disconnect: run /phone-disconnect — turns off Wireless debugging on",
      "    the phone so it stays disconnected until you pair again.",
      "  · USB: plug in the phone, enable USB debugging (Developer options),",
      "    and tap Allow on the phone when prompted.",
      "",
      "WHAT IT CAN DO",
      "  screenshot / dump_ui  — see the screen, find elements by text",
      "  tap / type / swipe / key — control the phone",
      "  open / install        — launch apps, install APKs",
      "  logcat / shell        — logs, crashes, anything adb can do",
      "",
      "TRY SAYING",
      "  · “open the calculator and screenshot it”",
      "  · “install ./app-debug.apk and open it”",
      "  · “reproduce the crash and pull logcat”",
      "",
      "TROUBLESHOOTING",
      "  · Phone asks to Allow USB debugging? Tap Allow — only once.",
      "  · Pairing fails? The code expires after ~20s — re-open the screen.",
      "  · Can't connect? Same WiFi required; guest WiFis block device",
      "    traffic (try the phone's hotspot).",
      "  · Sidebar shows “no phone connected”? Plug in or run /phone-connect.",
    ]

    // ── guided wireless pairing ─────────────────────────────────────────────
    const connectPhone = async () => {
      try {
        const devices = await listDevices(undefined, 3_000)
        if (devices.some((d) => d.state === "device")) {
          ctx.ui.toast.show({ variant: "info", message: "A phone is already connected." })
          return
        }
        const pairInfo = await ctx.ui.dialog.prompt({
          title: "Wireless debugging — pair",
          description:
            "On your phone: Settings → Developer options → Wireless debugging → “Pair device with pairing code”. Enter everything that screen shows, e.g. 192.168.1.5:37001 123456",
          placeholder: "IP:port 6-digit-code  (both from the pairing screen)",
        })
        if (!pairInfo) return
        const parts = pairInfo.trim().split(/\s+/)
        const code = parts.pop()
        const addr = parts.join("")
        if (!addr || !code || !/^\d{6}$/.test(code)) {
          ctx.ui.toast.show({
            variant: "error",
            message: "That didn't look like “IP:port code” — try again.",
            duration: 6_000,
          })
          return
        }
        ctx.ui.toast.show({ variant: "info", message: `Pairing with ${addr}…` })
        const pair = await runAdb(["pair", addr, code], { timeoutMs: 15_000 })
        if (pair.code !== 0) {
          ctx.ui.toast.show({
            variant: "error",
            message: `Pairing failed: ${pair.stderr.trim() || "unknown error"}`,
            duration: 8_000,
          })
          return
        }
        const connectAddr = await ctx.ui.dialog.prompt({
          title: "Connect",
          description:
            "Paired ✓ — the code screen closes. On the main Wireless debugging screen, read the “IP address & Port” (it is different from the pairing port) and enter it.",
          placeholder: "192.168.1.5:37999",
        })
        if (!connectAddr) return
        ctx.ui.toast.show({ variant: "info", message: "Connecting…" })
        const conn = await runAdb(["connect", connectAddr.trim()], { timeoutMs: 10_000 })
        if (conn.code !== 0) {
          ctx.ui.toast.show({
            variant: "error",
            message: `Connect failed: ${conn.stderr.trim() || "unknown error"}`,
            duration: 8_000,
          })
          return
        }
        const after = await listDevices(undefined, 3_000)
        const online = after.filter((d) => d.state === "device")
        if (online.length === 0) {
          ctx.ui.toast.show({
            variant: "warning",
            message: "adb accepted the connection but the device isn't online yet — it should appear shortly.",
          })
          return
        }
        const device = online[0]
        void mutate((d) => {
          d.lastAddress = connectAddr.trim()
        })
        reconnectFails = 0
        ctx.ui.toast.show({
          title: "Phone connected",
          message: `${device.model ?? device.serial} is ready — it will reconnect automatically from now on.`,
          variant: "success",
          duration: 8_000,
        })
        void ctx.attention.notify({
          title: "Phone connected",
          message: `${device.model ?? device.serial} is ready for mobile-use.`,
          notification: true,
          sound: { name: "done" },
        })
      } catch (error) {
        ctx.ui.toast.show({
          variant: "error",
          message: `phone: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    // ── disconnect wireless phone, stop auto-reconnect ──────────────────────
    const disconnectPhone = async () => {
      try {
        const devices = await listDevices(undefined, 3_000)
        const online = devices.filter((d) => d.state === "device")
        // Direct TCP serials look like ip:port; mDNS discoveries look like
        // adb-<serial>-<salt>._adb-tls-connect._tcp — both are wireless.
        const wireless = online.find(
          (d) => d.serial.includes(":") || d.serial.includes("_adb"),
        )
        if (online.length > 0 && !wireless) {
          ctx.ui.toast.show({
            variant: "info",
            message: "That's a USB phone — just unplug the cable.",
          })
          return
        }
        const addr = wireless?.serial ?? store.lastAddress
        if (!addr) {
          ctx.ui.toast.show({ variant: "info", message: "No phone connected — nothing to disconnect." })
          return
        }
        // Restore the display while the phone is still reachable, before the
        // transport is dropped.
        await restoreDisplay()
        // Turn off Wireless debugging ON THE DEVICE (best-effort) so the phone
        // stops accepting adb connections and mDNS stops rediscovering it —
        // otherwise adb re-attaches within a second and the disconnect doesn't
        // stick. Pairing again (via /phone-connect) re-enables it.
        const turnOff = await runAdb(
          ["shell", "settings", "put", "global", "adb_wifi_enabled", "0"],
          { serial: wireless?.serial ?? addr, timeoutMs: 5_000 },
        ).catch(() => null)
        if (turnOff && turnOff.code !== 0) {
          ctx.ui.toast.show({
            variant: "warning",
            message:
              "Could not turn off Wireless debugging on the phone — it may stay discoverable. Turn it off in Developer options to fully disconnect.",
            duration: 8_000,
          })
        }
        let r = await runAdb(["disconnect", addr], { timeoutMs: 5_000 })
        // An mDNS-discovered phone has no ip:port entry to match, so adb says
        // "no such device" — fall back to dropping every TCP transport.
        if (r.code !== 0 && /no such device|no such transport/i.test(r.stderr)) {
          r = await runAdb(["disconnect"], { timeoutMs: 5_000 })
        }
        if (r.code !== 0) {
          ctx.ui.toast.show({
            variant: "error",
            message: `Disconnect failed: ${r.stderr.trim() || "unknown error"}`,
            duration: 8_000,
          })
          return
        }
        void mutate((d) => {
          d.lastAddress = ""
        })
        reconnectFails = 0
        updateState({ kind: "no-device" })
        ctx.ui.toast.show({
          title: "Phone disconnected",
          message: "Wireless debugging turned off — the phone stays disconnected until you pair again.",
          variant: "success",
          duration: 8_000,
        })
      } catch (error) {
        ctx.ui.toast.show({
          variant: "error",
          message: `phone: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    // ── Tailscale remote connect ─────────────────────────────────────────────
    let tailscalePath: string | undefined
    const findTailscale = (): string | undefined => {
      if (tailscalePath) return tailscalePath
      const candidates = [
        join(process.env.ProgramFiles ?? "C:\\Program Files", "Tailscale", "tailscale.exe"),
        join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Tailscale", "tailscale.exe"),
        "/usr/bin/tailscale",
        "/usr/local/bin/tailscale",
      ]
      for (const c of candidates) {
        if (existsSync(c)) return (tailscalePath = c)
      }
      for (const entry of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
        if (!entry) continue
        const c = join(entry, process.platform === "win32" ? "tailscale.exe" : "tailscale")
        if (existsSync(c)) return (tailscalePath = c)
      }
      return undefined
    }

    interface TailnetPeer {
      host: string
      ip: string
    }

    const tailscaleAndroidPeers = async (): Promise<TailnetPeer[]> => {
      const ts = findTailscale()
      if (!ts) throw new Error("Tailscale CLI not found — install Tailscale on this PC")
      const { stdout } = await execFileAsync(ts, ["status", "--json"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10_000,
      })
      const data = JSON.parse(stdout) as {
        Peer?: Record<string, { HostName?: string; DNSName?: string; TailscaleIPs?: string[]; OS?: string }> | Array<{
          HostName?: string
          DNSName?: string
          TailscaleIPs?: string[]
          OS?: string
        }>
      }
      // Tailscale ≥1.90 reports `Peer` as an object keyed by node ID; older
      // versions used an array. Normalize both.
      const peers = Array.isArray(data.Peer) ? data.Peer : Object.values(data.Peer ?? {})
      return peers
        .filter((p) => p.OS === "android" && p.TailscaleIPs && p.TailscaleIPs.length > 0)
        .map((p) => ({ host: p.HostName ?? p.DNSName ?? "android", ip: p.TailscaleIPs![0] }))
    }

    // Pair + connect over the phone's Tailscale address: the phone's pairing
    // screens show the LAN IP, which is substituted with the tailnet IP while
    // keeping the same ports. Stored as lastAddress, so auto-reconnect works
    // from anywhere.
    const connectRemotePhone = async () => {
      try {
        let peers: TailnetPeer[]
        try {
          peers = await tailscaleAndroidPeers()
        } catch (error) {
          ctx.ui.toast.show({
            variant: "error",
            message: `Tailscale: ${error instanceof Error ? error.message : String(error)}`,
          })
          return
        }
        if (peers.length === 0) {
          ctx.ui.toast.show({
            variant: "warning",
            message:
              "No Android phone found on your tailnet — install Tailscale on the phone and sign in with the same account.",
          })
          return
        }
        let peer = peers[0]
        if (peers.length > 1) {
          const picked = await ctx.ui.dialog.select({
            title: "Choose phone",
            options: peers.map((p) => ({ title: `${p.host} (${p.ip})`, value: p.ip })),
          })
          if (!picked) return
          peer = peers.find((p) => p.ip === picked) ?? peer
        }
        const pairInfo = await ctx.ui.dialog.prompt({
          title: "Wireless debugging — pair",
          description: `On the phone: Settings → Developer options → Wireless debugging → “Pair device with pairing code”. Enter the IP:port + code it shows — the tailnet address ${peer.ip} is substituted automatically.`,
          placeholder: "192.168.1.48:45999 123456",
        })
        if (!pairInfo) return
        const parts = pairInfo.trim().split(/\s+/)
        const code = parts.pop()
        const port = /:(\d+)$/.exec(parts.join(""))?.[1]
        if (!port || !code || !/^\d{6}$/.test(code)) {
          ctx.ui.toast.show({
            variant: "error",
            message: "That didn't look like “IP:port code” — try again.",
            duration: 6_000,
          })
          return
        }
        ctx.ui.toast.show({ variant: "info", message: `Pairing with ${peer.ip}:${port}…` })
        const pair = await runAdb(["pair", `${peer.ip}:${port}`, code], { timeoutMs: 15_000 })
        if (pair.code !== 0) {
          ctx.ui.toast.show({
            variant: "error",
            message: `Pairing failed: ${pair.stderr.trim() || "unknown error"}`,
            duration: 8_000,
          })
          return
        }
        const connectAddr = await ctx.ui.dialog.prompt({
          title: "Connect",
          description:
            "Paired ✓ — the code screen closes. On the main Wireless debugging screen, read the “IP address & Port” (it is different from the pairing port) and enter it.",
          placeholder: "192.168.1.48:45925",
        })
        if (!connectAddr) return
        const cPort = /:(\d+)$/.exec(connectAddr.trim())?.[1]
        if (!cPort) {
          ctx.ui.toast.show({ variant: "error", message: "That didn't look like IP:port — try again." })
          return
        }
        ctx.ui.toast.show({ variant: "info", message: `Connecting to ${peer.ip}:${cPort}…` })
        const conn = await runAdb(["connect", `${peer.ip}:${cPort}`], { timeoutMs: 10_000 })
        if (conn.code !== 0) {
          ctx.ui.toast.show({
            variant: "error",
            message: `Connect failed: ${conn.stderr.trim() || "unknown error"}`,
            duration: 8_000,
          })
          return
        }
        const after = await listDevices(undefined, 3_000)
        const online = after.filter((d) => d.state === "device" && d.serial.includes(peer.ip))
        if (online.length === 0) {
          ctx.ui.toast.show({
            variant: "warning",
            message: "adb accepted the connection but the device isn't online yet — it should appear shortly.",
          })
          return
        }
        void mutate((d) => {
          d.lastAddress = `${peer.ip}:${cPort}`
        })
        reconnectFails = 0
        ctx.ui.toast.show({
          title: "Phone connected via Tailscale",
          message: `${peer.host} is reachable from anywhere — it will reconnect automatically.`,
          variant: "success",
          duration: 8_000,
        })
        void ctx.attention.notify({
          title: "Phone connected remotely",
          message: `${peer.host} connected via Tailscale.`,
          notification: true,
          sound: { name: "done" },
        })
      } catch (error) {
        ctx.ui.toast.show({
          variant: "error",
          message: `phone: ${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }

    // ── timers ──────────────────────────────────────────────────────────────
    const statusTimer = setInterval(() => void refresh(), 3_000)
    void refresh()

    // ── sidebar widget ──────────────────────────────────────────────────────
    const openViewer = () => {
      if (!frameUri) return
      // Compact content (32-row image) fits within the terminal, so vertical
      // centering no longer clips.
      ctx.ui.dialog.set({ size: "xlarge", centered: true })
      const showDialog = (uri: string, caption: string) => {
        ctx.ui.dialog.show(() => (
          <box id="mobile-use-viewer" width="100%" alignItems="center" paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
            <box width="100%" flexDirection="row" justifyContent="space-between">
              <text>{caption}</text>
              <text onMouseUp={() => ctx.ui.dialog.clear()}>esc</text>
            </box>
            <image source={uri} fit="fit" protocol="auto" width={IMAGE_W} height={IMAGE_H + 2} />
          </box>
        ))
      }
      // The dialog is host-mounted, so the plugin's signals can't re-render it —
      // show the live frame immediately, then clear+re-show once the full-res
      // frame is captured (clear guarantees replacement on every host version).
      showDialog(frameUri, "Phone screen")
      void captureFullRes()
        .then((png) => {
          ctx.ui.dialog.clear()
          showDialog(pngDataUri(png), "Phone screen · full res")
        })
        .catch(() => {
          /* keep the live (scaled) frame */
        })
    }

    // The host mounts the callback's JSX with its own Solid runtime, so signal
    // changes don't re-render it — updateState()/captureFrame() re-register the
    // slot and the host re-invokes the callback, which renders the current state.
    const Widget = () => {
      const s = state()
      const subdued = ctx.theme?.text?.subdued
      switch (s.kind) {
        case "ready": {
          const info = s.info
          const bits = [
            info.device.model ?? info.device.serial,
            typeof info.battery === "number" ? `${info.battery}%` : null,
            info.wireless ? "wireless" : null,
          ].filter(Boolean)
          return (
            <box flexDirection="column" gap={1}>
              <text fg={subdued}>
                <span style={{ fg: GREEN }}>● </span>
                {bits.join(" · ")}
              </text>
              <box
                width={IMAGE_W}
                height={IMAGE_H}
                border={["top", "right", "bottom", "left"]}
                onMouseUp={(event) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  openViewer()
                }}
              >
                <Show
                  when={frameUri && !frameFailed}
                  fallback={
                    <box width="100%" height="100%" alignItems="center" justifyContent="center">
                      <text fg={subdued}>{frameUri ? "No preview" : "waiting for screen…"}</text>
                    </box>
                  }
                >
                  <image
                    id="mobile-use-live-view"
                    source={frameUri}
                    fit="fit"
                    protocol="auto"
                    width="100%"
                    height="100%"
                    onError={() => {
                      frameFailed = true
                      reRegister()
                    }}
                  />
                </Show>
              </box>
              <text fg={subdued}>live · click to enlarge</text>
            </box>
          )
        }
        case "multiple":
          return (
            <text fg={subdued}>
              <span style={{ fg: GREEN }}>● </span>
              {s.count} phones connected
            </text>
          )
        case "unauthorized":
          return (
            <text fg={subdued}>
              <span style={{ fg: YELLOW }}>● </span>
              tap “Allow” on {s.serial}
            </text>
          )
        case "reconnecting":
          return (
            <text fg={subdued}>
              <span style={{ fg: YELLOW }}>● </span>
              reconnecting to {s.address}…
            </text>
          )
        case "no-adb":
          return (
            <text fg={subdued}>
              <span style={{ fg: RED }}>● </span>
              adb missing — run: {s.message}
            </text>
          )
        case "no-device":
          return (
            <box flexDirection="column">
              <text fg={subdued}>
                <span style={{ fg: RED }}>● </span>
                no phone connected
              </text>
              <text fg={subdued}>pair: /phone-connect</text>
              <text fg={subdued}>remote: /phone-connect-remote</text>
              <text fg={subdued}>or: plug in via USB, tap Allow</text>
              <text fg={subdued}>guide: /phone-help</text>
            </box>
          )
      }
    }

    registerWidget = () => {
      // Drop any stale generation's widget before mounting ours.
      widgetReg.unregister?.()
      unregisterWidget = ctx.ui.slot({
        append: "sidebar.content",
        render: () => {
        // ctx.keymap.layer must run inside the slot callback: the Keymap
        // Provider context only exists under the host's render tree, so a
        // setup-level call throws "Keymap.Provider is missing".
        // layer() returns void and binds the layer to the current invocation
        // scope — the host disposes host-owned slot renderers on every
        // registry change and re-invokes this callback, so the layer is
        // created fresh on each re-register (a plugin-side flag would
        // silently drop the commands once the host re-invokes the renderer).
        // NB: do NOT query the keymap catalog (ctx.keymap.commands()) from
        // this callback — it runs inside the host's slot-registry refresh and
        // a synchronized catalog build caused the TUI to hang.
        try {
          ctx.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "mobile.connect",
                title: "Connect phone (wireless pairing)",
                description:
                  "Walk through pairing your Android phone over WiFi, step by step. It reconnects automatically afterwards.",
                group: "Mobile",
                palette: true,
                suggested: true,
                slash: { name: "phone-connect" },
                run: () => {
                  if (!guard()) return
                  void connectPhone()
                },
              },
              {
                id: "mobile.connect-remote",
                title: "Connect phone via Tailscale",
                description:
                  "Pair and connect your phone over its Tailscale address, so it works from anywhere (auto-detects Android devices on your tailnet).",
                group: "Mobile",
                palette: true,
                suggested: true,
                slash: { name: "phone-connect-remote" },
                run: () => {
                  if (!guard()) return
                  void connectRemotePhone()
                },
              },
              {
                id: "mobile.disconnect",
                title: "Disconnect phone",
                description:
                  "Disconnect the wireless phone and stop auto-reconnect until you pair again.",
                group: "Mobile",
                palette: true,
                suggested: true,
                slash: { name: "phone-disconnect" },
                run: () => {
                  if (!guard()) return
                  void disconnectPhone()
                },
              },
              {
                id: "mobile.help",
                title: "Mobile-use guide",
                description: "How to connect, what it can do, examples, and troubleshooting.",
                group: "Mobile",
                palette: true,
                suggested: true,
                slash: { name: "phone-help" },
                run: () => {
                  if (!guard()) return
                  const route = ctx.ui.router.current()
                  if (route.type === "session") {
                    void ctx.client.session.prompt({
                      sessionID: route.sessionID,
                      text: helpLines.join("\n"),
                      resume: false,
                    })
                  } else {
                    ctx.ui.toast.show({
                      title: "mobile-use",
                      message: "Open a session first, then run /phone-help.",
                      variant: "info",
                    })
                  }
                },
              },
            ],
          }))
        } catch {
          /* keymap unavailable — widget still renders */
        }
        return (
          <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} gap={1}>
            <Widget />
          </box>
        )
        },
      })
      setWidgetReg((d) => {
        d.unregister = unregisterWidget
      })
    }
    registerWidget()

    return () => {
      clearInterval(statusTimer)
      if (frameTimer) clearTimeout(frameTimer)
      void restoreDisplay()
      unregisterWidget?.()
      setWidgetReg((d) => {
        d.unregister = null
      })
    }
  },
})
