# OpenCode Desktop lifecycle plugin

This is an OpenCode Desktop **GUI plugin** that starts Pixel Agents together with
OpenCode and stops it when OpenCode quits, reloads, or disables the plugin.

- `index.ts` — server part. It only gives the plugin its `pixel-agents` id.
- `gui-experimental.cjs` — GUI part. Its `main` runs once in the OpenCode Desktop
  (Electron) main process. It spawns `dist/server.js`, waits for `/api/status`,
  opens the browser, and registers a cleanup that kills the whole process tree.

The server also receives `PIXEL_AGENTS_PARENT_PID` with the Electron PID. If
OpenCode is force-killed and cleanup never runs, the server notices the parent is
gone within ~5 seconds and exits by itself.

## Install

1. Build Pixel Agents once:

   ```powershell
   npm run build
   ```

2. Copy the plugin into your OpenCode config (or run the helper):

   ```powershell
   powershell -ExecutionPolicy Bypass -File integrations\opencode-plugin\install.ps1
   ```

   The helper copies `index.ts` and `gui-experimental.cjs` to
   `%USERPROFILE%\.config\opencode\plugins\pixel-agents`.

3. Add the plugin to `~/.config/opencode/opencode.jsonc`. Keep any plugins you
   already have and add this entry to the array:

   ```jsonc
   {
     "plugins": [
       {
         "package": "./plugins/pixel-agents",
         "options": {
           "repo": "C:\\Users\\YOU\\pixel-agents-standalone",
           "port": 3456,
           "openBrowser": true,
           "nodePath": "C:\\Program Files\\nodejs\\node.exe"
         }
       }
     ]
   }
   ```

   `repo` is the only required option. `nodePath` is optional when `node` is in
   `PATH`; the plugin also knows the common Windows install and nvm locations.

4. Restart OpenCode Desktop. Pixel Agents should start on its own and open
   `http://localhost:3456`.

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `repo` | `~/pixel-agents-standalone` | Pixel Agents checkout containing `dist/server.js` |
| `port` | `3456` | Port for the Pixel Agents web server |
| `openBrowser` | `true` | Open the app in the default browser when ready |
| `discovery` | `recent` | Passed to `PIXEL_AGENTS_DISCOVERY` (`recent`, `all`, `off`) |
| `nodePath` | auto | Node.js executable used to run `dist/server.js` |

## Logs

- Plugin lifecycle: `%LOCALAPPDATA%\PixelAgents\plugin.log`
- Server output: `%LOCALAPPDATA%\PixelAgents\server.log`

On macOS/Linux the directory falls back to `$TMPDIR/PixelAgents`.

## Notes

- If a Pixel Agents server is already running when OpenCode starts, the plugin
  reuses it and does not take ownership of it.
- Saving `gui-experimental.cjs` hot-reloads the plugin: the old server is stopped
  and a new one is spawned.
- The browser tab is not closed when OpenCode quits; only the server stops.
