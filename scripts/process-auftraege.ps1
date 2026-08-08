# process-auftraege.ps1
#
# Holt diktierte Arbeitsauftraege aus Google Drive `Enkephalos-Auftraege/`,
# laesst sie von Claude Code headless bearbeiten und legt das Ergebnis in die
# Vault-Inbox.
#
# Statusrueckkanal an die PWA — ueber den Dateinamen:
#
#   <stamm>.md            offen, noch nicht angefasst
#   <stamm>--arbeit.md    wird gerade bearbeitet
#   <stamm>--fertig.md    erledigt
#   <stamm>--fehler.md    fehlgeschlagen
#
# Warum ueber den Namen und nicht ueber Unterordner: Die PWA hat den Drive-
# Scope `drive.file` und sieht damit ausschliesslich Dateien, die sie selbst
# angelegt hat. Ordner, die dieses Skript anlegt, kann sie nicht einmal
# aufloesen. Ihre eigene Auftragsdatei darf sie dagegen jederzeit abfragen —
# und rclone benennt serverseitig um, die Datei-ID bleibt also erhalten.
# Die PWA liest schlicht den aktuellen Namen und leitet daraus den Status ab.
#
# Das Umbenennen auf `--arbeit` ist zugleich die Beanspruchung: ein parallel
# startender Lauf sieht die Datei dann nicht mehr als offen.
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
# Eigenes Leitlinien-Archiv: erspart bei Leitlinienfragen den Umweg ueber
# die Websuche und liefert die Fassung, die hier tatsaechlich gilt.
# Lesend — Schreibwerkzeuge sind in diesen Profilen abgeschaltet.
$LeitlinienArchiv = "$env:USERPROFILE\OneDrive\03_RESOURCES\Leitlinien-Archiv"
$WorkRoot       = "$env:LOCALAPPDATA\voice-pipeline\auftraege"
$LogFile        = "$env:USERPROFILE\OneDrive\05_DEV\voice-pipeline\logs\auftraege.log"
$AnweisungFile  = Join-Path $PSScriptRoot "auftrag-anweisung.md"

# Zeitlimit pro Auftrag. Ein entgleister Lauf darf die Warteschlange nicht
# blockieren; eine grosse Recherche braucht aber durchaus zehn Minuten.
$TimeoutMinutes = 20

# Wie lange eine Sperrdatei gilt, bevor sie als verwaist betrachtet wird.
$LockStaleMinutes = 45

# Erledigte Auftragsdateien bleiben in Drive liegen, damit die PWA den
# Status weiterhin ablesen kann. Nach dieser Frist werden sie aufgeraeumt.
$KeepFertigDays = 14

# Was aus dem Arbeitsverzeichnis nach OneDrive wandert. Positivliste, nicht
# Ausschlussliste: Der Lauf legt sich zum Bauen einer .pptx Hilfsskripte an,
# und die haben in 00_INBOX nichts verloren.
$ArtefaktEndungen = @(".pptx", ".docx", ".xlsx", ".pdf", ".png", ".jpg", ".svg")

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

# Statusmarkierung durch Umbenennen. Gibt den neuen Namen zurueck, oder $null.
function Set-AuftragStatus {
    param([string]$CurrentName, [string]$NewName)
    $r = Invoke-Rclone @("moveto", "$RemoteRoot/$CurrentName", "$RemoteRoot/$NewName")
    if ($r.Code -ne 0) {
        Write-Log "Umbenennen '$CurrentName' -> '$NewName' fehlgeschlagen (exit $($r.Code))."
        return $null
    }
    return $NewName
}

function Get-RemoteNames {
    param([string]$Include)
    $r = Invoke-Rclone @("lsf", $RemoteRoot, "--files-only", "--include", $Include)
    if ($r.Code -ne 0) { return $null }
    return @($r.Output | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -like "*.md" })
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

    # ---------- Ordner sicherstellen ----------

    $r = Invoke-Rclone @("mkdir", $RemoteRoot)
    if ($r.Code -ne 0) {
        Write-Log "Drive-Ordner '$RemoteRoot' nicht erreichbar (exit $($r.Code)) -- Abbruch."
        exit 1
    }

    # ---------- Verwaiste Beanspruchungen zuruecknehmen ----------

    # Wir halten ab hier die Sperre. Alles, was jetzt noch als `--arbeit`
    # markiert ist, stammt folglich aus einem abgestuerzten Lauf und muss
    # zurueck in die Warteschlange, statt fuer immer haengenzubleiben.
    $stale = Get-RemoteNames "*--arbeit.md"
    if ($null -ne $stale) {
        foreach ($s in $stale) {
            $back = $s -replace "--arbeit\.md$", ".md"
            Write-Log "Verwaiste Beanspruchung zurueckgesetzt: $s"
            Set-AuftragStatus -CurrentName $s -NewName $back | Out-Null
        }
    }

    # ---------- Aufgeraeumt ----------

    Invoke-Rclone @(
        "delete", $RemoteRoot, "--include", "*--fertig.md",
        "--min-age", "${KeepFertigDays}d"
    ) | Out-Null

    # ---------- Offene Auftraege ----------

    $alle = Get-RemoteNames "*.md"
    if ($null -eq $alle) {
        Write-Log "Drive-Liste fehlgeschlagen -- Abbruch."
        exit 1
    }
    $pending = @($alle | Where-Object { $_ -notmatch "--(arbeit|fertig|fehler)\.md$" })

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

        # Zuerst beanspruchen, dann herunterladen.
        $claimed = Set-AuftragStatus -CurrentName $name -NewName "$stem--arbeit.md"
        if (-not $claimed) { continue }

        $localAuftrag = Join-Path $workDir $name
        $r = Invoke-Rclone @("copyto", "$RemoteRoot/$claimed", $localAuftrag)
        if ($r.Code -ne 0 -or -not (Test-Path -LiteralPath $localAuftrag)) {
            Write-Log "Download fehlgeschlagen (exit $($r.Code))."
            Set-AuftragStatus -CurrentName $claimed -NewName "$stem--fehler.md" | Out-Null
            continue
        }

        $auftragText = Get-Content -LiteralPath $localAuftrag -Raw -Encoding UTF8

        # Auftragsart bestimmt, welche Werkzeuge der Lauf bekommt.
        $kind = "recherche"
        if ($auftragText -match '(?m)^kind:\s*([a-z]+)\s*$') { $kind = $matches[1] }

        # Jedes Profil listet ausdruecklich auf, was erlaubt ist. Sich auf
        # `--permission-mode acceptEdits` allein zu verlassen, waere ein
        # Fehler: der Modus genehmigt nur Datei-Aenderungen automatisch,
        # WebSearch und WebFetch verlangen weiterhin eine Freigabe -- und im
        # unbeaufsichtigten Lauf kann die niemand erteilen. Ohne den
        # Allowlist-Eintrag antwortet der Lauf stillschweigend offline.
        $leseWerkzeuge = @("Read", "Glob", "Grep", "WebSearch", "WebFetch", "Skill", "TodoWrite")
        $schreibVerbot = @("Write", "Edit", "NotebookEdit", "Bash")

        $claudeArgs = @("-p", "--permission-mode")
        switch ($kind) {
            "dokument" {
                # Eigener Sandkasten: Schreiben und Python nur im Arbeits-
                # verzeichnis, kein Zugriff auf Vault oder OneDrive.
                $claudeArgs += @("acceptEdits", "--allowedTools")
                $claudeArgs += $leseWerkzeuge
                $claudeArgs += @("Write", "Edit", "Bash(python:*)", "Bash(pip:*)")
            }
            "vault" {
                # Leserecht auf Vault und Leitlinien-Archiv, kein Schreibwerkzeug.
                $claudeArgs += @("acceptEdits", "--add-dir", $VaultRoot)
                if (Test-Path -LiteralPath $LeitlinienArchiv) {
                    $claudeArgs += @("--add-dir", $LeitlinienArchiv)
                }
                $claudeArgs += @("--allowedTools")
                $claudeArgs += $leseWerkzeuge
                $claudeArgs += @("--disallowedTools")
                $claudeArgs += $schreibVerbot
            }
            default {
                # recherche, klinisch: recherchieren und das eigene
                # Leitlinien-Archiv lesen, sonst nichts.
                $claudeArgs += @("acceptEdits")
                if (Test-Path -LiteralPath $LeitlinienArchiv) {
                    $claudeArgs += @("--add-dir", $LeitlinienArchiv)
                }
                $claudeArgs += @("--allowedTools")
                $claudeArgs += $leseWerkzeuge
                $claudeArgs += @("--disallowedTools")
                $claudeArgs += $schreibVerbot
            }
        }

        $jetzt = Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz"
        $prompt = @"
$anweisung

---

Aktueller Zeitstempel fuer das Feld ``bearbeitet``: $jetzt

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
            $alleDateien = @(Get-ChildItem -LiteralPath $workDir -File |
                Where-Object { $_.Name -notlike "_*" -and $_.Name -ne $name })
            $artefakte = @($alleDateien |
                Where-Object { $ArtefaktEndungen -contains $_.Extension.ToLower() })
            foreach ($a in $artefakte) {
                $ziel = Join-Path $OneDriveInbox $a.Name
                Move-Item -LiteralPath $a.FullName -Destination $ziel -Force
                Write-Log "Artefakt -> 00_INBOX: $($a.Name)"
            }
            # Was liegen bleibt, wird mit dem Arbeitsverzeichnis verworfen.
            # Nicht stillschweigend: sonst faellt nie auf, wenn ein Lauf sein
            # Ergebnis in einem Format ablegt, das die Liste nicht kennt.
            $verworfen = @($alleDateien | Where-Object { $artefakte -notcontains $_ })
            if ($verworfen.Count -gt 0) {
                Write-Log "Nicht uebernommen (kein Artefakt-Format): $(($verworfen | ForEach-Object { $_.Name }) -join ', ')"
            }

            Set-AuftragStatus -CurrentName $claimed -NewName "$stem--fertig.md" | Out-Null
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
            Set-AuftragStatus -CurrentName $claimed -NewName "$stem--fehler.md" | Out-Null
            Write-Log "FEHLGESCHLAGEN nach ${dauer}s: $fehlerText"
        }

        # Arbeitsverzeichnis nur bei Erfolg raeumen — im Fehlerfall bleiben
        # Prompt und stderr fuer die Fehlersuche liegen.
        if ($ok) { Remove-Item -LiteralPath $workDir -Recurse -Force }
    }

} finally {
    Remove-Item -LiteralPath $LockFile -Force -ErrorAction SilentlyContinue
}
