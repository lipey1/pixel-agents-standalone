import * as path from "path";

export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;
export const PERMISSION_TIMER_DELAY_MS = 7000;
export const TOOL_DONE_DELAY_MS = 300;

export const PERMISSION_EXEMPT_TOOLS = new Set(["Task", "AskUserQuestion", "askuserquestion", "task"]);

const TOOL_ALIASES: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  bash: "Bash",
  shell: "Bash",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  task: "Task",
  askuserquestion: "AskUserQuestion",
  enterplanmode: "EnterPlanMode",
  notebookedit: "NotebookEdit",
  patch: "Edit",
  list: "Glob",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
};

/** OpenCode reports lower-case tool IDs. Normalize them for the pixel-agents UI. */
export function normalizeToolName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed) return "Tool";
  const alias = TOOL_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  if (/^[a-z0-9_-]+$/i.test(trimmed) && trimmed === trimmed.toLowerCase()) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }
  return trimmed;
}

export function isPermissionExempt(toolName: string): boolean {
  return PERMISSION_EXEMPT_TOOLS.has(toolName) || PERMISSION_EXEMPT_TOOLS.has(toolName.toLowerCase());
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\u2026` : value;
}

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  const normalized = normalizeToolName(toolName);
  const base = (p: unknown) => (typeof p === "string" ? path.basename(p) : "");
  switch (normalized) {
    case "Read":
      return `Reading ${base(input.file_path)}`;
    case "Edit":
      return `Editing ${base(input.file_path)}`;
    case "Write":
      return `Writing ${base(input.file_path)}`;
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command : "";
      return `Running: ${truncate(cmd, BASH_COMMAND_DISPLAY_MAX_LENGTH)}`;
    }
    case "Glob":
      return "Searching files";
    case "Grep":
      return "Searching code";
    case "WebFetch":
      return "Fetching web content";
    case "WebSearch":
      return "Searching the web";
    case "Task": {
      const desc = typeof input.description === "string" ? input.description : "";
      return desc ? `Subtask: ${truncate(desc, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}` : "Running subtask";
    }
    case "AskUserQuestion":
      return "Waiting for your answer";
    case "EnterPlanMode":
      return "Planning";
    case "NotebookEdit":
      return "Editing notebook";
    case "TodoWrite":
      return "Updating task list";
    case "TodoRead":
      return "Reading task list";
    default:
      return `Using ${normalized}`;
  }
}
