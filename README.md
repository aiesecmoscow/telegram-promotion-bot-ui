# Telegram Promotion Bot UI

Веб-приложение для авторизации в Telegram и запуска массовых рассылок личных сообщений через пользовательский аккаунт.

Проект состоит из двух сервисов, объединённых через Docker Compose:

- **Backend** — FastAPI-приложение на Python с библиотекой [Telethon](https://docs.telethon.dev/), которое общается с Telegram от имени авторизованного пользователя.
- **Frontend** — одностраничное React-приложение на TypeScript + Tailwind CSS + daisyui, бандлинг и раздача через `Bun.serve` (`server.ts`).

## Возможности

- Авторизация по номеру телефона с подтверждением через SMS/Telegram-код.
- Опциональный вход по существующему `StringSession` — без ввода телефона и кода (для случаев, когда сессия уже получена через `client.session.save()` или в другом клиенте).
- Условный запрос 2FA-пароля: поле пароля показывается только если Telegram сообщает `SessionPasswordNeededError` (то есть на аккаунте реально включена 2FA).
- Отправка одного сообщения списку пользователей Telegram (по username или номеру телефона).
- Автоматическая обработка `FloodWaitError` от Telegram: воркер делает паузу на запрошенное время и продолжает рассылку.
- Сессия Telethon хранится в `localStorage` браузера — повторный ввод кода не требуется до истечения сессии.
- Асинхронные задачи рассылки с отслеживанием статуса (`Processing` / `Completed` / `Failed`).

## Архитектура

```
┌──────────┐   /api/*    ┌──────────────┐   Telethon    ┌────────────┐
│ Браузер  │ ──────────▶ │ Bun.serve:8080│ ────────────▶ │  Telegram  │
│ (SPA)    │             │   (frontend) │               │     API    │
└──────────┘             └──────┬───────┘               └────────────┘
                                │
                                ▼
                        ┌──────────────┐
                        │ backend:8000 │
                        │   (FastAPI)  │
                        └──────────────┘
```

Сервисы определены в [`compose.yml`](./compose.yml):

| Сервис   | Порт хоста | Порт контейнера | Описание                         |
| -------- | ---------- | --------------- | -------------------------------- |
| backend  | `8000`     | `8000`          | FastAPI + Telethon               |
| frontend | `3000`     | `8080`          | `Bun.serve` (статика + reverse-proxy `/api/*`) |

Проксирование `/api/*` настроено в [`frontend/server.ts`](./frontend/server.ts).

## Требования

- [Docker](https://docs.docker.com/get-docker/) и [Docker Compose](https://docs.docker.com/compose/install/) — для запуска через `compose.yml`.
- **Или**, для локальной разработки без Docker:
  - Python **3.14** и пакетный менеджер [uv](https://docs.astral.sh/uv/).
  - [Bun](https://bun.sh) **1.x**.
- Учётные данные Telegram API: **`API_ID`** и **`API_HASH`** — получить на [my.telegram.org](https://my.telegram.org) в разделе «API development tools».

## Быстрый старт (Docker)

1. Создайте файл `.env` в корне проекта (если его ещё нет) и заполните обязательные переменные:

   ```env
   API_ID=12345678
   API_HASH=your_api_hash_here
   ```

2. Запустите оба сервиса:

   ```bash
   docker compose up --build
   ```

3. Откройте UI в браузере: [http://localhost:3000](http://localhost:3000).

   Backend будет доступен на [http://localhost:8000](http://localhost:8000) (документация Swagger — `/docs`).

## Локальная разработка

### Backend

```bash
cd backend
uv sync
uv run fastapi run main.py --port 8000 --host 0.0.0.0
```

Backend стартует на `http://localhost:8000`. Документация OpenAPI — на `/docs`.

### Frontend

По умолчанию в [`frontend/server.ts`](./frontend/server.ts) значение `BACKEND_URL` — `http://localhost:8000`. Для запуска вне Docker достаточно поднять backend на этом порту (см. выше). В Docker-сети используется `http://backend:8000` (см. [`compose.yml`](./compose.yml)).

```bash
cd frontend
bun install
bun run dev
```

Dev-сервер `Bun.serve` стартует на `http://localhost:8080` с HMR.

## Переменные окружения

| Переменная  | Тип    | Описание                                                |
| ----------- | ------ | ------------------------------------------------------- |
| `API_ID`    | int    | Идентификатор приложения Telegram (my.telegram.org).    |
| `API_HASH`  | string | Хэш приложения Telegram.                                |

Значения читаются бэкендом через `pydantic-settings` из файла `.env` ([`backend/main.py`](./backend/main.py)).

**Важно:** `.env` с реальными `API_ID` и `API_HASH` **нельзя коммитить в репозиторий**. В production используйте секреты Docker / Kubernetes / Vault.

## API

Полное описание моделей и схем — в Swagger (`/docs`) или в исходниках [`backend/main.py`](./backend/main.py).

### `POST /auth/send-code`

Запрашивает код подтверждения у Telegram.

- Тело запроса: `{ "phone_number": "+1234567890" }`
- Ответ: `{ "phone_number": "...", "phone_code_hash": "...", "session_string": "..." }`
- Коды ошибок: `400` (неверный номер или ошибка Telegram), `401` (номер не зарегистрирован).

### `POST /auth/sign-in`

Завершает авторизацию по коду. 2FA-пароль запрашивается только если Telegram реально требует его: первый вызов (без `password`) для аккаунта с 2FA возвращает `401 password_required`, после чего фронт повторно вызывает эндпоинт с `password`.

- Тело запроса:
  ```json
  {
    "session_string": "...",
    "phone_code_hash": "...",
    "phone_number": "+1234567890",
    "verification_code": "12345",
    "password": "optional-2fa-password"
  }
  ```
- Ответ: `{ "session_string": "..." }` — авторизованная сессия для последующих запросов.
- Коды ошибок:
  - `400` — неверный код или иная ошибка авторизации; тело `{"detail": "<сообщение>"}`.
  - `401` — `{"detail": {"detail": "2FA Password required", "code": "password_required"}}` — 2FA требуется, поле `password` не передано.
  - `401` — `{"detail": {"detail": "Invalid 2FA password", "code": "invalid_password"}}` — переданный 2FA-пароль неверный.

### `POST /auth/sign-in-session`

Альтернативный вход по уже существующему `StringSession` — без прохождения flow «телефон → SMS-код → 2FA». Бэкенд проверяет сессию через Telethon и возвращает её обновлённую копию (Telegram может ротировать auth keys, поэтому возвращаемая строка может отличаться от входной — её нужно сохранить и использовать для последующих `/job` запросов).

- Тело запроса:
  ```json
  { "session_string": "..." }
  ```
- Ответ: `{ "session_string": "..." }` — авторизованная сессия для последующих запросов.
- Коды ошибок:
  - `400` — строка невалидна, не является `StringSession` Telethon или не удаётся подключиться; тело `{"detail": "<сообщение>"}`.
  - `401` — сессия валидна по формату, но пользователь не авторизован (сессия истекла или была завершена); тело `{"detail": "Invalid or expired session"}`.

### `POST /job`

Создаёт фоновую задачу массовой рассылки.

- Тело запроса:
  ```json
  {
    "session_string": "...",
    "usernames": ["alice", "bob", "+1234567890"],
    "message": "Hello!"
  }
  ```
- Ответ: `{ "job_id": "uuid", "status": "Job started asynchronously" }`.
- Задача выполняется асинхронно; между отправками выдерживается пауза ~20 с, при `FloodWaitError` — пауза на запрошенное Telegram время.

### `GET /job/{job_id}`

Возвращает текущий статус задачи.

- Ответ: `{ "job_id": "uuid", "status": "Processing" | "Completed" | "Failed: <error>"" }`.
- Код `404`, если задача не найдена.

## Структура репозитория

```
.
├── backend/                       # FastAPI + Telethon
│   ├── main.py                    # Все эндпоинты и воркер рассылки
│   ├── Dockerfile
│   ├── pyproject.toml
│   └── uv.lock
├── frontend/                      # React + TypeScript + Bun.serve
│   ├── src/
│   │   ├── App.tsx                # SPA: login → verify → [password] → main
│   │   └── api.ts                 # Обёртки над /api/*
│   ├── server.ts                  # Bun.serve: статика + прокси /api
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig*.json
├── compose.yml                    # Оркестрация сервисов
└── .env                           # НЕ коммитить (API_ID, API_HASH)
```

## Известные ограничения

- **In-memory состояние задач.** Словарь `jobs_db` хранится в памяти процесса бэкенда и теряется при рестарте. Для production следует подключить Redis или БД.
- **Нет аутентификации между фронтом и бэком.** Любой клиент, способный обратиться к `/api/*`, может использовать бэкенд. Доступ к API ограничивается только сетевыми правилами.
- **Ошибки отправки отдельным получателям** (заблокирован аккаунт, неверный username и т. п.) только логируются в `stdout`, но не останавливают рассылку и не отражаются в статусе задачи.
- **Жёсткие задержки** между сообщениями заданы константой в коде (см. `asyncio.sleep(20)` в [`backend/main.py`](./backend/main.py)) — для масштабных рассылок потребуется настройка.
- В репозитории могут встречаться комментарии с фрагментами `StringSession` — в коммитах не должно быть реальных сессий.

## Безопасность и правовые оговорки

- **Массовая рассылка личных сообщений через пользовательский аккаунт нарушает [Условия использования Telegram](https://telegram.org/tos) и может привести к временной или постоянной блокировке аккаунта (включая спам-блок через `FloodWaitError`).** Используйте инструмент осознанно и только для рассылок, на которые получатели дали согласие.
- **Не публикуйте** `API_HASH`, `StringSession` и другие секреты в публичных репозиториях, issue-трекерах и логах.
- Автор не несёт ответственности за блокировки аккаунтов и иные последствия использования этого инструмента.

## Лицензия

Лицензия не указана. Если вы планируете публиковать проект как open-source — добавьте файл `LICENSE` (например, MIT или Apache-2.0).
