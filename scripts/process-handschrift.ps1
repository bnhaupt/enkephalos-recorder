# process-handschrift.ps1
#
# Holt handschriftliche reMarkable-Notizen aus Google Drive
# `Enkephalos-Handschrift/`, laesst sie von Claude Code headless
# transkribieren und legt das Ergebnis in die Vault-Inbox.
#
# Drive-Struktur:
#   Enkephalos-Handschrift/<datei>.pdf              -> kind: handwriting
#   Enkephalos-Handschrift/JF/<reihe>/<datei>.pdf    -> kind: jf, jf_reihe: <reihe>
#
# reMarkable vergibt beim Export keinen zuverlaessigen Dateinamen (z.B.
# "Notizbuch.pdf") -- das Datum der Notiz kommt daher vorrangig aus dem
# Seiteninhalt selbst, nicht aus dem Dateinamen. Fallback ist der Drive-
# Aenderungszeitstempel der Datei.
#
# Nach erfolgreicher Verarbeitung wandert die Quelle in einen Unterordner
# "verarbeitet" am jeweiligen Ort. Bei Fehlschlag nach "fehler", damit die
# Datei nicht bei jedem Lauf erneut versucht wird, aber auffindbar bleibt.
#
# Setup-Voraussetzungen (einmalig): wie process-auftraege.ps1
#   1. rclone installiert, Remote `gdrive` konfiguriert
#   2. Claude Code CLI installiert und angemeldet (`claude` im PATH)
#
# Aufruf manuell:
#   powershell -ExecutionPolicy Bypass -File .\scripts\process-handschrift.ps1
#
# Als Scheduled Task alle 5 Minuten (analog Enkephalos Inbox Sync).

# ---------- Konfiguration ----------

$RcloneExe        = "$env:LOCALAPPDATA\Microsoft\WinGet\Links\rclone.exe"
$RemoteRoot       = "gdrive:Enkephalos-Handschrift"
$VaultInbox       = "$env:USERPROFILE\OneDrive\Enkephalos\inbox"
$WorkRoot         = "$env:LOCALAPPDATA\voice-pipeline\handschrift"
$LogFile          = "$env:USERPROFILE\OneDrive\05_DEV\voice-pipeline\logs\handschrift.log"
$AnweisungFile    = Join-Path $PSScriptRoot "handschrift-anweisung.md"
$AbkuerzungenFile = Join-Path $PSScriptRoot "handschrift-abkuerzungen.md"

# Zeitlimit pro Notiz. Transkription einer Einzelseite ist schnell; grosszuegig
# bemessen fuer mehrseitige JF-Mitschriften.
$TimeoutMinutes = 10

# Wie lange eine Sperrdatei gilt, bevor sie als verwaist betrachtet wird.
$LockStaleMinutes = 30

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

# rclone schreibt INFO/NOTICE auf stderr. Unter ErrorActionPreference=Stop
# wuerde PowerShell 5.1 das als Exception werten, auch bei exit 0. Deshalb
# nur fuer den Aufruf selbst relaxen -- gleiche Loesung wie in den anderen
# Skripten dieses Verzeichnisses.
function Invoke-Rclone {
    param([string[]]$RcArgs)
    $prev = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $out = & $RcloneExe @RcArgs 2>&1
        return [pscustomobject]@{ Output = $out; Code = $LASTEXITCODE }
    } finally {
        $ErrorActionPreference = $prev
    }
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

# ---------- Vorbedingungen ----------

if (-not (Test-Path -LiteralPath $RcloneExe)) {
    Write-Log "rclone nicht gefunden: $RcloneExe -- Abbruch."
    exit 1
}

$ClaudeExe = $null
foreach ($cand in @("claude.cmd", "claude")) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $ClaudeExe = $cmd.Source; break }
}
if (-not $ClaudeExe) {
    Write-Log "Claude Code CLI nicht im PATH gefunden -- Abbruch."
    exit 1
}

foreach ($f in @($AnweisungFile, $AbkuerzungenFile)) {
    if (-not (Test-Path -LiteralPath $f)) {
        Write-Log "Betriebsdatei fehlt: $f -- Abbruch."
        exit 1
    }
}

foreach ($d in @($VaultInbox, $WorkRoot)) {
    if (-not (Test-Path -LiteralPath $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        Write-Log "Verzeichnis angelegt: $d"
    }
}

# ---------- Sperre ----------

$LockFile = Join-Path $WorkRoot ".lock"
if (Test-Path -LiteralPath $LockFile) {
    $age = (Get-Date) - (Get-Item -LiteralPath $LockFile).LastWriteTime
    if ($age.TotalMinutes -lt $LockStaleMinutes) {
        # Kein Log-Eintrag: das ist der Normalfall waehrend einer Bearbeitung.
        exit 0
    }
    Write-Log "Verwaiste Sperre ($([int]$age.TotalMinutes) Min alt) wird uebernommen."
}
Write-Utf8NoBom -Path $LockFile -Content "$PID  $(Get-Date -Format 's')"

try {

    # ---------- Offene Notizen ermitteln ----------

    $r = Invoke-Rclone @("lsjson", $RemoteRoot, "-R")
    if ($r.Code -ne 0) {
        Write-Log "Drive-Liste fehlgeschlagen (exit $($r.Code)) -- Abbruch."
        exit 1
    }

    $eintraege = @()
    try {
        $eintraege = ($r.Output -join "`n") | ConvertFrom-Json
    } catch {
        Write-Log "Drive-Liste nicht als JSON lesbar -- Abbruch."
        exit 1
    }

    $pending = @($eintraege | Where-Object {
        -not $_.IsDir -and
        $_.Path -like "*.pdf" -and
        $_.Path -notmatch "(^|/)(verarbeitet|fehler)/"
    })

    if ($pending.Count -eq 0) { exit 0 }
    Write-Log "$($pending.Count) neue Handschrift-Notiz(en) gefunden."

    $anweisung    = Get-Content -LiteralPath $AnweisungFile -Raw -Encoding UTF8
    $abkuerzungen = Get-Content -LiteralPath $AbkuerzungenFile -Raw -Encoding UTF8

    foreach ($entry in $pending) {

        $relPath = $entry.Path
        $modTime = $entry.ModTime
        Write-Log "--- $relPath ---"

        $isJf = $relPath -match "^JF/([^/]+)/"
        $jfReihe = if ($isJf) { $matches[1] } else { $null }
        $kind = if ($isJf) { "jf" } else { "handwriting" }

        $safeStem = ($relPath -replace "\.pdf$", "") -replace "[\\/]", "_"
        $workDir = Join-Path $WorkRoot $safeStem
        if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
        New-Item -ItemType Directory -Path $workDir -Force | Out-Null

        $localPdf = Join-Path $workDir ([System.IO.Path]::GetFileName($relPath))
        $r = Invoke-Rclone @("copyto", "$RemoteRoot/$relPath", $localPdf)
        if ($r.Code -ne 0 -or -not (Test-Path -LiteralPath $localPdf)) {
            Write-Log "Download fehlgeschlagen (exit $($r.Code)): $relPath"
            continue
        }

        # ---------- Prompt bauen ----------

        $auftragsdetails = @"
- Lokaler Pfad der PDF: $localPdf
- kind: $kind
$(if ($isJf) { "- jf_reihe: $jfReihe" })
- Datei-Zeitstempel in Drive (Fallback fuer captured, nur falls im Text kein Datum steht): $modTime
"@

        $prompt = @"
$anweisung

---

## Abkuerzungslegende

$abkuerzungen

---

## Auftragsdetails

$auftragsdetails
"@

        $promptFile = Join-Path $workDir "_prompt.txt"
        $outFile    = Join-Path $workDir "_stdout.txt"
        $errFile    = Join-Path $workDir "_stderr.txt"
        Write-Utf8NoBom -Path $promptFile -Content $prompt

        # ---------- Claude Code headless ----------
        #
        # Nur Lesezugriff: Claude bekommt in keinem Profil Schreibrechte.
        # Kein Web noetig, keine Recherche -- reine Transkriptionsaufgabe.
        $claudeArgs = @(
            "-p", "--permission-mode", "acceptEdits",
            "--allowedTools", "Read",
            "--disallowedTools", "Write", "Edit", "NotebookEdit", "Bash", "WebSearch", "WebFetch"
        )

        Write-Log "Starte Transkription (kind=$kind, Zeitlimit $TimeoutMinutes Min)."
        $started = Get-Date
        $ok = $false
        $fehlerText = ""

        try {
            $proc = Start-Process -FilePath $ClaudeExe -ArgumentList $claudeArgs `
                -WorkingDirectory $workDir -NoNewWindow -PassThru `
                -RedirectStandardInput $promptFile `
                -RedirectStandardOutput $outFile `
                -RedirectStandardError $errFile

            # Ohne diesen Zugriff cached PowerShell das Prozess-Handle nicht
            # und ExitCode bleibt anschliessend leer.
            $null = $proc.Handle

            if (-not $proc.WaitForExit($TimeoutMinutes * 60 * 1000)) {
                try { $proc.Kill() } catch {}
                $fehlerText = "Zeitlimit von $TimeoutMinutes Minuten ueberschritten."
            } else {
                $exit = $null
                try { $exit = $proc.ExitCode } catch {}
                if ($null -ne $exit -and $exit -ne 0) {
                    $stderr = ""
                    if (Test-Path -LiteralPath $errFile) {
                        $stderr = (Get-Content -LiteralPath $errFile -Raw -Encoding UTF8)
                    }
                    $fehlerText = "Claude beendet mit exit $exit.`n`n$stderr"
                } else {
                    $ok = $true
                }
            }
        } catch {
            $fehlerText = "Start fehlgeschlagen: $($_.Exception.Message)"
        }

        $dauer = [int]((Get-Date) - $started).TotalSeconds

        $ergebnis = ""
        if ($ok) {
            if (Test-Path -LiteralPath $outFile) {
                $ergebnis = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8).Trim()
            }
            if (-not $ergebnis) {
                $ok = $false
                $fehlerText = "Claude lieferte eine leere Antwort."
            }
        }

        # ---------- Ergebnis ablegen bzw. Fehlschlag behandeln ----------

        $parent = Split-Path -Path $relPath -Parent
        $leaf   = Split-Path -Path $relPath -Leaf
        # Split-Path liefert unter Windows Backslashes zurueck; rclone-Pfade
        # sind aber immer Slash-getrennt.
        if ($parent) { $parent = $parent -replace "\\", "/" }

        if ($ok) {
            $zeitstempel = Get-Date -Format "yyyyMMdd-HHmmss"
            $ergebnisName = if ($isJf) { "$zeitstempel-jf-$jfReihe.md" } else { "$zeitstempel-handschrift.md" }
            $zielPfad = Join-Path $VaultInbox $ergebnisName
            Write-Utf8NoBom -Path $zielPfad -Content $ergebnis

            $zielOrdner = if ($parent) { "$parent/verarbeitet" } else { "verarbeitet" }
            Invoke-Rclone @("mkdir", "$RemoteRoot/$zielOrdner") | Out-Null
            $mv = Invoke-Rclone @("moveto", "$RemoteRoot/$relPath", "$RemoteRoot/$zielOrdner/$leaf")
            if ($mv.Code -ne 0) {
                Write-Log "Quelle verschieben fehlgeschlagen (exit $($mv.Code)): $relPath -- Ergebnis liegt trotzdem in der Inbox."
            }

            Write-Log "Erledigt in ${dauer}s -> $ergebnisName"
            Remove-Item -LiteralPath $workDir -Recurse -Force
        } else {
            $zielOrdner = if ($parent) { "$parent/fehler" } else { "fehler" }
            Invoke-Rclone @("mkdir", "$RemoteRoot/$zielOrdner") | Out-Null
            Invoke-Rclone @("moveto", "$RemoteRoot/$relPath", "$RemoteRoot/$zielOrdner/$leaf") | Out-Null

            Write-Log "FEHLGESCHLAGEN nach ${dauer}s: $fehlerText"
            # Arbeitsverzeichnis bleibt fuer die Fehlersuche liegen (Prompt, stderr).
        }
    }

} finally {
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}
