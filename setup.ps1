#Requires -RunAsAdministrator
# One-time laptop setup: Python packages, the firewall rule, and the virtual gamepad driver.
$ErrorActionPreference = 'Stop'
$server = Join-Path $PSScriptRoot 'server'
$python = Join-Path $server '.venv\Scripts\python.exe'

if (-not (Test-Path $python)) { python -m venv (Join-Path $server '.venv') }
# Installed explicitly below, so pip doesn't stop to open the installer itself.
$env:VGAMEPAD_SKIP_VIGEMBUS_INSTALL = 'true'
& $python -m pip install -q -r (Join-Path $server 'requirements.txt')

# Before the driver: its installer can be closed or reboot the laptop, which must not skip this.
# Only devices on the same network or tether can reach these ports.
Remove-NetFirewallRule -DisplayName 'Phone Pad' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'Phone Pad' -Direction Inbound -Protocol TCP -LocalPort 8765, 8081 `
  -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null

function Test-Driver {
  [bool](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like '*Virtual Gamepad Emulation Bus*' })
}
if (-not (Test-Driver)) {
  $msi = Join-Path $server '.venv\Lib\site-packages\vgamepad\win\vigem\install\x64\ViGEmBusSetup_x64.msi'
  Start-Process msiexec -ArgumentList '/i', "`"$msi`"" -Wait
}

$firewallOk = [bool](Get-NetFirewallRule -DisplayName 'Phone Pad' -ErrorAction SilentlyContinue)
$driverOk = Test-Driver
Write-Host "Firewall rule: $(if ($firewallOk) { 'OK' } else { 'MISSING' })"
Write-Host "Gamepad driver: $(if ($driverOk) { 'OK' } else { 'MISSING' })"
if ($firewallOk -and $driverOk) {
  Write-Host 'Done. Install Apple Devices from the Microsoft Store to use the USB cable, then run start.ps1.'
} else {
  Write-Host 'Setup is incomplete. Run this script again.'
  exit 1
}
