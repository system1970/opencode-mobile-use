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

> Load this skill explicitly via the \`skill\` tool at the start of ANY mobile
> task (autoinvoke may not re-inject after a restart). Act from these rules,
> not from tool-description habits. The app skills (spotify, x, whatsapp,
> camera, phone-call, github) load AFTER this one and assume its rules are in
> force — so the shared loop, screen-reading, typing and keep-alive rules
> live here, once.

Control an Android phone via the \`phone_*\` tools (\`phone_devices\`,
\`phone_dump_ui\`, \`phone_screenshot\`, \`phone_tap\`, \`phone_swipe\`,
\`phone_type\`, \`phone_clear\`, \`phone_key\`, \`phone_media\`,
\`phone_open\`, \`phone_install\`, \`phone_logcat\`, \`phone_shell\`,
\`phone_adb\`).

## Connect first

Run \`phone_devices\` and get a device online before any other tool:
\`/phone-connect\` (wireless) or \`/phone-connect-remote\` (Tailscale) in the
TUI, or USB + Allow. With multiple devices, pass the serial to every tool.

## Deep links first — navigate with intents, not taps

Deep links are faster, dodge flaky typing, and skip fragile tap sequences.
They are the PRIMARY navigation; tap-walking the UI is the fallback.

- **Launch to a destination**: \`phone_shell\` →
  \`am start -a android.intent.action.VIEW -d "<uri>" <package>\` — e.g.
  \`spotify:track:<id>\`, \`spotify:search:<query>\` (spaces as %20),
  \`whatsapp://chat\`.
- **Verify resolution BEFORE launching**: \`cmd package resolve-activity
  --brief -a android.intent.action.VIEW -d "<uri>"\` must return
  <pkg>/<activity>, not ResolverActivity or "No activity found". Add
  \`-p <pkg>\` to force the app for https App Links (unverified links go to
  the browser on 12+).
- **Resolve IDs from a loaded doc first**: if a skill or doc already carries
  the canonical ID (e.g. greedy = \`spotify:track:6wCv0m87EJ6kYGUi5c0kbG\`),
  use it. \`websearch\` for \`open.spotify.com/track\` and friends only when
  no ID is documented — re-resolving risks a wrong or duplicate ID.
- **Know what YOUR link does before acting on the screen**: music links
  start playback (see below); \`x.com\` links land on a canvas screen where
  a dump error is a reading-method failure, not a link failure. When a deep
  link resolves and lands, keep it — re-navigating manually throws away the
  working state.

## Playback after a deep link — the pause is yours

\`spotify:track:<id>\` AUTO-PLAYS the track. Any screen capture
(\`phone_dump_ui\` / \`phone_screenshot\`) pauses media while it runs — the
dump header says so — so a Paused reading right after a capture is YOUR
artifact, not a failed link. Verify audio in dumpsys, never in pixels:

1. Read \`dumpsys media_session | grep state=PlaybackState\` with NO capture
   in between.
2. If the first read says Paused, sample a SECOND time (wait a beat, no
   capture). Second read PLAYING, or the position ticked forward → the
   capture caused the pause: touch nothing.
3. Only issue \`phone_media play\` when two clean samples both read Paused.
4. Never capture the screen to "verify" audio — the capture invents a pause
   you then have to undo.

## The loop — look, act, verify

1. See where things are: \`phone_dump_ui\` (text screens) or
   \`phone_screenshot\` (canvas screens — see below).
2. Act: \`phone_tap\` / \`phone_type\` / \`phone_swipe\` / \`phone_key\` /
   \`phone_open\`.
3. Re-check: did the screen change as expected? Adjust if not. A step is
   DONE when the screen shows the expected change — verify every step, even
   small ones (clearing a field, dismissing a dialog), or you act on stale
   state and pay twice. If the screen is unchanged after an action, do NOT
   repeat the action: re-check focus, dump, or \`phone_logcat\` and
   reconsider.

## Screen reading — dump vs screenshot

- **Text screens** (playlists, search results, settings, chats) expose text
  in the accessibility tree → \`phone_dump_ui\` first. A dump that RETURNS
  with content is not a failure.
- **Canvas screens** (Spotify/Instagram/X home, X post detail, Flutter apps,
  video) are sparse → \`phone_screenshot\` + a vision read directly; don't
  burn dump retries. An ERRORING dump is the signal to switch to vision, not
  a reason to abandon the navigation that got you here.
- **A screenshot is only worth taking if someone reads it**: if your model
  can't view images, hand the returned file path to a vision subagent in the
  same breath, or don't capture. Use the vision tiers in order: (1) your own
  model if it supports image input; (2) the user's \`vision\` subagent; (3)
  \`phone-vision\` last. When a vision read looks off, cross-check it against
  the dump (text nodes usually survive even on canvas screens).
- **Full-res for icon state**: badges and toggles (Spotify's repeat "1",
  shuffle) are illegible downscaled — capture full-res and tell vision the
  exact bounds. Where the state matters, verify behaviorally instead (sample
  the state twice over time, e.g. track position resetting = repeat-one)
  rather than trusting one icon read.

## Think before you act

- **Confirm focus after any launch**: after \`am start\` / \`phone_open\`,
  run \`dumpsys window | grep mCurrentFocus\` FIRST. A cached dump from the
  previous app is a trap — never tap from it.
- **Re-tap, don't re-dump**: if an action failed but a cheap state check
  (\`dumpsys media_session\`, \`dumpsys window\`) proves nothing changed,
  re-tap the SAME coordinates — a full \`phone_dump_ui\` adds zero
  information there.
- **Fresh zero-engagement items sit at the bottom** of engagement-sorted
  lists (X "Quotes", feeds). Verify your own just-posted item via your
  profile, a count delta, or the Sort control — don't walk ten
  scroll+dump cycles.
- **A closed composer IS delivery**: the composer closing proves the post
  went out. Pick the cheapest check that proves landing and move on — don't
  re-verify the same fact twice.

## Rules

- **One pixel space** across screenshots, dumps and taps. Tap bounds
  centers: [l,t,r,b] → ((l+r)/2, (t+b)/2).
- **Stale dump?** \`phone_dump_ui\` reports the focused window — retry if
  the elements don't match it.
- **Type**: tap the field first, then \`phone_type\`. Clean ASCII (no '%')
  goes via \`input text\` (fast); anything else (Unicode, emojis, '%') goes
  clipboard+paste first, then ADBKeyboard. The IME switch/restore happens
  with NO taps — switching moves the focused field, and a tap at old
  coordinates hits whatever is there now. If text didn't land, re-tap the
  field from a FRESH dump and retry. Use \`phone_clear\` (Ctrl+A + Del) to
  clear, then verify the field is empty before typing. Route all typing
  through \`phone_type\`.
- **Clearing a field**: taps on in-app clear (X) buttons are unreliable in
  Flutter/WebView fields — send \`am broadcast -a ADB_CLEAR_TEXT\` via
  \`phone_shell\`, then verify the field is empty.
- **Media control**: \`phone_media\` (cmd media_session dispatch) reaches the
  active session regardless of focus. Repeat/shuffle has NO shell API — read
  and set it in the app UI. \`dumpsys media_session --active\` confirms
  PLAYING/PAUSED + the actual track title.
- **Wake/unlock**: screen off → \`input keyevent 224\` (WAKEUP) then \`input
  keyevent 82\` (MENU) — the 224+82 pair is required on Samsung (WAKEUP alone
  can blank right back). \`wm dismiss-keyguard\` only clears non-secure
  locks; PIN needs \`input text <pin>\` + ENTER on the bouncer, typed fast
  (~7s budget).
- **Keep the link alive**: Samsung kills wireless adb when the display
  sleeps — the link dies mid-command, which is why long commands fail with
  no output. FRONT-LOAD at the start of any multi-app / multi-step session:
  \`svc power stayon true\`, \`dumpsys deviceidle disable\`,
  \`settings put system screen_off_timeout 2147483647\`. Do long waits
  host-side, never \`sleep\` >10s on-device. If the link dies, reconnect
  (\`adb connect\` / \`/phone-connect\`) and re-wake (224, 82).
- **Animations**: \`settings put global window_animation_scale 0.5\` (+
  transition_animation_scale, animator_duration_scale) — 0.5 not 0.0 on
  OneUI 6.1+ (0.0 causes layout/a11y glitches). OneUI's a11y "Remove
  animations" toggle resets these keys.
- **Scroll**: vertical swipes; \`durationMs\` 100 = fling. Scroll until the
  target appears, then dump.
- **Crashes**: \`phone_logcat\` with \`AndroidRuntime:E *:S\` or an app tag.
- **Animations mislead taps**: taps land at the pixel — re-dump and retry
  after a miss.
- **App missing?** \`pm list packages | grep <name>\`; \`phone_install\` the
  APK.
- **Anything else adb can do**: \`phone_shell\`.`,
  }),
  makeSkill({
    id: "whatsapp",
    name: "whatsapp",
    description:
      "Automate WhatsApp on the user's Android phone via the mobile-use tools — open the app, find a chat or group, send messages, and verify delivery. Use whenever the user asks to open WhatsApp, message someone, post in a group, or check WhatsApp activity.",
    content: `# WhatsApp Automation (via mobile-use)

Loaded after \`mobile-use\` — its connect / look-act-verify / typing rules
are in force.

## Workflow

1. **Open**: \`phone_open\` with package \`com.whatsapp\`. It may restore
   into the last-open chat — \`phone_key back\` once to reach the chat list.
2. **Find the chat — search, don't scroll**: the chat list is activity-
   sorted and can be long. Tap the search bar (\`desc="Ask Meta AI or
   Search"\`) and \`phone_type\` the chat name — the row lands instantly.
   Group names may render emoji as \`&#...;\` entities — match the plain text
   part (e.g. \`Campus Group\`).
3. **The self-DM is NOT labeled "You"**: the "Message yourself" chat shows
   the account's display name with a \`(You)\` suffix (e.g. \`Hhh (You)\`) and
   the subtitle \`Message yourself\`. Search the account's display name to
   find it. The display name alone is NOT proof — a contact shares it (e.g.
   a friend named identically). Match the \`(You)\` suffix or the
   \`Message yourself\` subtitle before tapping.
4. **Open the chat**: tap the row's center, re-dump, and confirm the HEADER
   (top bar name + \`Message yourself\` subtitle for the self-DM) — WhatsApp
   reorders chats by activity, so the list can shift between dump and tap.
5. **Type**: tap the \`Message\` \`EditText\` (bottom of the screen), then
   \`phone_type\`. ASCII only — transliterate emojis, em-dashes and
   non-English scripts; avoid quotes and backslashes.
6. **Send**: the \`Send\` button appears to the right of the input only after
   text exists — tap it.
7. **Verify**: your message shows as a \`TextView\` with a timestamp and a
   \`Delivered\`/\`Sent\` status (the self-DM shows \`Read\`). Report success
   only then.

## When it misbehaves

- **Wrong chat opened**: back out, re-search, and match the header before
  typing — you confirm first.
- **Unread filter**: the \`Unread\` chip narrows the list; unread counts
  appear in row content-desc.
- **Stale dump**: confirm the foreground app (\`dumpsys window | grep
  mCurrentFocus\`) before tapping.`,
  }),
  makeSkill({
    id: "x",
    name: "x",
    description:
      "Automate X (Twitter) on the user's Android phone via the mobile-use tools — open the app, navigate the timeline, read posts, quote or reply to posts, and send direct messages. Use whenever the user asks to open X, check or post something, quote a tweet, or DM someone on X.",
    content: `# X (Twitter) Automation (via mobile-use)

Loaded after \`mobile-use\` — its connect / look-act-verify / canvas-screen
rules are in force.

## Opening a post directly — deep links first

\`x.com\` post links WORK via intent and land on the post detail, not the
home feed:

- \`phone_shell\` →
  \`am start -a android.intent.action.VIEW -d "https://x.com/<user>/status/<id>" com.twitter.android\`.
- X renders posts as a CANVAS — verify with \`phone_screenshot\` + a vision
  read, not \`phone_dump_ui\`. A dump error here is a reading-method failure,
  not a link failure: screenshot once before ever considering manual
  navigation, and don't abandon a link that resolved.
- Only if the screenshot shows "Unable to load" or an error page: back out,
  use Search for the user, and open the post in-app.

## Home timeline and the nav

- \`phone_open\` with \`com.twitter.android\` → Home with tabs \`For you\` /
  \`Following\` / \`Local AI\`. Posts show author, handle, time, text and an
  action row (Reply / Repost / Like / Bookmark / Share with counts).
- The 5-tab bottom bar (Home / Explore / Grok / Notifications / Messages) is
  only visible when the composer is closed. A reply composer ("Post your
  reply" pill) often overlays the bottom after an app restore or a stray tap
  — \`phone_key back\` once dismisses it, then re-read the screen.

## Quote a post (with your text) — Repost → Quote

1. On the post detail, tap the **Repost** control in the action row (the
   crossed-arrows icon, carries a count).
2. In the bottom sheet, tap **Quote** (pencil icon).
3. The quote composer opens with the original post attached. Tap the text
   field and \`phone_type\` your quote (ASCII; transliterate emojis).
4. Tap **Post** (top-right, the blue pill).
5. Verify: the composer closing = posted. To confirm a count you can check,
   your quote appears under the original post's Quotes list — fresh
   zero-engagement items sort to the BOTTOM, so check your own profile or a
   count delta instead of scrolling.

## Direct Messages

1. Tap **Messages** (bottom-right, \`desc="Messages"\`), or open the drawer
   and pick Messages.
2. Chat rows pack the whole row into content-desc — \`Name, @handle, snippet,
   time\`. The \`You\` row is your own notes.
3. Open a chat: tap the row's center, re-dump, confirm the HEADER (top bar
   name) — the list shifts between dump and tap. Back (\`desc="Back"\`,
   top-left) if wrong.
4. Send: tap the \`Message\` \`EditText\` (bottom), \`phone_type\` (ASCII),
   tap \`Send\`. Verify the bubble shows as \`You: <text>. just now.\` with a
   Read/Delivered status.

## When it misbehaves

- **Stray taps land on posts/profiles**: the timeline is dense. If you end
  up on a post detail or someone's profile, back out and re-read the screen
  before continuing.
- **Post didn't send**: the composer staying open is the signal — re-post.
- **Stale dump**: confirm the foreground app (\`dumpsys window | grep
  mCurrentFocus\`).`,
  }),
  makeSkill({
    id: "camera",
    name: "camera",
    description:
      "Automate the camera on the user's Android phone via the mobile-use tools — open the camera app, switch between front/rear lenses, take photos, and pull them to the laptop. Use whenever the user asks to take a photo or selfie, or open the camera app.",
    content: `# Camera Automation (via mobile-use)

Loaded after \`mobile-use\` — its connect / look-act-verify rules are in
force.

## Launch — package, not launcher icons

1. Find the package: \`phone_shell\` → \`pm list packages | grep -i camera\`
   (Samsung example: \`com.sec.android.app.camera\`). Package launch is
   exact; launcher-icon taps drift between screens.
2. \`phone_open\` with that package. Confirm launch: \`phone_shell\` →
   \`dumpsys window | grep mCurrentFocus\` should show \`...Camera\`.

## Layout (Samsung One UI; other skins differ — re-dump before assuming)

- Mode tabs: \`text="FUN/PORTRAIT/PHOTO/VIDEO/MORE"\` (SeekBar \`desc="Photo, Mode"\`).
- Zoom: \`desc="Wide-angle, Button"\` / \`"Normal angle, Button"\` (0.5× / 1×).
- Top row: \`desc="Flash"\`, \`"Filters"\`, \`"Face"\`; \`desc="Quick controls"\` (⋯).
- Shutter: \`desc="Take picture"\`.
- Last-photo preview: \`desc="View pictures and videos"\` (bottom-left).

## Front vs rear — judge by the dump, not the viewfinder

- The flip button's content-desc states what the button DOES:
  - \`desc="Switch to rear camera"\` → front camera ACTIVE
  - \`desc="Switch to front camera"\` → rear camera ACTIVE
- Flip = tap the button's bounds center, re-dump, confirm the desc flipped.
- The viewfinder scene can't tell you the direction — a front camera pointed
  at a ceiling (phone face-up) looks identical to a rear shot, and vision
  models misjudge it. The dump descs don't.

## Take the photo

1. Tap shutter (\`desc="Take picture"\`) bounds center.
2. Verify capture: the thumbnail preview updates, or
   \`ls -t /sdcard/DCIM/Camera/ | head -1\` shows a new \`YYYYMMDD_HHMMSS.jpg\`.
3. A dark/covered viewfinder isn't a result — tell the user a shot of a lens
   cap isn't success.

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
  critically low battery.`,
  }),
  makeSkill({
    id: "spotify",
    name: "spotify",
    description:
      "Automate Spotify on the user's Android phone via the mobile-use tools — open the app, search for songs or albums, play tracks, and verify what's actually playing. Use whenever the user asks to play a song, artist, album, or playlist on Spotify.",
    content: `# Spotify Automation (via mobile-use)

Loaded after \`mobile-use\` — its connect / look-act-verify / playback /
keep-alive rules are in force.

## Launch

\`phone_open\` with package \`com.spotify.music\`; confirm with
\`dumpsys window | grep mCurrentFocus\` showing
\`com.spotify.music.MainActivity\`.

## Fast path — deep links (default)

Deep links are the PRIMARY way to task Spotify; typing is the fallback.

1. **Get the track ID**: use a documented ID if a skill/doc already carries
   it (e.g. greedy = \`spotify:track:6wCv0m87EJ6kYGUi5c0kbG\`); otherwise
   \`websearch\` for \`<song> <artist> open.spotify.com/track\` (or /album,
   /playlist, /artist) and read the ID from the result URL — the canonical
   entry (most plays), not a remix/compilation.
2. **Open the track**: \`phone_shell\` →
   \`am start -a android.intent.action.VIEW -d "spotify:track:<ID>" com.spotify.music\`.
   The link AUTO-PLAYS the track and lands on its album context.
3. **Or search directly**: \`spotify:search:<query>\` (spaces as %20) opens
   Search with the query pre-filled and results already executed — zero
   keystrokes.

## Verify playback — in dumpsys, never in pixels

- \`spotify:track:\` deep links AUTO-PLAY. \`phone_dump_ui\` and
  \`phone_screenshot\` pause media while capturing (the header notes it), so
  a Paused read right after a capture is YOUR artifact. Confirm playback by
  reading \`dumpsys media_session | grep state=PlaybackState\` with NO
  capture in between; if it reads Paused, sample a SECOND time (no capture)
  — still Paused across two clean samples, then \`phone_media play\`.
- \`dumpsys media_session --active\` gives the authoritative PLAYING/PAUSED
  + the ACTUAL track title. Report the title, not the intent — a mis-tap can
  land on the wrong row (title track ≠ target track).
- Play/pause/next: \`phone_media\`. Repeat mode has NO shell API — set it in
  the now-playing UI and verify behaviorally (track position resets) or at
  full-res, not from a single icon read.

## Manual fallback — search by typing

> Use this only when deep links failed or can't express the destination.

1. Tap **Search** (\`desc="Search, Tab 2 of 4"\`, bottom bar).
2. Tap the search field, \`phone_type\` (ASCII; transliterate non-English
   titles). If the field shows no text, \`ime set
   com.android.adbkeyboard/.AdbIME\`, re-tap the field,
   \`am broadcast -a ADB_INPUT_TEXT --es msg <query>\`, restore the old IME.
3. Tap the matching top result. In an album the FIRST track is NOT
   necessarily the target — the title track often sits first while the
   requested song is later. Scroll until the right title appears, then tap
   its row.

## When it misbehaves

- **Dump fails on the now-playing screen**: don't retry — screenshot +
  vision.
- **Deep link lands on the album, not the track**: normal — tap the track
  row or Play.
- **Wrong track playing**: tap the correct row; confirm via
  \`dumpsys media_session --active\` metadata.
- **No result found**: broaden the query (artist + song name), try the
  album card, or the artist page (\`desc="Navigates to more content from
  this artist"\`).
- **Not signed in / ad break**: a premium wall may block playback — tell the
  user rather than retrying blindly.`,
  }),
  makeSkill({
    id: "phone-call",
    name: "phone-call",
    description:
      "Make phone calls from the user's Android phone via the mobile-use tools — find contacts by name, confirm the right number, dial, verify the call connects, and hang up. Use whenever the user asks to call someone, dial a number, or end a call.",
    content: `# Phone Call Automation (via mobile-use)

Loaded after \`mobile-use\` — its connect / look-act-verify rules are in
force.

## Find the contact — query the database, don't browse the UI

1. List contacts: \`phone_shell\` →
   \`content query --uri content://com.android.contacts/contacts --projection _id:display_name\`,
   filter with \`| grep -i <name>\`.
2. Get numbers: \`phone_shell\` →
   \`content query --uri content://com.android.contacts/data/phones --projection display_name:data1:data2\`
   — \`data1\` is the number (E.164, e.g. +14155550123), \`data2=2\` is
   mobile. Match by display_name.
3. **Duplicate names are common** — "John Smith" can exist twice with
   different numbers. If more than one match, ASK THE USER which number to
   call before dialing. Never guess.

## Dial

1. Place the call: \`phone_shell\` →
   \`am start -a android.intent.action.CALL -d tel:<number>\`.
2. **CALL can fail from the shell** (SecurityException — uid 2000 lacks
   CALL_PHONE). If the output mentions SecurityException, fall back to
   \`am start -a android.intent.action.DIAL -d tel:<number>\` (pre-fills the
   dialer), then \`phone_tap\` the call button — and tell the user the call
   needed a manual confirm.
3. Verify: focus should be
   \`com.samsung.android.incallui/...InCallActivity\` (Samsung) showing
   \`Calling…\` + contact name + number. Report the name and number you
   dialed.

## End the call

1. \`phone_key endcall\` (KEYCODE_ENDCALL).
2. Verify: \`phone_shell\` →
   \`dumpsys telecom | grep ConnectionState=\` shows a trailing
   \`STATE_DISCONNECTED\` entry.

## When it misbehaves

- **Balance/end-call dialog** (\`com.android.phone\` with an OK button — some
  carriers show a post-call balance notice, e.g. "Your last call cost…"): tap
  OK to dismiss; it's the previous call's notification, not an active call.
- **Call state ambiguity**: \`dumpsys window | grep mCurrentFocus\` —
  InCallActivity = active call; \`com.android.phone\` = dialog; the home
  screen = no call. Check before acting.
- **Call didn't connect / got cut**: re-dial the same number once; tell the
  user if it fails again (their network/caller is the issue, not the phone).
- **Call screening apps** (e.g. Truecaller): calls pass through a screener —
  it doesn't block dialing, just delays connect; wait a few seconds before
  reporting "not connected".
- **Wrong contact tapped**: you were supposed to confirm first — back out,
  re-query, and ask.`,
  }),
  makeSkill({
    id: "github",
    name: "github",
    description:
      "Automate GitHub on the user's Android phone via the mobile-use tools — open a repo, star or unstar it, and verify. Use whenever the user asks to star or unstar a repository, open a GitHub repo, or check a repo page.",
    content: `# GitHub Automation (via mobile-use)

Loaded after \`mobile-use\` — its connect / look-act-verify / deep-link
rules are in force.

## Open a repo — deep link first

1. \`phone_shell\` →
   \`am start -a android.intent.action.VIEW -d "https://github.com/<owner>/<repo>" com.github.android\`.
   If no GitHub app is installed, drop the package — the intent opens the
   browser instead.
2. Confirm focus and find the Star button: \`phone_dump_ui\` — GitHub's
   native views expose \`text="Star"\` / \`desc="Star"\` in the a11y tree.
   Repo pages also show owner, name, description and the star count.

## Star, then unstar

1. Tap **Star** (\`text="Star"\`). Verify it flips to \`Starred\` (filled
   icon, label changes) before moving on.
2. To unstar: tap **Starred** again. Verify it flips back to \`Star\`.
3. Star→unstar round-trips notify the repo owner — do them in the requested
   order and verify each flip; a claimed star that never flipped is a
   failure, not a result.

## When it misbehaves

- **Not signed in**: a sign-in wall blocks the Star — tell the user.
- **Star count ambiguous**: GitHub's own star count may lag; judge by the
   Star/Starred label flip, not the count.
- **Stale dump**: confirm focus (\`dumpsys window | grep mCurrentFocus\`)
   before tapping.`,
  }),
]
