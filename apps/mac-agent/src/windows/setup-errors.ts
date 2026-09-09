/** Map Zod / HTTP / raw errors to short Russian UI text (no JSON dumps). */
export function friendlySetupError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Неизвестная ошибка";
  const m = raw.replace(/\s+/g, " ").trim();

  if (/bootstrap.*at least 1|String must contain at least 1/i.test(m))
    return "Введите bootstrap-секрет с сервера. Поле нельзя оставлять пустым при первой привязке.";
  if (/Требуется bootstrap|UNAUTHORIZED|неверн.*секрет|bootstrap-секрет агента/i.test(m))
    return "Неверный bootstrap-секрет. Проверьте значение на сервере и попробуйте снова.";
  if (/Сервер не вернул токен/i.test(m))
    return "Сервер не выдал токен. Проверьте секрет и доступность https://dauys.esl.kz.";
  if (/HTTPS|требуется HTTPS/i.test(m))
    return "Для удалённого сервера нужен адрес HTTPS.";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|Failed to fetch|AbortError|timeout/i.test(m))
    return "Не удалось связаться с сервером. Проверьте адрес и интернет.";
  if (/HTTP 401|HTTP 403/i.test(m))
    return "Сервер отклонил доступ. Проверьте bootstrap-секрет или выполните повторную привязку.";
  if (/HTTP 404/i.test(m))
    return "Сервер не знает этот запрос. Обновите сервер или продолжите с сохранённой привязкой.";
  if (/Invalid URL|invalid_string|url/i.test(m) && /serverUrl|URL/i.test(m))
    return "Укажите корректный адрес сервера (например https://dauys.esl.kz).";
  if (/Expected string|invalid_type|ZodError|\[\{/i.test(m))
    return "Проверьте заполненные поля. Если привязка уже есть — оставьте секрет пустым и нажмите «Проверить соединение».";
  if (m.length > 180) return m.slice(0, 177) + "…";
  return m || "Не удалось выполнить действие.";
}
