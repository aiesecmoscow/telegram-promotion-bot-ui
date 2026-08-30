# Per-user результаты рассылки на главном экране

## Цель

Пользователь видит на главном экране, **кому** сообщение ушло, **кому нет** и **почему** (с сырым TL-кодом ошибки Telegram). Рассылка остаётся fire-and-forget по POST, но возвращает `jobId`, по которому фронт получает состояние и per-user результаты.

## Решения, согласованные с пользователем

1. **Механизм обновлений**: `GET /api/job/:id` + polling каждые 2 с (пока `Processing`), затем каждые 10 с для покаа последних результатов до старта новой рассылки.
2. **`FLOOD_WAIT_X`**: подождать X секунд, повторить того же `username` один раз; при повторной ошибке — пометить `failed` и идти дальше.
3. **Конкурентные job'ы**: пока есть `Processing` job — `POST /api/send-messages` возвращает `409 Conflict`.
4. **Ошибки в UI**: показывать только сырой TL-код (`errorMessage`/`error.code`), без категоризации.

## Архитектура данных

### Backend: `Job` (in-memory `Map<jobId, Job>`)

```ts
type RecipientStatus = 'sent' | 'failed' | 'skipped';

interface RecipientResult {
  username: string;           // как ввёл пользователь (с @ или без)
  status: RecipientStatus;
  error?: string;             // TL errorMessage ИЛИ строка из catch (только код/сообщение, без PII)
  attemptedAt?: string;       // ISO
  attempts: number;           // 1 или 2 (после FLOOD_WAIT-ретрая)
}

interface Job {
  id: string;                 // crypto.randomUUID()
  status: 'Processing' | 'Completed' | 'Failed';
  errorMessage?: string;      // для глобального Failed (USER_BANNED, AUTH_KEY_*)
  total: number;
  processed: number;          // sent + failed + skipped
  sent: number;
  failed: number;
  currentUsername?: string;   // кого обрабатываем прямо сейчас (для live-индикатора)
  results: RecipientResult[]; // наращивается по мере обработки
  createdAt: string;
  finishedAt?: string;
}
```

- Хранилище: `const jobs = new Map<string, Job>()` в `backend/src/index.ts`.
- Автоочистка: удалять job'ы, у которых `finishedAt < now - 24h`, при каждом новом `POST /api/send-messages` (lazy GC). Защита от утечки памяти.
- Потеря при рестарте бэка — допустимо (документировано в README).

### API

#### `POST /api/send-messages` (изменён)

- Тело без изменений: `{ usernames: string[], message: string, cooldownSeconds: number }`.
- Ответ **200**: `{ jobId, status: "Processing", totalUsers }`.
- **409 Conflict**, если есть `Processing` job: `{ error: "Another job is already running", jobId: <id текущей> }`. Фронт подхватит этот `jobId` и продолжит показывать актуальную рассылку.
- **400** если `usernames` пустой.

#### `GET /api/job/:jobId` (новый)

- **200**: объект `Job` целиком.
- **404**: `{ error: "Job not found" }` — например, после рестарта бэка или по истечении 24 ч.

## Изменения в backend

Файл: `promotion-bot-ui/backend/src/index.ts` + `promotion-bot-ui/backend/src/telegram.ts`.

### 1. `telegram.ts` — утилиты для обработки ошибок Telethon

Добавить чистую функцию `extractTelegramError(err: unknown): string`:

- Приоритетно `err.errorMessage` (TL short name, например `USERNAME_NOT_OCCUPIED`).
- Затем `err.code` (числовой TL error code), если `errorMessage` пуст.
- Затем `err.message` как fallback.
- Никогда не возвращать stack/объект целиком — только короткую строку.

### 2. `index.ts` — рефакторинг `sendMessagesAsync`

- Принимает `jobId`, чтобы обновлять `currentUsername`/счётчики/`results` в `jobs.set(jobId, …)`.
- На каждой итерации:
  1. `try { await telegram.sendMessage(...) }` → пушим `RecipientResult{ status:'sent', attempts, attemptedAt }`, инкремент `sent`/`processed`, чистим `currentUsername`.
  2. На `catch`: вычисляем `errCode = extractTelegramError(err)`.
     - Если `errCode === 'USER_BANNED'` или начинается с `AUTH_KEY_` или `SESSION_REVOKED`:
       - Всем оставшимся `username` пушим `RecipientResult{ status:'skipped', error: errCode }` (одним проходом по хвосту списка).
       - `job.status = 'Failed'`, `job.errorMessage = errCode`, `job.finishedAt = now`, `break`.
     - Если `errCode` начинается с `FLOOD_WAIT_` (Telethon бросает `FloodWaitError` с `.seconds`):
       - Если `attempts < 2`: `attempts++`, `await sleep(seconds*1000)`, повтор `sendMessage` для **этого же** `username` в том же шаге цикла.
       - Иначе: пушим `RecipientResult{ status:'failed', error: errCode, attempts }`, инкремент `failed`/`processed`.
     - Иначе: `RecipientResult{ status:'failed', error: errCode, attempts: 1 }`, инкремент `failed`/`processed`.
- После цикла (нормальное завершение): `job.status = 'Completed'`, `job.finishedAt = now`, чистим `currentUsername`.

### 3. `index.ts` — новые эндпоинты и хранилище

```ts
const jobs = new Map<string, Job>();
let activeJobId: string | null = null; // быстрый путь для 409

app.post('/api/send-messages', ...): // в начале:
  if (activeJobId) {
    const active = jobs.get(activeJobId);
    if (active && active.status === 'Processing') {
      return res.status(409).json({ error: 'Another job is already running', jobId: activeJobId });
    }
  }
  // lazy GC
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [id, j] of jobs) if (j.finishedAt && Date.parse(j.finishedAt) < cutoff) jobs.delete(id);

  const jobId = crypto.randomUUID();
  const job: Job = { id: jobId, status: 'Processing', total: usernames.length, processed: 0, sent: 0, failed: 0, results: [], createdAt: new Date().toISOString() };
  jobs.set(jobId, job);
  activeJobId = jobId;

  res.json({ jobId, status: 'Processing', totalUsers: usernames.length });

  sendMessagesAsync(jobId, usernames, message, cooldownSeconds || 10)
    .finally(() => { if (activeJobId === jobId) activeJobId = null; });

app.get('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});
```

`sendMessagesAsync` после каждой операции пишет обновлённый `job` обратно в `Map` (одна ссылка, объект мутируется — достаточно `jobs.get(id)` после изменения, но для ясности делаем явный `jobs.set(id, { ...job })` после крупных этапов: старт, каждые ~20 записей в `results`, финиш).

## Изменения во frontend

Файл: `promotion-bot-ui/frontend/src/components/MainPage.tsx` (+ опционально вынести логику polling в хук `useJobPolling.ts`).

### Состояние `MainPage`

```ts
const [activeJobId, setActiveJobId] = useState<string | null>(
  () => localStorage.getItem('last_job_id')
);
const [job, setJob] = useState<Job | null>(null);
const [pollingInterval, setPollingInterval] = useState<number>(0); // ms, 0 = off
```

### Polling-цикл (через `useEffect`)

- При изменении `activeJobId`:
  - Если есть — `fetch /api/job/:id` сразу, затем `setInterval` на 2 с пока `status === 'Processing'`, потом переключить на 10 с.
  - На `404` (бэк рестартовался / job удалён GC): `setActiveJobId(null)`, `localStorage.removeItem('last_job_id')`, остановить polling.
  - Если `status === 'Completed' | 'Failed'` — остановить интервал, оставить `job` в state для показа результатов.
- Сохранять `activeJobId` в `localStorage` при успешном `POST /api/send-messages` и при восстановлении при монтировании.

### Submit-flow

- После успешного `POST /api/send-messages`:
  - Если `409`: `setActiveJobId(data.jobId)`, ничего не показываем как ошибку — просто подхватываем чужой job. Показать info: «Уже идёт рассылка, показываем её прогресс».
  - Иначе: `setActiveJobId(data.jobId)`, `localStorage.setItem('last_job_id', data.jobId)`, polling запустится автоматически через effect.

### UI — блок «Results» (ниже формы)

Только когда `job` есть. Содержимое:

1. **Шапка**:
   - `Status: Processing | Completed | Failed`
   - Прогресс: `sent / total` и `failed / total` (две тонкие полоски или один `progress bar` с двумя сегментами).
   - Если `currentUsername` — «Сейчас отправляем: @username».
   - Если `errorMessage` (глобальный Failed) — показать его явно, список `skipped` получателей уже есть ниже.

2. **Сводка после финиша**:
   - `Sent: N`, `Failed: M`, `Skipped: K`.

3. **Список Failed** (свёрнут, если >10):
   - Каждый: `@username — USERNAME_NOT_OCCUPIED` (показывать `result.error` как есть).
   - Кнопка «Copy failed list» — копирует `username` + `\t` + `error` в clipboard (полезно для ручной повторной рассылки тем, кому можно).
   - Кнопка «Copy sent list» — аналогично для успешных.

4. **Список Sent** (свёрнут, если >10):
   - Только `@username` построчно.

5. **Список Skipped** (показывается только если есть, из-за глобального Failed):
   - `@username — <reason>`.

6. Кнопка **«Clear results»** — `setActiveJobId(null)`, `localStorage.removeItem('last_job_id')`, скрыть блок.

### Disabled state формы

- Пока `job?.status === 'Processing'` — кнопка `Start Sending` disabled, текст `Sending… (sent/total)`. Это согласуется с 409-логикой: повторный submit всё равно вернёт 409, но UX подсказывает причину заранее.

## Изменения в README

Файл: `README.md`.

- Заменить устаревший раздел про `/auth/*` и `/job` (Python/FastAPI) на актуальный Express/TS backend: перечислить `POST /api/send-messages`, `GET /api/job/:id`.
- В «Известные ограничения» добавить: «Список job'ов и их результаты хранятся в памяти и теряются при рестарте бэка; автоудаление через 24 ч после завершения».

## Валидация

1. **Backend — unit/probe (ручной curl-сценарий, без отдельного фреймворка тестов в проекте нет)**:
   - `POST /api/send-messages` с N=3 usernames → 200 + `jobId`.
   - `POST /api/send-messages` повторно до завершения → 409 + тот же `jobId`.
   - `GET /api/job/:id` каждые 2 с: `processed` растёт, `currentUsername` меняется, в конце `status: 'Completed'`, `sent + failed === total`.
   - `GET /api/job/<random>` → 404.
2. **Backend — проверка кода ошибок**:
   - Username `__definitely_not_exists_12345__` → в `results` появится запись с `status: 'failed'`, `error: 'USERNAME_NOT_OCCUPIED'`.
   - Отправить самому себе (известный username владельца аккаунта) → `sent`.
3. **Frontend — lint + build**:
   - `cd promotion-bot-ui/frontend && bun run lint && bun run build` — без ошибок типов и линтера.
   - `cd promotion-bot-ui/backend && npx tsc --noEmit` — без ошибок типов.
4. **Smoke E2E**:
   - Запустить `bun run dev` фронта и бэк, пройти auth, отправить список из 5 usernames (включая заведомо несуществующий), убедиться что в блоке Results видны 4 sent + 1 failed с кодом.

## Риски и компенсации

| Риск | Компенсация |
| --- | --- |
| Polling-молотилка при простое | После `Completed`/`Failed` интервал переключается на 10 с; кнопка `Clear results` останавливает полностью |
| Backend рестарт во время рассылки | Job пропадает → фронт получает 404 → чистит `activeJobId`, пользователь видит «Results lost, please resend» (или просто блок исчезает без шума — выбираем без шума) |
| Очень длинный список (>10k) убьёт UI | Пагинация/виртуализация **out of scope** для этого плана; ограничиваемся разумными размерами (≤500 usernames на одну рассылку) и предупреждаем в help-text под textarea |
| `localStorage` устарел, ссылается на удалённый job | Один 404 → чистим, дальше работаем без него |
| `error.message` от Telethon может содержать внутренний стек | Используем только `extractTelegramError`, никогда `error.stack`/`String(error)` |

## Out of scope

- Персистенция job'ов между рестартами бэка (БД/Redis).
- Аутентификация между фронтом и бэком.
- Виртуализация длинных списков, экспорт в CSV, фильтрация.
- Авторизация по `StringSession` (текущий код требует повторного прохождения phone→code каждый раз — не в фокусе этого плана).
- SSE/WebSocket — не выбрано пользователем.

## Чек-лист для исполнителя

1. `telegram.ts`: добавить `extractTelegramError`.
2. `index.ts`: ввести `Job`, `jobs` Map, `activeJobId`; рефакторить `sendMessagesAsync` под `jobId`, с ретраем на `FloodWaitError`, глобальным Failed на `USER_BANNED`/`AUTH_KEY_*`/`SESSION_REVOKED`, скипом хвоста.
3. `index.ts`: сменить `POST /api/send-messages` (200 + `jobId`, 409 при активном job), добавить `GET /api/job/:id` (200/404), добавить lazy GC.
4. `MainPage.tsx`: состояние `activeJobId`/`job`/polling, эффект на polling с переключением интервала, обработка 409, persist в `localStorage`, рендер Results-блока (summary, failed/sent/skipped списки, кнопки copy/clear).
5. `MainPage.tsx`: disabled submit и текст с прогрессом пока job в `Processing`.
6. `README.md`: обновить раздел API и список ограничений.
7. Прогнать `bun run lint`, `bun run build` во фронте и `npx tsc --noEmit` в бэке.
8. Прогнать ручной smoke (curl + UI) по сценарию из раздела «Валидация».