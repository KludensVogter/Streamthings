@echo off
title Twitch Plays
cd /d "%~dp0"

rem ---- find en Python vi kan bruge ------------------------------
set "PYEXE=py"
call :proev
if defined FUNDET goto koer

set "PYEXE=python"
call :proev
if defined FUNDET goto koer

set "PYEXE=python3"
call :proev
if defined FUNDET goto koer

rem ---- installeret, men ikke lagt paa PATH ----------------------
for /d %%D in ("%LOCALAPPDATA%\Python\pythoncore-3*") do if exist "%%D\python.exe" set "PYEXE=%%D\python.exe"
call :proev
if defined FUNDET goto koer

for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%D\python.exe" set "PYEXE=%%D\python.exe"
call :proev
if defined FUNDET goto koer

for /d %%D in ("%PROGRAMFILES%\Python3*") do if exist "%%D\python.exe" set "PYEXE=%%D\python.exe"
call :proev
if defined FUNDET goto koer

goto mangler

rem ---- afproev at kommandoen rent faktisk starter Python --------
:proev
set "FUNDET="
"%PYEXE%" -c "import sys" >nul 2>nul
if not errorlevel 1 set "FUNDET=1"
exit /b

:koer
"%PYEXE%" kontrolpanel.py
if errorlevel 1 pause
exit /b

:mangler
cls
echo.
echo   =============================================================
echo      Python mangler paa denne computer
echo   =============================================================
echo.
echo   Twitch Plays har brug for Python for at koere.
echo   Det er gratis, og det tager et par minutter.
echo.
echo   1.  Hjemmesiden python.org aabner nu i din browser
echo.
echo   2.  Klik paa den store gule knap  "Download Python"
echo.
echo   3.  Aabn filen der bliver hentet ned
echo.
echo   4.  VIGTIGT:  saet flueben i feltet
echo          "Add python.exe to PATH"
echo       nederst i installationsvinduet - FOER du klikker videre.
echo       Uden det flueben kan programmet ikke finde Python.
echo.
echo   5.  Klik  "Install Now"  og vent til den er faerdig
echo.
echo   6.  Start denne fil (START.bat) igen
echo.
echo   =============================================================
echo.
start "" "https://www.python.org/downloads/"
pause
exit /b
