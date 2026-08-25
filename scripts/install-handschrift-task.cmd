@echo off
REM Registriert den Handschrift-Task im Windows Task Scheduler.
REM Laeuft alle 5 Minuten im Hintergrund als aktueller Benutzer.
REM
REM /ST setzt den Start auf Minute :00 des Fuenf-Minuten-Rasters. Die
REM beiden bestehenden Tasks liegen auf :02 (Inbox Sync) und :04
REM (Auftraege). Grund fuer die Staffelung: greifen zwei rclone-Prozesse
REM gleichzeitig auf denselben Drive-OAuth-Token zu, scheitert zuverlaessig
REM der aufwendigere Lauf (siehe install-auftrag-task.cmd, Vorfall
REM 2026-08-10 bis 2026-08-24).
REM
REM Mit dieser Phasenlage faellt der rclone-Anteil jedes Tasks in die
REM Claude- bzw. Ruhephase der jeweils anderen:
REM   :00  Handschrift  -> lsjson, danach Claude (Minuten)
REM   :02  Inbox Sync   -> ein move-Call, Sekunden
REM   :04  Auftraege    -> mkdir + lsf, danach Claude (Minuten)
REM
REM Akku: bewusst NICHT gegated, gleiche Begruendung wie beim
REM Auftraege-Task. Ein Lauf, der mitten in der Transkription abgeschossen
REM wird, verbrennt Claude-Laufzeit und hinterlaesst eine Sperrdatei, die
REM erst nach 30 Minuten als verwaist gilt.

schtasks /Create ^
  /TN "Enkephalos Handschrift" ^
  /TR "wscript.exe //B \"%~dp0..\..\run-hidden.vbs\" \"%~dp0process-handschrift.ps1\"" ^
  /SC MINUTE ^
  /MO 5 ^
  /ST 00:00 ^
  /RL LIMITED ^
  /F

if errorlevel 1 (
  echo FEHLER: Task konnte nicht registriert werden.
  exit /b 1
)

REM Standardmaessig stoppt der Scheduler Tasks nach 3 Tagen und beendet sie
REM beim Wechsel auf Akku. Ersteres ist hier unnoetig, Letzteres wuerde eine
REM laufende Transkription mittendrin abschiessen.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$t = Get-ScheduledTask -TaskName 'Enkephalos Handschrift'; $t.Settings.ExecutionTimeLimit = 'PT1H'; $t.Settings.StopIfGoingOnBatteries = $false; $t.Settings.DisallowStartIfOnBatteries = $false; Set-ScheduledTask -InputObject $t | Out-Null"

echo Task "Enkephalos Handschrift" registriert, laeuft alle 5 Minuten.
