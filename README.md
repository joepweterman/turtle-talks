# Turtle Talks 🐢

A local, private meeting-notes and dictation app for Windows. It sits in the
system tray, records **system audio + microphone**, transcribes with
**whisper.cpp** on your own machine, and writes a markdown note with a 5-bullet
summary, decisions, and action items. It also does **dictation anywhere**:
press a hotkey in any app, speak Dutch or English, and the text is typed at
your cursor.

No accounts, no cloud storage, no telemetry. Everything stays on this machine.
The only optional network calls are to Anthropic's API for summaries — and even
that is skipped if you run [Ollama](https://ollama.com) locally.

## How it works

Launching the app opens the **Turtle Talks window**: your meeting notes on the
left, the selected note rendered on the right, record buttons and dictation
history in the sidebar. Closing the window keeps the app running in the tray;
click the tray icon (or the desktop icon again) to bring it back.

Notes get an **auto-generated title** from the summary step (for example
"Ajax speelt tegen Volendam vandaag") and can be **edited in place**: open a
note, hit Edit, change the title or the markdown body, Save writes it straight
back to the file. "View all dictations" shows everything you've ever dictated
(stored locally in `MeetingNotes\dictations.jsonl`), with per-item copy.

The **Settings** screen (top right) covers your name (used as your speaker
label), a personal **vocabulary** so whisper recognises names and jargon, the
dictation hotkey and language, model choices, and the summarizer (local Ollama,
Claude, or none). Settings live in `MeetingNotes\settings.json`.

**Turtle Talks learns from your edits.** Fix a dictation (the "Fix" button in
the history) or correct a word in a note's transcript, and the change is
learned as a correction: next time whisper writes "total talks", it becomes
"Turtle Talks" automatically. Learned pairs are visible and editable in
Settings.

**Multiple people in the room?** Enable it in Settings and run
`scripts/setup-diarize.ps1` once (~80 MB of local speaker-detection models).
The mic side of the transcript is then split into Speaker 1 / Speaker 2 / …
after the meeting. Works best when voices are reasonably distinct. In Teams
1-on-1 calls the other side is labeled with their real name when it's visible
in the window title.

Typography is the DIVR set (Lora, Hanken Grotesk, JetBrains Mono), bundled
locally so the app stays fully offline.

1. Click **Record EN** / **Opname NL** in the window (or right-click the tray
   icon). Picking the language up front is what tells Whisper which language
   to transcribe, so Dutch meetings don't get mangled.
2. System audio (Teams, Meet, Zoom…) and your microphone are recorded as
   **two separate tracks**, and transcribed **live in ~3-minute chunks while
   the meeting runs** — you can watch the transcript grow in the window.
   Because the tracks are separate, the transcript is labeled: your words
   under your name, the other side under "Them". (Wear a headset for the
   cleanest split; without one, an echo filter removes speaker bleed.)
3. Click **Stop and make notes**. Since transcription happened during the
   meeting, the note usually lands moments later: summary, decisions, action
   items with owners taken from the speaker labels, and the full labeled
   transcript. Long meetings are summarized map-reduce style so quality holds
   up over an hour of audio.
4. Everything lands in `C:\Users\<you>\MeetingNotes\`:
   - `2026-07-31-1430.md` — summary + decisions + action items, then `---`,
     then the full transcript
   - `2026-07-31-1430.webm` — the audio, kept next to the note

Tray icon: cream ring = idle, red = recording, amber = making notes.

## Meeting detection

When another app starts using your microphone (Teams, Zoom, a Meet tab…),
a Turtle Talks card appears top-right: *"Meeting detected — take notes?"*
with **English notes** / **Nederlandse notities** buttons. When the meeting
ends while you're still recording, it nudges again: *"Meeting ended? Stop &
make notes."* Dismissing it never interrupts anything, and it never records
without you clicking.

## Dictation anywhere (Wispr Flow-style)

Press **Ctrl+Alt+T** (T for turtle) in any app (mail, Slack, browser…),
speak, press it again. A small pill at the bottom of the screen shows
listening / transcribing status, and the transcribed text is pasted at your
cursor (and left in the clipboard as a fallback). The language is
**auto-detected per utterance**, so you can dictate Dutch in one message and
English in the next without touching any setting.

Dictation uses the faster `small` whisper model by default so short utterances
come back in a few seconds. Configure in `.env`:

```
DICTATE_HOTKEY=Control+Alt+T       # any Electron accelerator
DICTATE_MODEL=ggml-small.bin       # ggml-medium.bin for max accuracy
DICTATE_LANG=auto                  # or force nl / en
```

## Install

### From a release (easiest)

1. Download **Turtle Talks Setup x.x.x.exe** from the
   [latest release](https://github.com/joepweterman/turtle-talks/releases/latest)
   and run it (per-user install, no admin needed). Windows SmartScreen may warn
   because the app is unsigned: choose "More info", then "Run anyway". If
   **Smart App Control** blocks the file outright (newer Windows 11 machines;
   no "run anyway" option), install from source instead — see below.
2. Download the speech models (~2 GB, one time, resumable) by pasting this in
   PowerShell:

   ```powershell
   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://raw.githubusercontent.com/joepweterman/turtle-talks/main/scripts/setup-whisper.ps1 -OutFile $env:TEMP\tt-setup.ps1; & $env:TEMP\tt-setup.ps1 -Dest $env:USERPROFILE\MeetingNotes\whisper"
   ```

3. Grant the microphone permission (below) and optionally set up a summarizer.
   Without one you still get full transcripts, just no AI summary.

### From source

Requirements: Node.js 18+ (tested on 24) and ~2.5 GB of disk for the models.

```powershell
git clone https://github.com/joepweterman/turtle-talks.git
cd turtle-talks
npm install
npm run setup     # whisper.cpp + medium & small models (resumable)
npm start         # or: npm run dist  → installer in dist\
```

The installed app looks for `whisper\` and `.env` in
`C:\Users\<you>\MeetingNotes\`; running from source finds them in the project
folder or there.

### Permissions you need to grant

- **Microphone**: Windows Settings → Privacy & security → Microphone →
  turn ON "Microphone access" and "Let desktop apps access your microphone".
- **System audio**: no permission needed — Windows loopback capture is built in.

### Summaries (pick one, or neither)

- **Fully local (default)**: install [Ollama](https://ollama.com/download) and
  pull a model: `ollama pull llama3.1:8b` (set via `OLLAMA_MODEL` in `.env`).
  If Ollama is running, it is always used first — nothing leaves your machine.
- **Claude API**: copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`.
  Used only when Ollama isn't available. The request is sent with Anthropic's
  server-side refusal fallback enabled, so a summary comes back even if a
  safety classifier declines the primary model.
- **Neither**: notes are still written with the full transcript and a note
  that no summary was generated. The app works completely offline.

## Speed

Meetings transcribe with **whisper large-v3-turbo** (quantized) plus voice
activity detection, which skips the silent stretches — measured at ~3-4× faster
than realtime on a laptop CPU, so an hour of meeting takes roughly 15-20
minutes to transcribe, with better accuracy than the older medium model
(especially for Dutch). Dictation uses the small model and comes back in a few
seconds. To trade accuracy for more speed, set `WHISPER_MODEL=ggml-small.bin`
in `.env`.

## Good to know

- **Loopback records ALL system audio** — notification pings and Spotify
  included. Mute what you don't want in the transcript.
- **Crash recovery**: audio is streamed to disk every second, so if the app
  dies mid-meeting the `.webm` survives. Re-run the pipeline on it with
  `node scripts/process.js C:\Users\<you>\MeetingNotes\<file>.webm nl` (or `en`).
- **Recording quality**: mic echo cancellation is on, so your speakers being
  audible in the room won't double up in the recording.
- **Self test**: `npm run selftest` records 15 seconds, runs the whole
  pipeline, and quits. Play some speech (or talk) while it runs.

