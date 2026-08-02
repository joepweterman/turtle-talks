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

Typography is the DIVR set (Lora, Hanken Grotesk, JetBrains Mono), bundled
locally so the app stays fully offline.

1. Click **Record EN** / **Opname NL** in the window (or right-click the tray
   icon). Picking the language up front is what tells Whisper which language
   to transcribe, so Dutch meetings don't get mangled.
2. System audio (whatever plays through your speakers/headset — Teams, Meet,
   Zoom) and your microphone are mixed and recorded.
3. Click **Stop and make notes**. The app converts the audio, runs whisper.cpp,
   generates the summary, and shows a Windows notification when the note is
   ready. Clicking the notification opens it.
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

### As a desktop app (recommended)

```powershell
git clone <this repo> meeting-notes
cd meeting-notes
npm install
npm run setup     # downloads whisper.cpp + the medium model (~1.5 GB, resumable)
npm run dist      # builds the installer into dist\
```

Run the installer from `dist\` — it adds **Turtle Talks** to the Start menu and
desktop. The installed app looks for `whisper\` and `.env` in
`C:\Users\<you>\MeetingNotes\` (move them there after `npm run setup`; running
from source finds them in either place).

### From source

Requirements: Node.js 18+ (tested on 24) and ~2 GB of disk for the model.
Same steps as above, then `npm start` (or a shortcut to `start.cmd` in
`shell:startup` to autostart).

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

Whisper **medium** on CPU is roughly realtime — an hour of meeting can take up
to an hour to transcribe. If that's too slow:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1 -Model small
```

and set `WHISPER_MODEL=ggml-small.bin` in `.env`. Small is ~4× faster and still
good for clean meeting audio (Dutch included).

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

