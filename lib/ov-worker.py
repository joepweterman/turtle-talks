# Persistent OpenVINO whisper worker: loads the model once (GPU), then serves
# transcription requests over stdin/stdout as JSON lines. Spawned by
# lib/ovengine.js when ~\MeetingNotes\ov exists; Turtle Talks falls back to
# whisper.cpp whenever this worker is missing, still loading, or crashed.
import sys, json, time, wave

import numpy as np
import openvino_genai

model_dir, device = sys.argv[1], sys.argv[2]
t0 = time.time()
pipe = openvino_genai.WhisperPipeline(model_dir, device)
print(json.dumps({"ready": True, "load_s": round(time.time() - t0, 1)}), flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    rid = None
    try:
        req = json.loads(line)
        rid = req.get("id")
        with wave.open(req["wav"], "rb") as w:
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        audio = pcm.astype(np.float32) / 32768.0
        cfg = pipe.get_generation_config()
        if req.get("lang"):
            cfg.language = "<|%s|>" % req["lang"]
            cfg.task = "transcribe"
        if req.get("prompt"):
            cfg.initial_prompt = req["prompt"]
        r = pipe.generate(audio, cfg)
        print(json.dumps({"id": rid, "ok": True, "text": str(r)}), flush=True)
    except Exception as e:  # noqa: BLE001 — report anything to the app, keep serving
        print(json.dumps({"id": rid, "ok": False, "error": str(e)[:300]}), flush=True)
