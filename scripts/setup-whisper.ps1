# Downloads the whisper.cpp Windows binary and a ggml model into ./whisper
# Usage: npm run setup            (BLAS-accelerated build + medium model)
#        powershell -ExecutionPolicy Bypass -File scripts/setup-whisper.ps1 -Model small
param(
    [string]$Dest = (Join-Path (Split-Path $PSScriptRoot -Parent) 'whisper'),
    [string]$Model = 'medium'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Dest | Out-Null

$exe = Get-ChildItem $Dest -Recurse -Include whisper-cli.exe, main.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($exe) {
    Write-Host "whisper binary already present: $($exe.FullName)"
} else {
    Write-Host "Fetching latest whisper.cpp release info..."
    $rel = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest'
    # Prefer the OpenBLAS-accelerated CPU build, fall back to the plain one
    $asset = $rel.assets | Where-Object { $_.name -match '^whisper-blas-bin-x64\.zip$' } | Select-Object -First 1
    if (-not $asset) { $asset = $rel.assets | Where-Object { $_.name -match '^whisper-bin-x64\.zip$' } | Select-Object -First 1 }
    if (-not $asset) { throw "No Windows x64 binary found in release $($rel.tag_name). Assets: $($rel.assets.name -join ', ')" }
    $zip = Join-Path $env:TEMP $asset.name
    Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
    curl.exe -L --fail -sS -o $zip $asset.browser_download_url
    Expand-Archive -Force $zip $Dest
    Remove-Item $zip
    $exe = Get-ChildItem $Dest -Recurse -Include whisper-cli.exe, main.exe | Select-Object -First 1
    if ($exe) { Write-Host "whisper binary ready: $($exe.FullName)" } else { Write-Warning "No whisper-cli.exe found after extraction" }
}

$modelFile = Join-Path $Dest "ggml-$Model.bin"
if (Test-Path $modelFile) {
    Write-Host "Model already present: $modelFile"
} else {
    Write-Host "Downloading ggml-$Model.bin (medium is ~1.5 GB, this can take a while)..."
    # -C - resumes a partial download; retries cover flaky connections
    curl.exe -L --fail -sS -C - --retry 8 --retry-delay 3 --retry-all-errors `
        -o "$modelFile.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"
    if ($LASTEXITCODE -ne 0) { throw "Model download failed (curl exit $LASTEXITCODE). Re-run npm run setup to resume." }
    Move-Item "$modelFile.part" $modelFile
    Write-Host "Model ready: $modelFile"
}
Write-Host "Setup complete."
