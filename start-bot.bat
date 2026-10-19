@echo off
title Modern Gas x AI Bot Server
cd /d "%~dp0"
echo Starting bot server...
echo Open: http://localhost:3456
echo Keep this window open.
node server.js
pause