@echo off
rem Double-click to pull your latest MetaTrader 5 gold trades into GoldTerm, then refresh GoldTerm (F5).
cd /d "%~dp0"
node tools\mt5-sync.mjs
echo.
echo Done. Refresh GoldTerm (F5) to see the trades in Journal and Analytics.
pause
