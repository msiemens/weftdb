# Renders the demo page headlessly and writes a screenshot, so a change to the material can be
# looked at rather than guessed at. Chrome gets its own profile directory and the demo gets its
# own ports, so this never touches a browser or a dev server already running on this machine.
param(
  [string]$Out = "D:\Education\weftdb\shot.png",
  [int]$Width = 1440,
  [int]$Height = 1000,
  [int]$Port = 5301,
  [int]$RelayPort = 8801
)

$job = Start-Job -ArgumentList $Port, $RelayPort -ScriptBlock {
  param($Port, $RelayPort)
  cd D:\Education\weftdb\packages\weft-demo
  $env:WEFT_DEMO_PORT = "$Port"
  $env:WEFT_DEMO_RELAY_PORT = "$RelayPort"
  $env:WEFT_DEMO_DB = "shot.sqlite"
  node dev.ts
}
try {
  # Wait for the page to answer rather than guessing at a sleep.
  $ready = $false
  foreach ($attempt in 1..40) {
    Start-Sleep -Seconds 1
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch { }
  }
  if (-not $ready) {
    Write-Output "the demo never came up"
    Receive-Job $job | Select-Object -First 8
    return
  }

  Remove-Item $Out -ErrorAction SilentlyContinue
  & 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
    --headless=new --disable-gpu --hide-scrollbars `
    --user-data-dir='D:\Education\weftdb\.chrome-shot' `
    --window-size="$Width,$Height" --virtual-time-budget=5000 `
    --screenshot=$Out "http://127.0.0.1:$Port/" 2>$null | Out-Null
  Start-Sleep -Seconds 2
  if (Test-Path $Out) { Write-Output ("shot " + (Get-Item $Out).Length + " bytes") } else { Write-Output "no screenshot" }
} finally {
  Stop-Job $job
  Remove-Job $job -Force
}
