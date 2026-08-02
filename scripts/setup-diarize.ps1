# Optional: local speaker detection (sherpa-onnx) for "multiple people in the
# room" mode. Downloads ~80 MB into ~\MeetingNotes\diarize.
param(
    [string]$Dest = (Join-Path $env:USERPROFILE 'MeetingNotes\diarize')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Dest | Out-Null
$v = 'v1.13.4'

$exe = Get-ChildItem $Dest -Recurse -Filter 'sherpa-onnx-offline-speaker-diarization.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) {
    Write-Host "Downloading sherpa-onnx $v..."
    $tar = Join-Path $env:TEMP 'sherpa.tar.bz2'
    curl.exe -L --fail -sS --retry 6 --retry-all-errors -o $tar "https://github.com/k2-fsa/sherpa-onnx/releases/download/$v/sherpa-onnx-$v-win-x64-shared-MD-Release-no-tts.tar.bz2"
    tar -xjf $tar -C $Dest
    Remove-Item $tar
}
if (-not (Test-Path (Join-Path $Dest 'sherpa-onnx-pyannote-segmentation-3-0\model.onnx'))) {
    Write-Host "Downloading segmentation model..."
    $tar = Join-Path $env:TEMP 'seg.tar.bz2'
    curl.exe -L --fail -sS --retry 6 --retry-all-errors -o $tar "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
    tar -xjf $tar -C $Dest
    Remove-Item $tar
}
if (-not (Test-Path (Join-Path $Dest 'embedding.onnx'))) {
    Write-Host "Downloading speaker embedding model..."
    curl.exe -L --fail -sS --retry 6 --retry-all-errors -o (Join-Path $Dest 'embedding.onnx') "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx"
}
Write-Host "Speaker detection ready. Enable 'Multiple people in the room' in Turtle Talks settings."
