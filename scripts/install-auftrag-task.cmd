@echo off
REM Registriert den Auftrags-Task im Windows Task Scheduler.
REM Laeuft alle 5 Minuten im Hintergrund als aktueller Benutzer.
REM
REM Anders als beim Inbox-Sync laeuft dieser Task auch im Akkubetrieb
REM weiter, sobald er einmal gestartet ist: eine Bearbeitung, die mitten
REM im Lauf abgebrochen wird, hinterlaesst einen Auftrag im Zustand
REM "in Arbeit", der erst beim naechsten Durchlauf wieder freigegeben wird.
REM
REM /ST setzt den Start bewusst 2 Min versetzt zum Inbox-Sync-Task:
REM starten beide auf die Sekunde gleichzeitig, greifen zwei rclone-
REM Prozesse gleichzeitig auf denselben Drive-OAuth-Token zu, und der
REM Auftraege-Lauf (mkdir + zwei lsf-Calls) verliert dabei zuverlaessig
REM gegen den einfacheren Inbox-Sync-Lauf (ein move-Call). Ergebnis war
REM zwei Wochen lang ein bei praktisch jedem Durchlauf fehlschlagender
REM Task (2026-08-10 bis 2026-08-24), bis rclone manuell als fehlerfrei
REM verifiziert und die Ueberschneidung als Ursache erkannt wurde.

schtasks /Create ^
  /TN "Enkephalos Auftraege" ^
  /TR "wscript.exe //B \"%~dp0..\..\run-hidden.vbs\" \"%~dp0process-auftraege.ps1\"" ^
  /SC MINUTE ^
  /MO 5 ^
  /ST 00:02 ^
  /RL LIMITED ^
  /F

if errorlevel 1 (
  echo FEHLER: Task konnte nicht registriert werden.
  exit /b 1
)

REM Standardmaessig stoppt der Scheduler Tasks nach 3 Tagen und beendet sie
REM beim Wechsel auf Akku. Ersteres ist hier unnoetig, Letzteres wuerde eine
REM laufende Bearbeitung mittendrin abschiessen.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$t = Get-ScheduledTask -TaskName 'Enkephalos Auftraege'; $t.Settings.ExecutionTimeLimit = 'PT1H'; $t.Settings.StopIfGoingOnBatteries = $false; $t.Settings.DisallowStartIfOnBatteries = $false; Set-ScheduledTask -InputObject $t | Out-Null"

echo Task "Enkephalos Auftraege" registriert, laeuft alle 5 Minuten.
