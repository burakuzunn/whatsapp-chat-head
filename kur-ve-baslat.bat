@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
    echo [WhatsApp Bubble] Ilk kurulum yapiliyor, lutfen bekleyin...
    call npm install
)

start "" wscript.exe "%~dp0baslat.vbs"
exit
