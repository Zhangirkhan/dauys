import type { AllowedAction } from "../../../../packages/shared/src/index.js";

export const WINDOWS_SUPPORTED_ACTIONS = [
  "open_application",
  "close_application",
  "open_project",
  "open_file",
  "open_folder",
  "search_files",
  "open_named_item",
  "open_editor_project",
  "open_url",
  "new_browser_tab",
  "run_shortcut",
  "set_volume",
  "media_play_pause",
  "take_screenshot",
  "get_battery_status",
  "get_active_application",
  "lock_screen",
  "run_scenario",
] as const satisfies readonly AllowedAction[];
