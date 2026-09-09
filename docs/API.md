# API MVP

Все JSON-ответы: `{ "ok": true, "data": ... }` либо `{ "ok": false, "error": { "code": "...", "message": "..." } }`. HTTP 400 — валидация, 401 — токен, 403 — роль/Origin, 404 — объект/владелец, 409 — несовместимое состояние, 410 — срок, 413 — размер, 415 — MIME, 429 — лимит. Ошибка фонового STT/LLM/macOS возвращается в CommandRecord со status=error.

Клиент: cookie `voice_session`, браузер получает её через pair complete. Для CLI можно использовать `Authorization: Bearer <client-token>`, полученный доверенным локальным способом; обычный pair complete намеренно не возвращает токен в JSON. Mac: Bearer agent-token. К JSON POST добавляйте Content-Type. Для cookie-запросов добавляйте разрешённый Origin (браузер делает это сам).

| Метод / маршрут                | Вход                                 | Выход / доступ                                                                                                                    |
| ------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| GET /health                    | —                                    | `{status:"ok"}`, публичный, без метаданных                                                                                        |
| POST /api/auth/pair/start      | `{name?:string}`                     | `{deviceId,code,expiresAt,token?}`, bootstrap Bearer для новой identity или Bearer Mac для нового кода; token только при создании |
| POST /api/auth/pair/complete   | `{code:"12345678",name?:string}`     | `{deviceId,name,agentId}` + HttpOnly Set-Cookie; одноразовый код                                                                  |
| POST /api/text-command         | `{text:string}`                      | 202 + CommandRecord; при ожидаемом уточнении продолжает текущую команду                                                           |
| POST /api/voice                | multipart, одно audio-поле, до 8 MiB | 202 + CommandRecord transcribing; audio/webm, mp4, mpeg, ogg, wav, x-wav, aac                                                     |
| GET /api/commands/:id          | UUID                                 | CommandRecord, только инициатор                                                                                                   |
| POST /api/commands/:id/confirm | `{approved:true}`                    | CommandRecord, только status=confirmation                                                                                         |
| POST /api/commands/:id/clarify | `{answer:string}`                    | CommandRecord; ID варианта, имя или номер/ответ                                                                                   |
| POST /api/commands/:id/cancel  | `{}`                                 | cancelled; после dispatch 409                                                                                                     |
| GET /api/history               | —                                    | Последние 30 записей пространства                                                                                                 |
| GET /api/devices               | —                                    | `{id,name,role,agentId,revoked,createdAt,online}[]`                                                                               |
| DELETE /api/devices/:id        | UUID устройства пространства         | `{revoked:id}`; закрывает WS, очищает cookie при самоотзыве                                                                       |
| GET /api/config                | —                                    | Registry                                                                                                                          |
| PUT /api/config                | полный Registry                      | Проверенный и сохранённый Registry; во время команды 409                                                                          |
| GET /api/runtime               | —                                    | `{stt,intent,realActions,platform,supportedActions,deviceId}`                                                                    |
| WS /ws/client                  | cookie + точный Origin               | События command и devices                                                                                                         |
| WS /ws/mac-agent               | Bearer Mac                           | Hello, command envelope и result                                                                                                  |

## Пример текстовой команды

После pairing сохраните Set-Cookie в cookie jar (не публикуйте его):

```bash
curl -c /tmp/voice-cookie -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:8787' \
  -d '{"code":"КОД_ИЗ_ТЕРМИНАЛА","name":"CLI"}' \
  http://localhost:8787/api/auth/pair/complete

curl -b /tmp/voice-cookie -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:8787' \
  -d '{"text":"Давай поработаем над OTP"}' \
  http://localhost:8787/api/text-command
```

Polling: `GET /api/commands/<data.id>` с той же cookie. Более удобный автоматический smoke: `node scripts/smoke.mjs` при запущенном приложении; он не печатает секреты и отзывает созданное тестовое устройство.

## CommandRecord

```json
{
  "id": "UUID пользовательской команды",
  "deviceId": "UUID телефона",
  "agentId": "UUID Mac",
  "text": "Давай поработаем над OTP",
  "status": "done",
  "createdAt": 1788840000000,
  "expiresAt": 1788840060000,
  "command": {
    "action": "open_project",
    "parameters": { "projectId": "cascade-otp" }
  },
  "result": {
    "success": true,
    "message": "Mock: Открыт проект Cascade OTP",
    "data": { "mock": true }
  }
}
```

Опциональные поля: decision, question, options, files, confirmed. Времена — Unix milliseconds. Возможные status: transcribing, processing, confirmation, clarification, executing, done, error, cancelled.

## WebSocket

Телефон получает:

```json
{"type":"command","command":{"id":"...","status":"done"}}
{"type":"devices","devices":[{"id":"...","role":"agent","online":true}]}
```

Объекты здесь сокращены для чтения; фактически отправляется полный CommandRecord/Device. Телефон не отправляет команды через WS: изменения идут через валидируемый HTTP API.

Mac/Windows-агент при подключении отправляет `{type:"hello",realActions,shortcuts,platform?,supportedActions?}`; старые агенты без platform/supportedActions считаются полностью совместимыми. Локальные executable/args никогда не отправляются модели.

Сервер → Mac:

```json
{
  "type": "command",
  "envelope": {
    "id": "уникальный execution UUID",
    "createdAt": 1788840000000,
    "expiresAt": 1788840060000,
    "confirmed": false,
    "command": {
      "action": "open_project",
      "parameters": { "projectId": "cascade-otp" }
    },
    "registry": { "projects": [], "applications": [] }
  }
}
```

Mac → сервер: `{type:"result",id:executionUUID,result:{success,message,data?,files?}}`. Files: максимум 10 `{id,name,path,modifiedAt}`. Сервер сопоставляет execution ID с пользовательским command ID и авторизованным Mac; неожиданные ID игнорируются. Неверные frames закрывают соединение (1008), отзыв — 4001, замена соединения — 4000.

Поиск: parameters `{query?:string,extension?:string,kind?:"pdf"|"presentation",modifiedAfter?:UTC_ISO8601,latest?:boolean,open?:boolean}`. Значения по умолчанию: query="", latest=false, open=true. Для просмотра списка без автоматического открытия используйте open=false через решение интерпретатора. Схемы всех действий — `packages/shared/src/index.ts`.
