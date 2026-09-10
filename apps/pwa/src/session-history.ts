export type SessionEntry = {
  id: string;
  text: string;
  failed: boolean;
  createdAt: number;
};

export function rememberSessionCommand(
  list: SessionEntry[],
  command: {
    id: string;
    text: string;
    status: string;
    createdAt: number;
  },
  limit = 5,
): SessionEntry[] {
  const text = command.text.replace(/\s+/g, " ").trim();
  if (!text || command.status === "cancelled") return list;
  const entry: SessionEntry = {
    id: command.id,
    text,
    failed: command.status === "error",
    createdAt: command.createdAt,
  };
  return [entry, ...list.filter((item) => item.id !== command.id)]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function commandProgress(command: {
  status: string;
  result?: { message?: string };
  question?: string;
  decision?: { spokenResponse?: string };
}) {
  if (command.status === "done")
    return command.result?.message?.trim() || "Готово";
  if (command.status === "error")
    return command.result?.message?.trim() || "Не получилось";
  if (command.status === "clarification")
    return command.question?.trim() || "Нужно уточнение";
  if (command.status === "cancelled") return "Отменено";
  return (
    command.decision?.spokenResponse?.trim() ||
    (command.status === "executing"
      ? "Выполняю на Mac…"
      : command.status === "transcribing"
        ? "Распознаю речь…"
        : "Обрабатываю команду…")
  );
}
