# MeetingNotes

A local, private meeting-notes app for Windows. It sits in the system tray,
records **system audio + microphone**, transcribes with **whisper.cpp** on your
own machine, and writes a markdown note with a 5-bullet summary, decisions, and
action items.

No accounts, no cloud storage, no telemetry. Everything stays on this machine.
The only optional network calls are to Anthropic's API for summaries — and even
that is skipped if you run [Ollama](https://ollama.com) locally.

## How it works

1. Right-click the tray icon → **Start recording (English)** or
   **Start opname (Nederlands)**. Picking the language up front is what tells
   Whisper which language to transcribe, so Dutch meetings don't get mangled.
2. System audio (whatever plays through your speakers/headset — Teams, Meet,
   Zoom) and your microphone are mixed and recorded.
3. Click **Stop and make notes**. The app converts the audio, runs whisper.cpp,
   generates the summary, and shows a Windows notification when the note is
   ready. Clicking the notification opens it.
4. Everything lands in `C:\Users\<you>\MeetingNotes\`:
   - `2026-07-31-1430.md` — summary + decisions + action items, then `---`,
     then the full transcript
   - `2026-07-31-1430.webm` — the audio, kept next to the note

Tray icon: gray ring = idle, red = recording, amber = making notes.

## Install

Requirements: Node.js 18+ (tested on 24) and ~2 GB of disk for the model.

```powershell
git clone <this repo> meeting-notes
cd meeting-notes
npm install
npm run setup     # downloads whisper.cpp + the medium model (~1.5 GB, resumable)
npm start
```

### Permissions you need to grant

- **Microphone**: Windows Settings → Privacy & security → Microphone →
  turn ON "Microphone access" and "Let desktop apps access your microphone".
- **System audio**: no permission needed — Windows loopback capture is built in.

### Summaries (pick one, or neither)

- **Fully local**: install [Ollama](https://ollama.com/download) and pull a
  model, e.g. `ollama pull llama3.1:8b`. If Ollama is running, it is always
  used first — nothing leaves your machine.
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

## Packaged build (optional)

`npm run dist` builds an installer into `dist\`. A packaged install looks for
`whisper\` and `.env` inside `C:\Users\<you>\MeetingNotes\` instead of the
project folder — move/copy them there. Running from source with `npm start`
works just as well for daily use; to autostart, put a shortcut to
`meeting-notes\start.cmd` in `shell:startup`.
