# Does any missing setup, then runs the gamepad server and the app together in this one window.
# Closing the window stops both.
$python = Join-Path $PSScriptRoot 'server\.venv\Scripts\python.exe'
$script = Join-Path $PSScriptRoot 'server\server.py'
$pinFile = Join-Path $PSScriptRoot 'server\.pin'
$app = Join-Path $PSScriptRoot 'app'

function Test-Ready {
  $driver = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like '*Virtual Gamepad Emulation Bus*' }
  $firewall = Get-NetFirewallRule -DisplayName 'Phone Pad' -ErrorAction SilentlyContinue
  (Test-Path $python) -and [bool]$driver -and [bool]$firewall
}

if (-not (Test-Ready)) {
  Write-Host 'First-time setup: click Yes when Windows asks for permission.'
  try {
    Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'setup.ps1')`""
  } catch {
    Write-Host 'Setup needs that permission to install the gamepad driver. Open Phone Pad again and click Yes.'
    exit 1
  }
  if (-not (Test-Ready)) {
    Write-Host 'Setup did not finish. Open Phone Pad again to retry.'
    exit 1
  }
}

if (-not (Test-Path (Join-Path $app 'node_modules'))) {
  Write-Host 'Installing the app files, this only happens once...'
  npm install --prefix $app --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Host 'Could not install the app files. Check the error above.'; exit 1 }
}

# A session left open would hold the ports. Only this project's own processes are stopped.
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like "*$script*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
  $metro = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
  if ($metro.CommandLine -like '*expo*') { Stop-Process -Id $metro.ProcessId -Force -ErrorAction SilentlyContinue }
}

$server = Start-Process $python -ArgumentList "`"$script`"" -NoNewWindow -PassThru
Start-Sleep -Seconds 2
if ($server.HasExited) {
  Write-Host 'The gamepad server stopped. Check the error above.'
  exit 1
}
$pin = (Get-Content $pinFile -ErrorAction SilentlyContinue | Select-Object -First 1)
$Host.UI.RawUI.WindowTitle = "Phone Pad  -  pairing code $pin"

# With a USB or Bluetooth hotspot up, serve the app over it so no Wi-Fi is needed.
$hotspot = Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -like '172.20.10.*' | Select-Object -First 1
if ($hotspot) { $env:REACT_NATIVE_PACKAGER_HOSTNAME = $hotspot.IPAddress }

# Builds the browser controller if needed and opens the friends' QR code. If it can't, Expo Go still works.
& $python (Join-Path $PSScriptRoot 'server\invite.py')

Write-Host "`n  Friends, no install: scan the QR code in the browser window that just opened."
Write-Host "  Your phone: open Expo Go and tap Phone Pad under Recently Opened."
Write-Host "  New Expo Go phone? Scan the QR code below and enter code $pin.`n"

try {
  Set-Location $app
  # Production mode: dev mode's overhead on the JS thread would add input latency.
  npx expo start --go --no-dev --minify
} finally {
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
