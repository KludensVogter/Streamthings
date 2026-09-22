<div align="center">

<img src="resources/icon.png" width="96" alt="">

# Streamthings

**Let Twitch and YouTube chat play your game.**

Chat types `forward`, the game moves. No Python, no API keys, no login.

[Download the latest release »](https://github.com/KludensVogter/Streamthings_releases/releases/latest)

</div>

---

## What it does

Streamthings reads your live chat and turns messages into real keyboard and
mouse input, the way DougDoug's Twitch Plays streams work. It ships as a normal
Windows installer, updates itself, and is configured entirely through its own
interface — there is no file to edit.

- **Two ways to play.** *Anarchy* runs every message immediately. *Voting*
  collects votes for a few seconds and runs the winner.
- **Any keyboard-driven game.** Input is injected as DirectInput scancodes, so
  it registers inside games and not just in menus.
- **Only your game.** Pick the game's window and chat's keys can never land in
  Discord, your browser or OBS.
- **A sign for your viewers.** A browser source for OBS lists every command and
  what each one does, all on one page, updating itself as you edit.
- **Polls.** Ask chat a question and let them answer by typing. Entirely separate
  from chat playing the game: it runs whether or not they are in control, and it
  never swallows their messages. Its own browser source, invisible until a poll
  is running.
- **Switches per command.** Hide one from the overlay while it still works,
  restrict it to moderators, let chat hold the key by typing a number after it,
  or let it override your own hands — releasing whatever you are holding and
  ignoring your presses until the command finishes, so you cannot out-mash chat.
- **Your own look.** Colours, opacity, width, rounding and text size for both
  overlays, with a live preview of the real pages.
- **Panic button.** <kbd>F8</kbd> anywhere pauses everything and releases every
  held key.
- **Profiles.** One per game, with import and export for sharing.
- **English and Danish**, following Windows by default.

## Install

Download `Streamthings-Setup-x.y.z.exe` from the
[releases repo](https://github.com/KludensVogter/Streamthings_releases/releases/latest)
and run it. It installs per user, so no administrator prompt.

The installer is not code-signed, so Windows SmartScreen shows a blue
"Windows protected your PC" warning the first time. Choose **More info →
Run anyway**. This fades once a release has enough downloads, or goes away
entirely with a code-signing certificate.

Once installed the app updates itself in the background and offers a restart
when a new version is ready.

## A word of warning

Do not use this in competitive games with anti-cheat — Valorant, CS2, Fortnite,
Rainbow Six and friends. Automated input can get the account banned.
Single-player games, emulators, Minecraft and silly games are the point.

## How it works

```
Twitch IRC ─┐                ┌─► Engine ─► Win32 SendInput ─► the game
            ├─► every msg ───┤
YouTube  ───┘                └─► Poll  ─► tally
                                    │
         Overlay server ────────────┴──► /       commands, one page
                                         /poll   the current poll
```

Both features see every message and neither consumes it, so a poll can run
while chat plays and vice versa.

| Piece | What it does |
|---|---|
| `src/main/input.js` | Win32 `SendInput` through koffi, writing the 40-byte `INPUT` struct by hand |
| `src/main/scancodes.js` | DirectInput scancode table, including which keys need the extended flag |
| `src/main/chat/twitch.js` | Anonymous Twitch IRC with tag parsing for moderator badges |
| `src/main/chat/youtube.js` | YouTube live chat over the innertube endpoint, no API key |
| `src/main/engine.js` | Modes, queueing, cooldowns, mod-only rules, focused-window guard |
| `src/main/poll.js` | Polls: options, one vote per viewer, tallies and timing |
| `src/main/hooks.js` | Low-level keyboard and mouse hooks, used only by the override switch |
| `src/main/profiles.js` | Profile storage, defaults, import and export |
| `src/main/overlay-server.js` | The localhost server OBS points at, serving both overlay pages |
| `src/renderer/` | The interface, with `i18n/*.json` holding every string |

Twitch is read as an anonymous guest, so the app cannot post and never sees a
password or a token. Nothing is sent anywhere except the requests needed to
read chat.

### About the override switch

Ignoring the streamer's own key presses needs a low-level keyboard hook, the
same Windows API a keylogger would use. Antivirus software watches for it, so
on an unsigned installer a false positive is a real possibility.

The hook is written to be as narrow as that lets it be. It is installed only
while a profile has an overriding command **and** chat is playing; it answers
exactly one question, whether this particular key is suppressed right now;
nothing is recorded, stored or sent; suppression is time-boxed so it ends on
its own; injected input and the panic key are never suppressed; and any error
in the callback falls through to passing the key on. Turn Override off on every
command and the hook is never installed at all.

## Development

Requires Node 22 or newer on Windows.

```bash
npm install
npm start
```

```bash
npm test
```

293 tests cover the scancode table and `INPUT` struct layout, chat parsing for
both platforms, every engine mode, poll tallying and its independence from the
engine, the per-command switches, the override guards, overlay theming, profile
handling and translation coverage.
One test presses a real key through `SendInput` and reads it back with
`GetAsyncKeyState`.

```bash
npm run build
```

Builds an installer into `dist/` without publishing it.

### Adding a language

Copy `src/renderer/i18n/en.json`, translate the values, and save it as the
language code — `de.json` for German. Add the name to `LANGUAGE_NAMES` in
`src/shared/i18n.js` and it appears in the picker. Any key you leave out falls
back to English, and `npm test` reports missing keys and mismatched
placeholders.

### Releasing

Releases are built by GitHub Actions and published to
[Streamthings_releases](https://github.com/KludensVogter/Streamthings_releases),
which is where the auto-updater looks.

One-time setup: create a
[personal access token](https://github.com/settings/tokens) with the `repo`
scope, then add it to this repository under **Settings → Secrets and variables
→ Actions** as `RELEASES_TOKEN`. The built-in `GITHUB_TOKEN` only has rights to
this repository, which is why a token is needed to write to the other one.

Before the first release, and any time the pipeline changes, run the workflow
by hand from the **Actions** tab. It builds and tests exactly as a release
does but publishes nothing, leaving the installer as a build artifact.

To cut a release, bump the version and push a matching tag:

```bash
npm version patch
git push origin main --follow-tags
```

`npm version` writes the new version, commits it and creates an **annotated**
tag. That last part matters: `--follow-tags` only pushes annotated tags, so a
tag made with a plain `git tag v0.1.0` is silently left behind. If you tag by
hand, use `git tag -a v0.1.0 -m "..."` or push it explicitly with
`git push origin v0.1.0`.

The workflow then fails early if `RELEASES_TOKEN` is missing or the tag and
`package.json` disagree, runs the tests, builds the installer and publishes it
to the releases repo.

## Licence

MIT
