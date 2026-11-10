// Pixel Agents lifecycle for OpenCode Desktop.
//
// `main` runs once in the Electron main process. It starts the Pixel Agents
// server (or reuses one that is already running) and registers a cleanup that
// stops it when OpenCode quits, the plugin is reloaded, or the plugin is
// disabled. The server also receives PIXEL_AGENTS_PARENT_PID, so it exits by
// itself if OpenCode is force-killed and this cleanup never runs.
const { spawn } = require("node:child_process")
const { appendFileSync, closeSync, existsSync, mkdirSync, openSync } = require("node:fs")
const { get } = require("node:http")
const { homedir } = require("node:os")
const { join } = require("node:path")
const { Plugin } = require("@opencode/plugin/gui")

const DEFAULTS = {
  repo: join(homedir(), "pixel-agents-standalone"),
  port: 3456,
  openBrowser: true,
  discovery: "recent",
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeLogger(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* logging must never break OpenCode */
  }
  const file = join(dir, "plugin.log")
  return (message) => {
    try {
      appendFileSync(file, `${new Date().toISOString()}  ${message}\r\n`, "utf8")
    } catch {
      /* ignore */
    }
  }
}

function resolveRepo(options) {
  if (options.repo) return String(options.repo)
  const candidates = [
    join(__dirname, "..", ".."), // npm package: integrations/opencode-plugin/
    join(__dirname, ".."), // plugin directory containing dist/
    __dirname, // package root containing dist/
    join(homedir(), "pixel-agents-standalone"),
  ]
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, "dist", "server.js"))) return candidate
    } catch {
      /* ignore */
    }
  }
  return join(homedir(), "pixel-agents-standalone")
}

function resolveLaunch(options) {
  const candidates = [
    options.nodePath,
    process.env.PIXEL_AGENTS_NODE,
    process.env.NODE_EXE,
    join(process.env.ProgramFiles || "", "nodejs", "node.exe"),
    join(process.env["ProgramFiles(x86)"] || "", "nodejs", "node.exe"),
    join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
    join(process.env.LOCALAPPDATA || "", "Author Software", "nvm", ".nodejs", "node.exe"),
  ]
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue
    try {
      if (existsSync(candidate)) return { command: candidate, env: {} }
    } catch {
      /* ignore */
    }
  }
  // OpenCode Desktop ships Electron. Running its executable with
  // ELECTRON_RUN_AS_NODE gives us a Node runtime even when Node.js is not
  // installed on the machine.
  if (process.versions.electron && process.execPath) {
    return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } }
  }
  return { command: process.platform === "win32" ? "node.exe" : "node", env: {} }
}

function checkHealth(url) {
  return new Promise((resolve) => {
    const request = get(`${url}/api/status`, { timeout: 1_500 }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => {
        body += chunk
      })
      response.on("end", () => {
        if (response.statusCode !== 200) return resolve(false)
        try {
          resolve(JSON.parse(body).ok === true)
        } catch {
          resolve(false)
        }
      })
    })
    request.on("timeout", () => {
      request.destroy()
      resolve(false)
    })
    request.on("error", () => resolve(false))
  })
}

function openInBrowser(url, log) {
  try {
    const { shell } = require("electron")
    void shell.openExternal(url)
    log(`opened browser at ${url}`)
    return
  } catch (error) {
    log(`electron shell failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { windowsHide: true, stdio: "ignore" })
    } else if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore" })
    } else {
      spawn("xdg-open", [url], { stdio: "ignore" })
    }
  } catch (error) {
    log(`browser launcher failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// Reload-safe: the host runs the registered cleanup before rerunning main.
// (Saving this file hot-reloads the plugin and exercises that path.)
module.exports = Plugin.define({
  async main(ctx) {
    const options = { ...DEFAULTS, ...(ctx.options || {}) }
    const repo = resolveRepo(options)
    // The server uses its cwd for + Agent and workspace metadata. For an npm
    // install the package lives in node_modules, so default to the user's home
    // instead of creating sessions inside the package directory.
    const projectDir = String(options.projectDir || (options.repo ? repo : homedir()))
    const port = Number(options.port) || DEFAULTS.port
    const url = `http://127.0.0.1:${port}`
    const logDir = join(process.env.LOCALAPPDATA || process.env.TEMP || repo, "PixelAgents")
    const log = makeLogger(logDir)

    log(`main started plugin=${ctx.id} electronPid=${process.pid} repo=${repo} port=${port} project=${projectDir}`)

    let child = null
    let stopping = false

    const stop = async () => {
      if (stopping) return
      stopping = true
      if (!child) {
        log("cleanup: no server started by this plugin instance")
        return
      }
      const pid = child.pid
      log(`cleanup: stopping Pixel Agents pid=${pid}`)
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          })
        } else {
          child.kill("SIGTERM")
        }
      } catch (error) {
        log(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      child = null

      // Wait for the port to close so a hot reload does not mistake the dying
      // server for one that is still running and skip spawning a replacement.
      const deadline = Date.now() + 2_500
      while (Date.now() < deadline) {
        if (!(await checkHealth(url))) {
          log("cleanup: server stopped")
          return
        }
        await sleep(100)
      }
      log("cleanup: server still answering after 2.5s")
    }

    ctx.onCleanup(stop)

    if (await checkHealth(url)) {
      // A reload kills the old server just before rerunning main. Give the
      // health check a moment to settle before claiming an existing server.
      await sleep(1_000)
      if (await checkHealth(url)) {
        log("Pixel Agents is already running; reusing it without taking ownership")
        if (options.openBrowser !== false) openInBrowser(url, log)
        return
      }
      log("existing Pixel Agents went away during startup; starting a new one")
    }

    // Never race a server that is still shutting down for the same port.
    const freeDeadline = Date.now() + 5_000
    while (await checkHealth(url)) {
      if (Date.now() >= freeDeadline) {
        log("port is still in use by another Pixel Agents server; not starting")
        return
      }
      await sleep(200)
    }

    const serverEntry = join(repo, "dist", "server.js")
    if (!existsSync(serverEntry)) {
      log(`missing build: ${serverEntry} (run npm run build)`)
      return
    }

    const launch = resolveLaunch(options)
    const serverLog = join(logDir, "server.log")
    let out = null
    try {
      out = openSync(serverLog, "a")
      child = spawn(launch.command, [serverEntry], {
        cwd: projectDir,
        env: {
          ...process.env,
          ...launch.env,
          PORT: String(port),
          PIXEL_AGENTS_PROJECT_DIR: projectDir,
          PIXEL_AGENTS_SOURCE: "opencode",
          PIXEL_AGENTS_OPENCODE_AUTOSTART: "0",
          PIXEL_AGENTS_ATTACH: "0",
          PIXEL_AGENTS_DISCOVERY: String(options.discovery || DEFAULTS.discovery),
          PIXEL_AGENTS_PARENT_PID: String(process.pid),
        },
        stdio: ["ignore", out, out],
        windowsHide: true,
      })
    } catch (error) {
      log(`spawn failed: ${error instanceof Error ? error.message : String(error)}`)
      if (out !== null) {
        try {
          closeSync(out)
        } catch {
          /* ignore */
        }
      }
      return
    }
    if (out !== null) {
      try {
        closeSync(out)
      } catch {
        /* ignore */
      }
    }

    const spawned = child
    log(
      `spawned Pixel Agents pid=${spawned.pid} command=${launch.command}${launch.env.ELECTRON_RUN_AS_NODE ? " (electron-as-node)" : ""}`,
    )
    spawned.on("error", (error) => {
      log(`server process error: ${error instanceof Error ? error.message : String(error)}`)
    })
    spawned.on("exit", (code, signal) => {
      log(`server exited code=${code} signal=${signal}`)
      if (child === spawned) child = null
    })

    const deadline = Date.now() + 30_000
    let ready = false
    while (Date.now() < deadline && !stopping) {
      if (spawned.exitCode !== null) break
      if (await checkHealth(url)) {
        ready = true
        break
      }
      await sleep(500)
    }

    if (ready) {
      log(`Pixel Agents ready at ${url}`)
      if (options.openBrowser !== false) openInBrowser(url, log)
    } else {
      log("Pixel Agents did not become ready within 30s; see server.log")
    }
  },
})
