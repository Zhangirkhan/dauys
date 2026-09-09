import type {
  Action,
  AllowedAction,
  ExecutionResult,
  LocalApp,
  Registry,
  Trust,
} from "../../../packages/shared/src/index.js";
import { actions } from "../../../packages/shared/src/index.js";
import { MacExecutor, type ExecutorOptions } from "./executor.js";
import { WinExecutor } from "./windows/executor.js";
import { WINDOWS_SUPPORTED_ACTIONS } from "./windows/actions.js";

export { WINDOWS_SUPPORTED_ACTIONS };

export type AgentExecutor = {
  execute: (
    command: Action,
    registry: Registry,
    confirmed?: boolean,
    expiresAt?: number,
  ) => Promise<ExecutionResult>;
  warmProjects?: () => Promise<void> | void;
  supportedActions: () => AllowedAction[];
  setLocalApps?: (apps: LocalApp[]) => void;
};

export function createExecutor(
  o: ExecutorOptions & { localApps?: LocalApp[] },
): AgentExecutor {
  if (process.platform === "win32") return new WinExecutor(o);
  return new MacExecutor(o);
}

export function platformId(): "darwin" | "win32" | "linux" {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

export function supportedActionsForPlatform(
  platform = platformId(),
  trust?: Trust,
): AllowedAction[] {
  if (platform === "win32") {
    const list = [...WINDOWS_SUPPORTED_ACTIONS];
    if (trust && !Object.keys(trust.processes).length) {
      return list.filter((a) => a !== "run_shortcut");
    }
    return list;
  }
  return [...actions] as AllowedAction[];
}
