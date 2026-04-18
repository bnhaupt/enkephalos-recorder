@echo off
REM Registriert den Sync-Task im Windows Task Scheduler.
REM Laeuft alle 5 Minuten im Hintergrund als aktueller Benutzer.

schtasks /Create ^
  /TN "Enkephalos Inbox Sync" ^
  /TR "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%~dp0sync-inbox.ps1\"" ^
  /SC MINUTE ^
  /MO 5 ^
  /RL LIMITED ^
  /F

if errorlevel 1 (
  echo FEHLER: Task konnte nicht registriert werden.
  exit /b 1
)
echo Task "Enkephalos Inbox Sync" registriert, laeuft alle 5 Minuten.
