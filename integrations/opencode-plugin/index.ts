import { Plugin } from "@opencode/plugin"

// The GUI part (gui-experimental.cjs) owns the Pixel Agents lifecycle. It runs
// in the OpenCode Desktop main process, starts the web server together with
// the app, and stops it when the app quits. This server part only gives the
// plugin an id and makes it visible to the desktop as an active plugin.
export default Plugin.define({
  id: "pixel-agents",
  setup() {},
})
