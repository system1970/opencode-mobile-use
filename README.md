# opencode-mobile-use

Control an Android phone from OpenCode — with a **live phone screen in the TUI sidebar**, full agent tooling for taps, typing, calls, and apps, and a built-in phone-vision subagent. The agent drives the phone like a remote control; everything is verified against the real screen, not assumed.

<video src="https://github.com/user-attachments/assets/6bbf6547-8d87-4949-988c-55d7d7919b05" controls muted></video>

Published on npm as [`opencode-mobile-use`](https://www.npmjs.com/package/opencode-mobile-use). Works over USB, wireless adb, or **Tailscale** (drive the phone from anywhere).

## What it provides

- **Live sidebar screen** — the phone's display renders in the TUI sidebar (~36×30 cells via the terminal image protocol) and updates when the screen changes. Click it to open an enlarged full-resolution view.
- **12 agent tools** — `phone_devices`, `phone_screenshot` (SoM annotation + downscale), `phone_dump_ui`, `phone_tap`, `phone_swipe`, `phone_type`, `phone_key`, `phone_open`, `phone_install`, `phone_logcat`, `phone_shell`, `phone_adb`.
- **Resilient UI dump** — `phone_dump_ui` survives screens that never idle (video previews, playing progress bars): it hard-bounds `uiautomator` with a timeout, kills stale processes, disables animations, and as a last resort pauses media briefly, then resumes it.
- **Deep links first** — the skills prefer `am start` intents (`spotify:track:`, `spotify:search:`, `x.com/...`, `https://github.com/...`) over fragile tap-through-UI navigation; track/album/playlist IDs are resolved with a web search when needed.
- **App skills** — in-plugin skills encode hard-won failure modes:
  - `mobile-use` — base loop (connect, deep links first, look → act → verify, vision tiers)
  - `whatsapp` — find chats/groups, send messages, verify delivery
  - `x` — timeline, direct messages, quote posts, nav-drawer traps
  - `camera` — front/rear via dump descs, take photos, pull them to the laptop
  - `spotify` — play tracks via deep links (websearch → track ID → intent)
  - `phone-call` — contacts DB lookup, confirm duplicates, dial, hang up
  - `github` — open repos, star / unstar, verify the label flip
- **`phone-vision` subagent** — a bundled vision agent that describes phone screenshots when the active model can't see images.
- **Remote access** — pair once over Tailscale (`/phone-connect-remote`) and the phone works from anywhere; auto-reconnects.
- **`/phone-connect`** — guided wireless pairing in the TUI; **`/phone-disconnect`** turns off wireless debugging on the device so the disconnect actually sticks.

## Requirements

- OpenCode V2 (the `opencode2` binary). This release targets `@opencode-ai/plugin@0.0.0-next-17292`; upgrade OpenCode and this plugin together if that API changes.
- An Android phone with **USB debugging** enabled (Settings → Developer options).
- `adb` on PATH, or set `MOBILE_ADB_PATH` / `ADB_PATH`.
- `ffmpeg` (optional — used by the screenshot pipeline on some setups).
- ADBKeyboard installed on the phone (recommended for full-Unicode typing; `phone_type` falls back to `input text` for ASCII when it is absent).

## Install OpenCode V2

Install the current V2 prerelease:

```sh
npm install -g @opencode-ai/cli@next
opencode2 --version
```

## Configure the plugin

The plugin has two parts: the **server plugin** (tools + skills) and the **TUI plugin** (live sidebar). Add both entries — create the files if they don't exist, and preserve any existing `plugins`/other keys.

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

For reproducible installations, pin the exact version:

```json
{ "plugins": ["opencode-mobile-use@1.0.6"] }
```

OpenCode resolves the package's `.` export for the server plugin and its `./tui` export for the sidebar. Restart `opencode2` after changing the config, then confirm it loaded:

```sh
opencode2 api get /api/plugin
```

The response must include `"id": "mobile.use"`.

**Or let your agent do it** — paste this into OpenCode:

```
Install opencode-mobile-use by following https://github.com/system1970/opencode-mobile-use#readme
```

## Connect your phone

| Method | How |
|---|---|
| **USB** | Plug in, tap *Allow* on the phone |
| **Wireless** | `/phone-connect` in the TUI — guided pairing over the local network |
| **Remote** | `/phone-connect-remote` — pair once over Tailscale (phone + PC on the same account); works from anywhere and auto-reconnects |

Then verify:

```sh
adb devices        # phone should appear with state: device
```

Or ask the agent: run `phone_devices`. From here, try saying things like "send a message to my campus group on WhatsApp", "play Shape of You at full volume", "take a selfie and open it on my laptop", or "call John — confirm which number first".

### For LLM Agents (collapsed setup)

<details>
<summary>For LLM Agents</summary>

If you're an LLM agent helping set up opencode-mobile-use:

1. **Register the plugin in both configs** — `opencode.jsonc` gets `{ "plugins": ["opencode-mobile-use"] }`, `cli.json` gets `{ "plugins": ["opencode-mobile-use/tui"] }`. Create the files if missing; preserve existing keys.
2. **Verify** — `cat ~/.config/opencode/opencode.jsonc` contains `opencode-mobile-use`.
3. **Restart and confirm** — `opencode2 service restart`, then `opencode2 api get /api/plugin` must include `"id": "mobile.use"`.
4. **Connect the phone** — check `adb devices`. If offline: enable USB debugging (Settings → Developer options), then either plug in via USB and tap **Allow**, run `/phone-connect` for wireless pairing, or `/phone-connect-remote` for Tailscale.
5. **Verify end to end** — run `phone_devices` (should list the phone as `device`), then a real task like "take a selfie and open it on my laptop".

If the plugin didn't load: is `opencode-mobile-use` in `opencode.jsonc` **and** `opencode-mobile-use/tui` in `cli.json`? Did you restart? Check `tail ~/.local/share/opencode/log/opencode.log` and grep for `mobile.use`.

</details>

## Use

The agent gets the `phone_*` tools and the app skills automatically. Key behaviors:

- **Verify every step** — after each action, re-dump or re-screenshot and confirm the screen changed as expected. Never repeat a failed action blindly.
- **Deep links beat typing** — `spotify:search:<query>` pre-fills and runs a search with zero keystrokes; typing into fields silently fails with some IMEs, so the skills switch to ADBKeyboard (`ime set com.android.adbkeyboard/.AdbIME`) and send `am broadcast -a ADB_INPUT_TEXT --es msg <text>`.
- **One pixel space** — screenshot, dump, and tap coordinates are all in device pixels; tap the center of an element's bounds `[l,t,r,b] → ((l+r)/2, (t+b)/2)`.
- **Vision tiers** — if the active model can't see images: (1) the model's own image input, (2) the user's `vision` subagent, (3) the bundled `phone-vision` as the final fallback.

### Skills

| Skill | Does |
|---|---|
| `mobile-use` | Base loop: connect, deep links first, look → act → verify, vision tiers |
| `whatsapp` | Open the app, find chats/groups, send messages, verify delivery |
| `x` | Timeline, DMs, quote posts, nav-drawer traps |
| `camera` | Front/rear via dump descs, take photos, pull them to the laptop |
| `spotify` | Play tracks via deep links (websearch → track ID → intent) |
| `phone-call` | Contacts DB lookup, confirm duplicates, dial, hang up |
| `github` | Open repos, star / unstar, verify the label flip |

### Tools

The `phone_*` tools are registered on the server plugin:

| Tool | Purpose |
|---|---|
| `phone_devices` | List connected devices and their state |
| `phone_screenshot` | Capture the screen (SoM annotation, downscale) |
| `phone_dump_ui` | Read the UI hierarchy (resilient to non-idling screens) |
| `phone_tap` | Tap at device-pixel coordinates |
| `phone_swipe` | Swipe/drag, with fling support |
| `phone_type` | Type text (full Unicode via ADBKeyboard, IME restored) |
| `phone_key` | Press hardware keys (back, home, power, …) |
| `phone_open` | Launch an app by package name |
| `phone_install` | Install an APK |
| `phone_logcat` | Read logcat output |
| `phone_shell` | Run an arbitrary adb shell command |
| `phone_adb` | Run host-side adb commands (pair, connect, pull, …) |

## Configuration

The plugin needs no configuration options. Everything it reads comes from the environment:

| Variable | Purpose |
|---|---|
| `MOBILE_ADB_PATH` | Path to the `adb` binary (overrides `ADB_PATH` and PATH lookup) |
| `ADB_PATH` | Path to the `adb` binary (fallback) |

Optional phone-side setup: install ADBKeyboard for full-Unicode typing. Without it, `phone_type` falls back to `input text` (ASCII only).

## How it works

The server plugin registers the `phone_*` tools and skills through the OpenCode V2 plugin API. The TUI plugin renders the phone's display in the sidebar via the terminal image protocol, updating when the screen changes.

Everything talks to the phone over `adb` — over USB, wireless debugging, or a Tailscale tunnel. There is no phone-side app: just USB debugging enabled, and adb reachable from the host.

## Troubleshooting and limitations

- **No device found** — `adb devices` shows nothing: enable USB debugging, tap *Allow* on the phone, and retry `/phone-connect` (wireless) or plug in via USB.
- **UI dump fails** — on continuously-animating screens the dump pauses media briefly and resumes it (the header notes when it happens). If it still fails, it returns the focused window and suggests a screenshot — use the vision tiers.
- **Typing doesn't land** — switch to ADBKeyboard (`ime set com.android.adbkeyboard/.AdbIME`), tap the field again, send `am broadcast -a ADB_INPUT_TEXT --es msg <text>`, then restore the previous IME.
- **Deep link fails** — some apps reject `am start` intents (e.g. specific X/Twitter post URLs show "Unable to load"). Navigate manually — back out and use the in-app search/tabs.
- **Wireless device drops** — wireless debugging can reconnect under a different serial; run `phone_devices` and pass the current serial to every tool.
- **CodeMode dispatch** — plugin tools currently ship with `codemode: false` (they work via the standard tool-call path) because of [opencode issue #41949](https://github.com/anomalyco/opencode/issues/41949). Flip `options: { codemode: false }` → `true` once the upstream fix ([PR #41954](https://github.com/anomalyco/opencode/pull/41954)) lands.
- **Upstream: missing tool descriptions** — tracked in [opencode issue #42026](https://github.com/anomalyco/opencode/issues/42026). Every tool in this plugin has a description; the bug is upstream.

## Cleanup and security

- **Disconnect** — `/phone-disconnect` turns off wireless debugging on the device so the connection actually sticks.
- **adb exposure** — wireless debugging exposes adb on your local network while enabled; keep `/phone-connect-remote` (Tailscale) as the only remotely reachable path, or disconnect when not in use.
- **Screen content** — the sidebar renders whatever is on the phone screen, including potentially sensitive app content, into the terminal. Use the enlarged view and full-res screenshots deliberately.

## Local development

```sh
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

Or drop the checkout into `~/.config/opencode/plugins/opencode-mobile-use` and OpenCode auto-discovers it. Do not combine a local checkout with the npm package in the same config — you'd load it twice.

## License

MIT
