@echo off
rem Windows：停掉 larksnap daemon（真正的逻辑在 kill-daemon.mjs 里，三平台共用）
node "%~dp0kill-daemon.mjs" %*
