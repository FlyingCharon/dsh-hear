@echo off
chcp 65001 >nul
setlocal
rem dsh-hear rollback launcher. Keep comments ASCII only (cmd reads GBK).
set NODE=C:\Users\17951\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
if not exist "%NODE%" set NODE=node
"%NODE%" "%~dp0rollback.mjs" %*
echo.
pause
