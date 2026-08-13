@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
if not exist config.json (
  echo Copy config.example.json to config.json and edit playerHistoryPath before production use.
  if not exist config.json copy config.example.json config.json
)
call npm run dev
