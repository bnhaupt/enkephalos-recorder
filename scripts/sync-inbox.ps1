# sync-inbox.ps1
#
# Verschiebt neue .md-Dateien aus dem Google-Drive-Sync-Ordner
# `Enkephalos-Inbox/` nach `<Enkephalos>/inbox/` im lokalen Vault.
#
# Aufruf manuell:
#   powershell -ExecutionPolicy Bypass -File .\scripts\sync-inbox.ps1
#
# Oder als Task Scheduler Task alle 5 Minuten (siehe docs/laptop-sync.md §3).

# ---------- Konfiguration ----------
# Pfade an die eigene Installation anpassen. Vorlage gemaess
# docs/laptop-sync.md; den tatsaechlichen Drive-Pfad sieht man im
# Google-Drive-Desktop-Client (z.B. `G:\Meine Ablage\Enkephalos-Inbox`).

$DriveInbox = "G:\Meine Ablage\Enkephalos-Inbox"
$VaultInbox = "$env:USERPROFILE\OneDrive\Enkephalos\inbox"
$LogFile    = "$env:USERPROFILE\OneDrive\Enkephalos\sync-inbox.log"

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

if (-not (Test-Path -LiteralPath $DriveInbox)) {
    Write-Log "Drive-Inbox nicht gefunden: $DriveInbox -- ueberspringe."
    exit 0
}

if (-not (Test-Path -LiteralPath $VaultInbox)) {
    New-Item -ItemType Directory -Path $VaultInbox -Force | Out-Null
    Write-Log "Vault-Inbox angelegt: $VaultInbox"
}

$files = Get-ChildItem -LiteralPath $DriveInbox -Filter "*.md" -File -ErrorAction SilentlyContinue
if (-not $files -or $files.Count -eq 0) {
    exit 0
}

$moved = 0
$skipped = 0
foreach ($f in $files) {
    $target = Join-Path $VaultInbox $f.Name
    if (Test-Path -LiteralPath $target) {
        Write-Log "Skip (existiert schon): $($f.Name)"
        $skipped++
        continue
    }
    try {
        Move-Item -LiteralPath $f.FullName -Destination $target
        Write-Log "Moved: $($f.Name)"
        $moved++
    } catch {
        Write-Log "Fehler bei $($f.Name): $_"
    }
}

if ($moved -gt 0 -or $skipped -gt 0) {
    Write-Log "Lauf beendet: $moved verschoben, $skipped uebersprungen."
}
