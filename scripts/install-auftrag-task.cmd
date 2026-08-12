@echo off
REM Registriert den Auftrags-Task im Windows Task Scheduler.
REM Laeuft alle 5 Minuten im Hintergrund als aktueller Benutzer.
REM
REM Anders als beim Inbox-Sync laeuft dieser Task auch im Akkubetrieb
REM weiter, sobald er einmal gestartet ist: eine Bearbeitung, die mitten
REM im Lauf abgebrochen wird, hinterlaesst einen Auftrag im Zustand
REM "in Arbeit", der erst beim naechsten Durchlauf wieder freigegeben wird.

schtasks /Create ^
  /TN "Enkephalos Auftraege" ^
  /TR "wscript.exe //B \"%~dp0..\..\run-hidden.vbs\" \"%~dp0process-auftraege.ps1\"" ^
  /SC MINUTE ^
  /MO 5 ^
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
