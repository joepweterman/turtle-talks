@echo off
rem Launch MeetingNotes minimized (for shell:startup)
cd /d "%~dp0"
start "" /min cmd /c "npx electron ."
