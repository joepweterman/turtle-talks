# Optional: GPU-accelerated dictation via OpenVINO (Intel iGPU/Arc).
# Creates ~\MeetingNotes\ov with a Python venv + a converted whisper model.
# Turtle Talks picks it up automatically on next start; without it the app
# simply keeps using whisper.cpp on the CPU.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/setup-openvino.ps1
param(
    # medium = more accurate than whisper.cpp small AND ~4x faster on an iGPU.
    # Alternative: OpenVINO/whisper-large-v3-int8-ov (best accuracy, ~2x slower)
    [string]$Model = 'OpenVINO/whisper-medium-int8-ov'
)
$ErrorActionPreference = 'Stop'
$Dest = Join-Path $env:USERPROFILE 'MeetingNotes\ov'
New-Item -ItemType Directory -Force $Dest | Out-Null

$py = Join-Path $Dest 'venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
    Write-Host "Creating Python venv..."
    py -3.12 -m venv (Join-Path $Dest 'venv')
    if (-not (Test-Path $py)) { throw "Python 3.12 not found - install it from python.org first" }
    & $py -m pip install --quiet --upgrade pip
    Write-Host "Installing openvino-genai..."
    & $py -m pip install --quiet openvino-genai huggingface_hub
}

$modelDir = Join-Path $Dest ($Model.Split('/')[1])
if (-not (Test-Path (Join-Path $modelDir 'openvino_encoder_model.xml'))) {
    Write-Host "Downloading $Model..."
    & $py -c "from huggingface_hub import snapshot_download; snapshot_download('$Model', local_dir=r'$modelDir')"
}
Write-Host "Done. Restart Turtle Talks - dictation will use the GPU automatically."
