@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install || goto :error
)

if not exist "dist\server.js" (
  echo Building...
  call npm run build || goto :error
)

echo.
echo Starting Pixel Agents at http://localhost:3456
echo OpenCode is detected automatically (Desktop v2 or CLI v1/v2).
echo Press Ctrl+C to stop.
echo.

rem Open the browser once the server answers, without blocking the server.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "$url='http://127.0.0.1:3456/api/status'; for($i=0;$i -lt 60;$i++){ try { $null = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 1; Start-Process 'http://localhost:3456'; break } catch { Start-Sleep -Milliseconds 500 } }"

node dist\server.js
goto :eof

:error
echo.
echo Failed to start Pixel Agents. See the messages above.
pause
exit /b 1
