export type AgentLogger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

function write(level: string, obj: unknown, msg?: string) {
  const rec: Record<string, unknown> = { level, time: Date.now() };
  if (typeof obj === "string" && msg === undefined) rec.msg = obj;
  else {
    if (obj && typeof obj === "object") Object.assign(rec, obj);
    else rec.value = obj;
    if (msg) rec.msg = msg;
  }
  const line = JSON.stringify(rec);
  if (level === "error") console.error(line);
  else console.log(line);
}

export const logger: AgentLogger = {
  info: (obj, msg) => write("info", obj, msg),
  warn: (obj, msg) => write("warn", obj, msg),
  error: (obj, msg) => write("error", obj, msg),
};
