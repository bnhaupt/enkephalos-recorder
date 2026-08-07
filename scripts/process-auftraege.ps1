# process-auftraege.ps1
#
# Holt diktierte Arbeitsauftraege aus Google Drive `Enkephalos-Auftraege/`,
# laesst sie von Claude Code headless bearbeiten und legt das Ergebnis in die
# Vault-Inbox. Der Status wird ueber die Drive-Ordnerstruktur zurueckgemeldet,
# damit die PWA ihn ohne zusaetzliche Berechtigung lesen kann:
#
#   Enkephalos-Auftraege/            offen
#   Enkephalos-Auftraege/in-arbeit/  wird gerade bearbeitet
#   Enkephalos-Auftraege/fertig/     erledigt
#   Enkephalos-Auftraege/fehler/     fehlgeschlagen
#
# Der Trick dabei: rclone verschiebt serverseitig, die Drive-Datei-ID bleibt
# erhalten. Die PWA hat die Datei selbst angelegt und darf sie deshalb unter
# dem Scope `drive.file` weiterhin abfragen — sie liest schlicht ab, in
# welchem Ordner die Datei inzwischen liegt.
#
# Schreibgrenze: Claude bekommt in keinem Profil Schreibrechte auf das Vault.
# Das Ergebnis kommt ueber stdout zurueck, die Datei schreibt dieses Skript.
#
# Setup-Voraussetzungen (einmalig):
#   1. rclone installiert, Remote `gdrive` konfiguriert (wie sync-inbox.ps1)
#   2. Claude Code CLI installiert und angemeldet (`claude` im PATH)
#
# Aufruf manuell:
#   powershell -ExecutionPolicy Bypass -File .\scripts\process-auftraege.ps1
#
# Als Task-Scheduler-Task alle 5 Minuten (siehe docs/auftrag-modus.md).

# ---------- Konfiguration ----------

$RcloneExe      = "$env:LOCALAPPDATA\Microsoft\WinGet\Links\rclone.exe"
$RemoteRoot     = "gdrive:Enkephalos-Auftraege"
$VaultInbox     = "$env:USERPROFILE\OneDrive\Enkephalos\inbox"
$OneDriveInbox  = "$env:USERPROFILE\OneDrive\00_INBOX"
$VaultRoot      = "$env:USERPROFILE\OneDrive\Enkephalos"
$WorkRoot       = "$env:LOCALAPPDATA\voice-pipeline\auftraege"
$LogFile        = "$env:USERPROFILE\OneDrive\05_DEV\voice-pipeline\logs\auftraege.log"
$AnweisungFile  = Join-Path $PSScriptRoot "auftrag-anweisung.md"

# Zeitlimit pro Auftrag. Ein entgleister Lauf darf die Warteschlange nicht
# blockieren; eine grosse Recherche braucht aber durchaus zehn Minuten.
$TimeoutMinutes = 20

# Wie lange eine Sperrdatei gilt, bevor sie als verwaist betrachtet wird.
$LockStaleMinutes = 45

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
# nur fuer den Aufruf selbst relaxen — gleiche Loesung wie in sync-inbox.ps1.
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

if (-not (Test-Path -LiteralPath $AnweisungFile)) {
    Write-Log "Betriebsanweisung fehlt: $AnweisungFile -- Abbruch."
    exit 1
}

foreach ($d in @($VaultInbox, $OneDriveInbox, $WorkRoot)) {
    if (-not (Test-Path -LiteralPath $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
        Write-Log "Verzeichnis angelegt: $d"
    }
}

# ---------- Sperre ----------

# Der Task laeuft alle 5 Minuten, ein Auftrag kann 15 dauern. Ohne Sperre
# wuerde der naechste Lauf denselben Auftrag ein zweites Mal starten.
$LockFile = Join-Path $WorkRoot ".lock"
if (Test-Path -LiteralPath $LockFile) {
    $age = (Get-Date) - (Get-Item -LiteralPath $LockFile).LastWriteTime
    if ($age.TotalMinutes -lt $LockStaleMinutes) {
        # Kein Log-Eintrag: das ist der Normalfall waehrend einer Bearbeitung
        # und wuerde das Protokoll alle 5 Minuten zumuellen.
        exit 0
    }
    Write-Log "Verwaiste Sperre ($([int]$age.TotalMinutes) Min alt) wird uebernommen."
}
Write-Utf8NoBom -Path $LockFile -Content "$PID  $(Get-Date -Format 's')"

try {

    # ---------- Drive-Struktur sicherstellen ----------

    foreach ($sub in @("", "/in-arbeit", "/fertig", "/fehler")) {
        $r = Invoke-Rclone @("mkdir", "$RemoteRoot$sub")
        if ($r.Code -ne 0) {
            Write-Log "Drive-Ordner '$RemoteRoot$sub' nicht anlegbar (exit $($r.Code)) -- Abbruch."
            exit 1
        }
    }

    # ---------- Offene Auftraege auflisten ----------

    $r = Invoke-Rclone @("lsf", $RemoteRoot, "--files-only", "--include", "*.md")
    if ($r.Code -ne 0) {
        Write-Log "Drive-Liste fehlgeschlagen (exit $($r.Code)) -- Abbruch."
        exit 1
    }
    $pending = @($r.Output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -like "*.md" })

    if ($pending.Count -eq 0) { exit 0 }
    Write-Log "$($pending.Count) offene(r) Auftrag/Auftraege gefunden."

    # ---------- Bearbeiten ----------

    $anweisung = Get-Content -LiteralPath $AnweisungFile -Raw -Encoding UTF8

    foreach ($name in $pending) {

        Write-Log "--- $name ---"
        $stem = [System.IO.Path]::GetFileNameWithoutExtension($name)
        $workDir = Join-Path $WorkRoot $stem
        if (Test-Path -LiteralPath $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
        New-Item -ItemType Directory -Path $workDir -Force | Out-Null

        # Zuerst beanspruchen, dann herunterladen. Andersherum koennte ein
        # paralleler Lauf denselben Auftrag greifen.
        $r = Invoke-Rclone @("moveto", "$RemoteRoot/$name", "$RemoteRoot/in-arbeit/$name")
        if ($r.Code -ne 0) {
            Write-Log "Konnte Auftrag nicht nach in-arbeit verschieben (exit $($r.Code)) -- uebersprungen."
            continue
        }

        $localAuftrag = Join-Path $workDir $name
        $r = Invoke-Rclone @("copyto", "$RemoteRoot/in-arbeit/$name", $localAuftrag)
        if ($r.Code -ne 0 -or -not (Test-Path -LiteralPath $localAuftrag)) {
            Write-Log "Download fehlgeschlagen (exit $($r.Code))."
            Invoke-Rclone @("moveto", "$RemoteRoot/in-arbeit/$name", "$RemoteRoot/fehler/$name") | Out-Null
            continue
        }

        $auftragText = Get-Content -LiteralPath $localAuftrag -Raw -Encoding UTF8

        # Auftragsart bestimmt, welche Werkzeuge der Lauf bekommt.
        $kind = "recherche"
        if ($auftragText -match '(?m)^kind:\s*([a-z]+)\s*$') { $kind = $matches[1] }

        $claudeArgs = @("-p", "--permission-mode")
        switch ($kind) {
            "dokument" {
                # Eigener Sandkasten: Schreiben und Python nur im Arbeits-
                # verzeichnis, kein Zugriff auf Vault oder OneDrive.
                $claudeArgs += @(
                    "acceptEdits",
                    "--allowedTools", "Read", "Glob", "Grep", "WebSearch", "WebFetch",
                    "Write", "Edit", "Skill", "Bash(python:*)", "Bash(pip:*)"
                )
            }
            "vault" {
                # Leserecht auf das Vault, aber keinerlei Schreibwerkzeug.
                $claudeArgs += @(
                    "acceptEdits",
                    "--add-dir", $VaultRoot,
                    "--disallowedTools", "Write", "Edit", "NotebookEdit", "Bash"
                )
            }
            default {
                # recherche, klinisch: nur lesen und recherchieren.
                $claudeArgs += @(
                    "acceptEdits",
                    "--disallowedTools", "Write", "Edit", "NotebookEdit", "Bash"
                )
            }
        }

        $jetzt = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"
        $prompt = @"
$anweisung

---

Aktueller Zeitstempel fuer das Feld `bearbeitet`: $jetzt

Der zu bearbeitende Auftrag folgt. Er wurde aus einem Sprachdiktat erzeugt.

$auftragText
"@

        $promptFile = Join-Path $workDir "_prompt.txt"
        $outFile    = Join-Path $workDir "_stdout.txt"
        $errFile    = Join-Path $workDir "_stderr.txt"
        Write-Utf8NoBom -Path $promptFile -Content $prompt

        Write-Log "Starte Bearbeitung (kind=$kind, Zeitlimit $TimeoutMinutes Min)."
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
            # und ExitCode bleibt anschliessend leer -- ein erfolgreicher Lauf
            # saehe dann wie ein Fehlschlag aus.
            $null = $proc.Handle

            if (-not $proc.WaitForExit($TimeoutMinutes * 60 * 1000)) {
                try { $proc.Kill() } catch {}
                $fehlerText = "Zeitlimit von $TimeoutMinutes Minuten ueberschritten."
            } else {
                $exit = $null
                try { $exit = $proc.ExitCode } catch {}
                # Ein nicht ermittelbarer Exit-Code allein ist kein Fehlschlag.
                # Ob wirklich etwas herauskam, entscheidet die Antwort weiter unten.
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

        # Ergebnisdatei: gleicher Zeitstempel-Stamm wie der Auftrag, damit
        # Auftrag und Ergebnis in der Inbox nebeneinander sortieren.
        $ergebnisName = if ($stem -match "-auftrag-") {
            ($stem -replace "-auftrag-", "-ergebnis-") + ".md"
        } else {
            "$stem-ergebnis.md"
        }
        $zielPfad = Join-Path $VaultInbox $ergebnisName

        if ($ok) {
            Write-Utf8NoBom -Path $zielPfad -Content $ergebnis

            # Erzeugte Binaerartefakte (nur beim Profil `dokument`) wandern
            # nach OneDrive — Format entscheidet ueber Ablage, nicht Thema.
            $artefakte = @(Get-ChildItem -LiteralPath $workDir -File |
                Where-Object { $_.Name -notlike "_*" -and $_.Name -ne $name -and $_.Extension -ne ".md" })
            foreach ($a in $artefakte) {
                $ziel = Join-Path $OneDriveInbox $a.Name
                Move-Item -LiteralPath $a.FullName -Destination $ziel -Force
                Write-Log "Artefakt -> 00_INBOX: $($a.Name)"
            }

            Invoke-Rclone @("moveto", "$RemoteRoot/in-arbeit/$name", "$RemoteRoot/fertig/$name") | Out-Null
            Write-Log "Erledigt in ${dauer}s -> $ergebnisName"
        } else {
            # Auch der Fehlschlag landet sichtbar in der Inbox. Ein still
            # verschwundener Auftrag faellt sonst erst auf, wenn er fehlt.
            $notiz = @"
---
type: auftrag-ergebnis
kind: $kind
status: fehlgeschlagen
bearbeitet: $jetzt
---

# Auftrag fehlgeschlagen: $stem

## Was passiert ist
$fehlerText

Laufzeit bis zum Abbruch: ${dauer}s

## Der urspruengliche Auftrag

$auftragText
"@
            Write-Utf8NoBom -Path $zielPfad -Content $notiz
            Invoke-Rclone @("moveto", "$RemoteRoot/in-arbeit/$name", "$RemoteRoot/fehler/$name") | Out-Null
            Write-Log "FEHLGESCHLAGEN nach ${dauer}s: $fehlerText"
        }

        # Arbeitsverzeichnis nur bei Erfolg raeumen — im Fehlerfall bleiben
        # Prompt und stderr fuer die Fehlersuche liegen.
        if ($ok) { Remove-Item -LiteralPath $workDir -Recurse -Force }
    }

} finally {
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}
