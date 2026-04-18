# sync-inbox.ps1
#
# Holt neue .md-Dateien aus Google Drive `Enkephalos-Inbox/` via rclone
# und verschiebt sie ins lokale Vault `<Enkephalos>/inbox/`. Quell-Dateien
# werden nach erfolgreichem Transfer in Drive geloescht (rclone move).
#
# Setup-Voraussetzungen (einmalig):
#   1. rclone installiert (winget install Rclone.Rclone)
#   2. Remote `gdrive` konfiguriert (rclone config reconnect gdrive:)
#
# Aufruf manuell:
#   powershell -ExecutionPolicy Bypass -File .\scripts\sync-inbox.ps1
#
# Oder als Task-Scheduler-Task alle 5 Minuten (siehe docs/laptop-sync.md).

# ---------- Konfiguration ----------

$RcloneExe    = "$env:LOCALAPPDATA\Microsoft\WinGet\Links\rclone.exe"
$RcloneRemote = "gdrive:Enkephalos-Inbox"
$VaultInbox   = "$env:USERPROFILE\OneDrive\Enkephalos\inbox"
$LogFile      = "$env:USERPROFILE\OneDrive\Enkephalos\sync-inbox.log"

# ---------- Ausfuehrung ----------

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message)
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "$ts  $Message"
    Write-Host $line
    if ($LogFile) {
        try {
            $dir = Split-Path -Parent $LogFile
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Add-Content -Path $LogFile -Value $line -Encoding UTF8
        } catch {
            # Logging-Fehler nicht eskalieren
        }
    }
}

if (-not (Test-Path -LiteralPath $RcloneExe)) {
    Write-Log "rclone nicht gefunden: $RcloneExe -- Abbruch. Installation: winget install Rclone.Rclone"
    exit 1
}

if (-not (Test-Path -LiteralPath $VaultInbox)) {
    New-Item -ItemType Directory -Path $VaultInbox -Force | Out-Null
    Write-Log "Vault-Inbox angelegt: $VaultInbox"
}

# rclone schreibt INFO/NOTICE auf stderr. PowerShell 5.1 wuerde das bei
# ErrorActionPreference=Stop als Exception werten, auch wenn rclone exit 0
# liefert. Deshalb lokal nur fuer den rclone-Aufruf relaxen.
$output = $null
$code = 0
try {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & $RcloneExe move $RcloneRemote $VaultInbox --include "*.md" --stats 0 -v 2>&1
    $code = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $prev
}

$moved = 0
foreach ($line in $output) {
    $text = [string]$line
    if ($text -match "INFO\s+:\s+(.+):\s+Copied \(new\)") {
        Write-Log "Moved: $($matches[1])"
        $moved++
    }
    elseif ($text -match "ERROR|Failed") {
        Write-Log "rclone: $text"
    }
}

if ($code -ne 0) {
    Write-Log "rclone exit=$code -- Lauf fehlgeschlagen."
    exit $code
}

if ($moved -gt 0) {
    Write-Log "Lauf beendet: $moved verschoben."
}
