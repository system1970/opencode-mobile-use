import { Skill } from "@opencode-ai/plugin"
import { Schema } from "effect"
import { fileURLToPath } from "node:url"

const pluginDir = fileURLToPath(new URL(".", import.meta.url))

interface SkillSpec {
  id: string
  name: string
  description: string
  content: string
  autoinvoke?: boolean
}

function makeSkill(spec: SkillSpec): Skill.Info {
  return Schema.decodeUnknownSync(Skill.Info)({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    ...(spec.autoinvoke === undefined ? {} : { autoinvoke: spec.autoinvoke }),
    location: pluginDir,
    content: spec.content,
  })
}

export const SKILLS: Skill.Info[] = [
  makeSkill({
    id: "mobile-use",
    name: "mobile-use",
    autoinvoke: true,
    description:
      "Drive an Android phone connected to this machine over adb: see the screen, tap, type, swipe, launch apps, dump the UI tree, read logs. Use whenever the user wants anything done on, or with, their phone or an app on it.",
    content: `# Mobile Use

Control an Android phone connected to this machine via the \`phone_*\` tools
(\`phone_devices\`, \`phone_dump_ui\`, \`phone_screenshot\`, \`phone_tap\`,
\`phone_swipe\`, \`phone_type\`, \`phone_key\`, \`phone_open\`, \`phone_install\`,
\`phone_logcat\`, \`phone_shell\`, \`phone_adb\`).

## Connect first

Run \`phone_devices\`. Nothing online? Guide the user: \`/phone-connect\`
(wireless) or \`/phone-connect-remote\` (Tailscale) in the TUI, or plug in via
USB and tap Allow. Don't retry tools until a device is online. With multiple
devices, pass the serial to every tool.

## The loop — look, act, verify

1. \`phone_dump_ui\` or \`phone_screenshot\` to see where things are.
2. Act: \`phone_tap\` / \`phone_type\` / \`phone_swipe\` / \`phone_key\` / \`phone_open\`.
3. Re-dump or re-screenshot. Did the screen change as expected? If not, adjust —
   never repeat the same action blindly. This applies to EVERY step, even small
   ones (clearing a field, dismissing a dialog): if you don't verify, you'll act
   on stale state and pay for it twice.

## Rules

- **One pixel space** across screenshots, dumps and taps. Tap bounds centers:
  [l,t,r,b] → ((l+r)/2, (t+b)/2).
- **Stale dump?** \`phone_dump_ui\` reports the focused window — if the elements
  don't match it, retry the dump before acting.
- **Can't see images?** use the VISION TIERS in strict order — never skip a
  tier: (1) your own model, if it supports image input — always first;
  (2) only if it can't: the user's \`vision\` subagent, if they have one set
  up; (3) only if neither exists: \`phone-vision\` (MiMo) as the final
  fallback. Pass the screenshot file path. Never jump straight to tier 3.
- **Non-dumpable apps** (Flutter/canvas — e.g. Truecaller): \`phone_dump_ui\`
  fails. Skip straight to \`phone_screenshot\` + the vision tiers — don't
  waste dump retries.
- **Clearing a text field**: taps on an in-app clear (X) button are unreliable
  in Flutter/WebView fields — instead send \`am broadcast -a ADB_CLEAR_TEXT\`
  via \`phone_shell\` (ADBKeyboard), then verify the field is empty before
  typing.
- **Type**: tap the field first. \`phone_type\` PREFERS ADBKeyboard (full
  Unicode, IME restored after) and only falls back to \`input text\` (ASCII)
  when ADBKeyboard is unavailable — keep that preference; never bypass
  ADBKeyboard by sending raw \`input text\` yourself.
- **Screen off/locked**: \`phone_key power\`, swipe up twice.
- **Scroll**: vertical swipes; \`durationMs\` 100 = fling. Scroll until the target
  appears, then dump.
- **After \`phone_open\`**, confirm the app launched.
- **Crashes**: \`phone_logcat\` with \`AndroidRuntime:E *:S\` or an app tag.
- **Animations mislead taps**: taps land at the pixel. If a tap misses, re-dump
  and retry.
- **App missing?** \`phone_shell\` → \`pm list packages | grep <name>\`;
  \`phone_install\` the APK.
- **Anything else adb can do**: \`phone_shell\`.`,
  }),
  makeSkill({
    id: "whatsapp",
    name: "whatsapp",
    description:
      "Automate WhatsApp on the user's Android phone via the mobile-use tools — open the app, find a chat or group, send messages, and verify delivery. Use whenever the user asks to open WhatsApp, message someone, post in a group, or check WhatsApp activity.",
    content: `# WhatsApp Automation (via mobile-use)

The phone must be connected: check \`phone_devices\` first; if none, guide the
user to \`/phone-connect\` in the TUI or plug in via USB.

## Workflow

1. **Open**: \`phone_open\` with package \`com.whatsapp\`. It may restore into
   the last-open chat — if you need the chat list, \`phone_key back\` first.
2. **Find the chat**: \`phone_dump_ui\` (maxNodes ~60). Row names are
   \`TextView\`s; group names may render emoji as \`&#...;\` entities — match
   the plain text part (e.g. \`Campus Group\`).
3. **Open the chat**: tap the row's center, re-dump, and confirm the header —
   WhatsApp reorders chats by activity, so the list can shift between dump and
   tap.
4. **Type**: tap the \`Message\` \`EditText\` (bottom of the screen), then
   \`phone_type\`. ASCII only — spaces are handled; emojis, em-dashes and
   non-English scripts fail, so transliterate. Avoid quotes and backslashes.
5. **Send**: a \`Send\` button appears to the right of the input only after
   typing. Tap it.
6. **Verify**: re-dump — your message shows as a \`TextView\` with a timestamp
   and a \`Delivered\`/\`Sent\` status. Report success only then.

## When it misbehaves

- **Stale dump**: the hierarchy can lag behind the real screen (e.g. shows a
  chat you didn't open). Before tapping, confirm the foreground app with
  \`phone_shell\` → \`dumpsys window | grep mCurrentFocus\`.
- **Wrong screen**: \`phone_key back\` until you reach the chat list, then re-dump.
- **Unread filter**: the \`Unread\` chip narrows the list; unread counts appear
  in row content-desc.
- **No change after an action**: do NOT repeat it — re-dump, check
  \`phone_logcat\`, reconsider.`,
  }),
  makeSkill({
    id: "x",
    name: "x",
    description:
      "Automate X (Twitter) on the user's Android phone via the mobile-use tools — open the app, navigate the timeline, read posts, and send direct messages. Use whenever the user asks to open X, check or post something, or DM someone on X.",
    content: `# X (Twitter) Automation (via mobile-use)

The phone must be connected: check \`phone_devices\` first; if none, guide the
user to \`/phone-connect\` in the TUI or plug in via USB.

## Opening and the home timeline

1. **Open**: \`phone_open\` with package \`com.twitter.android\`.
2. **Landing**: Home timeline with tabs \`For you\` / \`Following\` / \`Local AI\`.
   Posts show author, handle, time, text, and an action row (Reply / Repost /
   Like / Bookmark / Share with counts). Top-left avatar opens the navigation
   drawer (\`desc="Show navigation drawer"\`).

## The bottom nav trap

- The 5-tab bottom bar (Home / Explore / Grok / Notifications / Messages) is
  only visible when the composer is closed.
- A **reply composer** ("Post your reply" pill) often overlays the bottom —
  e.g. after an app restore or a stray tap. If \`phone_dump_ui\` shows no nav
  icons but a composer at the bottom, press \`phone_key back\` once to dismiss
  it, then re-dump.

## Navigating to Direct Messages

1. Tap **Messages** (bottom-right, \`desc="Messages"\`), or open the drawer and
   pick Messages.
2. **Chat list**: each row's content-desc packs the whole row —
   \`Name, @handle, snippet, time\` (e.g. \`You, You sent a post, 2 hours\`).
   The \`You\` row is the user's self-DM (their own notes); its header shows
   their own name.
3. **Open a chat**: tap the row's center, then re-dump and confirm the HEADER
   (top bar name) — the list shifts between dump and tap, and a stale tap can
   open the wrong conversation. Back (\`desc="Back"\`, top-left) if wrong.
4. **Send a DM**: tap the \`Message\` \`EditText\` (bottom), \`phone_type\`
   (ASCII only — transliterate emojis), then tap the \`Send\` button that
   appears to the right of the input.
5. **Verify**: re-dump — your message shows as \`You: <text>. just now.\` with
   a Read/Delivered status. Report success only then.

## When it misbehaves

- **Deep links fail**: opening x.com URLs via intents can show
  \`Unable to load — Please try again later\`. Navigate manually instead —
  back out and use the in-app tabs/nav.
- **Stray taps land on posts/profiles**: the timeline is dense. If you end up
  on a post detail or someone's profile (with a \`Post your reply\` composer),
  back out and re-dump before continuing.
- **Stale dump**: confirm the foreground app (\`dumpsys window | grep
  mCurrentFocus\`) if the dump doesn't match what you expect.
- **No change after an action**: do NOT repeat it — re-dump, check
  \`phone_logcat\`, reconsider.`,
  }),
  makeSkill({
    id: "camera",
    name: "camera",
    description:
      "Automate the camera on the user's Android phone via the mobile-use tools — open the camera app, switch between front/rear lenses, take photos, and pull them to the laptop. Use whenever the user asks to take a photo, selfie, or picture, or open the camera app.",
    content: `# Camera Automation (via mobile-use)

The phone must be connected: check \`phone_devices\` first; if none, guide the
user to \`/phone-connect\` in the TUI or plug in via USB.

## Launch — package, not launcher icons

1. Find the package: \`phone_shell\` → \`pm list packages | grep -i camera\`
   (Samsung: \`com.sec.android.app.camera\`).
2. \`phone_open\` with that package. Launcher-icon taps drift between screens
   (the dock moved between dumps today); package launch is exact.
3. Confirm launch: \`phone_shell\` → \`dumpsys window | grep mCurrentFocus\`
   should show \`...Camera\`.

## Layout (Samsung One UI; other skins differ — re-dump before assuming)

- Mode tabs: \`text="FUN/PORTRAIT/PHOTO/VIDEO/MORE"\` (SeekBar \`desc="Photo, Mode"\`).
- Zoom: \`desc="Wide-angle, Button"\` / \`"Normal angle, Button"\` (0.5× / 1×).
- Top row: \`desc="Flash"\`, \`"Filters"\`, \`"Face"\`; \`desc="Quick controls"\` (⋯).
- Shutter: \`desc="Take picture"\`.
- Last-photo preview: \`desc="View pictures and videos"\` (bottom-left).

## Front vs rear — the dump is the truth

- NEVER judge camera direction from the viewfinder scene. Today the front
  camera was pointed at the ceiling (phone face-up) and looked identical to a
  rear shot; vision models misjudged it twice.
- The flip button's content-desc states what the button DOES:
  - \`desc="Switch to rear camera"\` → front camera ACTIVE
  - \`desc="Switch to front camera"\` → rear camera ACTIVE
- Flip = tap the button's bounds center, re-dump, confirm the desc flipped.

## Take the photo

1. Tap shutter (\`desc="Take picture"\`) bounds center.
2. Verify capture: thumbnail preview updates, or
   \`ls -t /sdcard/DCIM/Camera/ | head -1\` shows a new \`YYYYMMDD_HHMMSS.jpg\`.
3. Dark/covered viewfinder? Tell the user a shot of a lens cap isn't a result —
   don't claim success.

## Deliver the photo to the laptop

1. \`ls -t /sdcard/DCIM/Camera/ | head -1\` → newest file.
2. Pull with \`phone_adb\` (\`adb -s <serial> pull <remote> <local>\`), NOT
   \`phone_shell\` — its result parser breaks on pull (stderr isn't a string).
3. Open on the laptop: \`start "" "<path>"\` (Windows) or \`xdg-open\` (Linux).

## When it misbehaves

- **Vision gives wrong coords/direction**: screenshots are for understanding;
  act only on \`phone_dump_ui\` bounds.
- **"Selfie" with no person**: front camera ≠ user in frame. Warn and retake
  when they're in front of the phone.
- **Stray taps exit the camera**: confirm the focus window before every step.
- **Permission dialog on first launch**: tap Allow.
- **Low battery / screen off**: \`phone_key power\`, swipe up twice; warn on
  critically low battery.
- **No change after an action**: do NOT repeat it — re-dump, check
  \`phone_logcat\`, reconsider.`,
  }),
]
