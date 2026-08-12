# opencode-mobile-use

Control an Android phone from OpenCode — with a **live phone screen in the TUI sidebar**, full agent tooling, and a built-in phone-vision subagent.

## What it does

- **Live sidebar screen** — the phone's display renders in the TUI sidebar (~36×30 cells via the terminal image protocol) and updates when the screen changes. Click it to open an enlarged full-resolution view.
- **12 agent tools** — `phone_devices`, `phone_screenshot` (with SoM annotation + downscale), `phone_dump_ui` (stale-proof: stdout dump + focused-window cross-check + freshness cache), `phone_tap`, `phone_swipe`, `phone_type` (full Unicode via ADBKeyboard, with IME restore), `phone_key`, `phone_open`, `phone_install`, `phone_logcat`, `phone_shell`, `phone_adb`.
- **App skills** — in-plugin skills encode hard-won failure modes, with deep links preferred over UI walking and a resilient UI dump (it survives continuously-animating screens by pausing media briefly):
  - `mobile-use` — the base loop (connect, deep links first, look → act → verify, vision tiers)
  - `whatsapp` — find chats/groups, send messages, verify delivery
  - `x` — timeline, direct messages, nav-drawer traps
  - `camera` — front/rear via dump descs, take photos, pull them to the laptop
  - `spotify` — play tracks via deep links (websearch → track ID → intent)
  - `phone-call` — contacts DB lookup, confirm duplicates, dial, hang up
- **`phone-vision` subagent** — a bundled vision agent (MiMo V2.5 Free) that describes phone screenshots when the active model can't see images.
- **Remote access** — pair once over Tailscale (`/phone-connect-remote`) and the phone works from anywhere; auto-reconnects.
- **`/phone-connect`** — guided wireless pairing in the TUI; **`/phone-disconnect`** turns off wireless debugging on the device so the disconnect actually sticks.

## Install

### For Humans

The plugin has two parts: the **server plugin** (tools/skills) and the **TUI plugin** (sidebar widget). Add it to both configs:

**`~/.config/opencode/opencode.json(c)`** (or project config):

```jsonc
{
  "plugins": ["opencode-mobile-use"]
}
```

**`~/.config/opencode/cli.json`**:

```json
{
  "plugins": ["opencode-mobile-use/tui"]
}
```

Restart opencode2. The sidebar shows the phone status; the agent gets the `phone_*` tools.

Then try saying things like "send *blehhh* to my campus group on WhatsApp", "play Shape of You at full volume", "take a selfie and open it on my laptop", or "call John — confirm which number first" — the agent drives the phone and verifies each step.

<details>
<summary>For LLM Agents</summary>

If you're an LLM agent helping set up opencode-mobile-use, follow these steps:

#### Step 1: Register the plugin in the configs

The plugin has two parts: the **server plugin** (tools + skills) and the **TUI plugin** (live sidebar). Add both entries — create the files if they don't exist, and preserve any existing `plugins`/other keys:

`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-mobile-use"]
}
```

`~/.config/opencode/cli.json`:

```json
{
  "plugins": ["opencode-mobile-use/tui"]
}
```

#### Step 2: Verify the config

```bash
cat ~/.config/opencode/opencode.jsonc
```

Should contain `"opencode-mobile-use"` in the `plugins` array. If not, add it manually. (Some setups use `opencode.json` — check both.)

#### Step 3: Restart and confirm the plugin loaded

```bash
opencode2 service restart
opencode2 api get /api/plugin
```

The response must include `"id": "mobile.use"`.

#### Step 4: Connect the phone

Check for a device:

```bash
adb devices
```

If nothing is online, the phone needs **USB debugging** enabled (Settings → Developer options). Then either:

- plug in via USB and tap **Allow**, or
- run `/phone-connect` in the TUI for guided wireless pairing, or
- run `/phone-connect-remote` for Tailscale (works from anywhere)

#### Step 5: Verify end to end

Run the `phone_devices` tool — it should list the phone with state `device`. Then confirm with a real task, e.g. "take a selfie and open it on my laptop" or "what's on my home screen?".

If the plugin didn't load:

1. Is `opencode-mobile-use` in `opencode.jsonc` **and** `opencode-mobile-use/tui` in `cli.json`?
2. Did you restart OpenCode after editing the configs?
3. Check the logs: `tail ~/.local/share/opencode/log/opencode.log` and grep for `mobile.use`.

</details>

## Prerequisites

- Android phone with **USB debugging** enabled (Developer options)
- `adb` on PATH, or set `MOBILE_ADB_PATH` / `ADB_PATH`
- `ffmpeg` (optional — used by the screenshot pipeline on some setups)

## Connect

| Method | How |
|---|---|
| **USB** | Plug in, tap *Allow* on the phone |
| **Wireless** | `/phone-connect` in the TUI (guided pairing) |
| **Remote** | `/phone-connect-remote` — pairs over Tailscale (phone + PC on the same account) |

## Known issues

- **CodeMode tool dispatch** — plugin tools currently ship with `codemode: false` (they work via the standard tool-call path) because of [opencode issue #41949](https://github.com/anomalyco/opencode/issues/41949) (plugin tools in CodeMode execute but don't relay results). Flip `options: { codemode: false }` → `true` in `index.ts` once the upstream fix ([PR #41954](https://github.com/anomalyco/opencode/pull/41954)) lands.
- **Missing tool descriptions crash all sessions** — tracked in [opencode issue #42026](https://github.com/anomalyco/opencode/issues/42026). Every tool in this plugin has a description; the bug is upstream.

## Development

```bash
git clone https://github.com/system1970/opencode-mobile-use.git
cd opencode-mobile-use
bun install
bunx tsc --noEmit -p tsconfig.json   # typecheck
```

Point your configs at the local copy:

```jsonc
// opencode.json
{ "plugins": ["./plugins/opencode-mobile-use"] }
```

```json
// cli.json
{ "plugins": ["./plugins/opencode-mobile-use/tui.tsx"] }
```

## License

MIT
