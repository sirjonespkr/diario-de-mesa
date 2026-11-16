@echo off
rem Faz o atalho do Diario de Mesa abrir sozinho quando o Windows liga.
set "ALVO=%~dp0Iniciar atalho.vbs"
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Diario de Mesa - atalho.lnk"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK); $s.TargetPath=$env:ALVO; $s.WorkingDirectory=(Split-Path $env:ALVO); $s.Save()"
if exist "%LINK%" (echo Pronto: o atalho vai abrir sozinho quando o Windows ligar.) else (echo Nao deu para criar o atalho de inicializacao.)
pause
