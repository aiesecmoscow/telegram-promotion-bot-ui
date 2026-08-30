import express, { Request, Response } from 'express';
import * as telegram from './telegram';

const app = express();
const port = 3001;

// Middleware для парсинга JSON
app.use(express.json());

// Простой CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }

    next();
});

// Интерфейсы для типизации запросов
interface InitClientRequest {
    apiId: number;
    apiHash: string;
    sessionString?: string;
}

interface StartAuthRequest {
    phoneNumber: string;
}

interface SignInRequest {
    phoneNumber: string;
    phoneCodeHash: string;
    phoneCode: string;
}

interface CheckPasswordRequest {
    password: string;
}

interface SendMessagesRequest {
    usernames: string[];
    message: string;
    cooldownSeconds: number;
}

// API для инициализации клиента
app.post('/api/init', async (req: Request<{}, {}, InitClientRequest>, res: Response) => {
    try {
        const { apiId, apiHash, sessionString } = req.body;

        if (!apiId || !apiHash) {
            return res.status(400).json({ error: 'apiId and apiHash are required' });
        }

        await telegram.initClient(apiId, apiHash, sessionString);
        res.json({ success: true, message: 'Client initialized' });
    } catch (error: any) {
        console.error('Error initializing client:', error);
        res.status(500).json({ error: error.message });
    }
});

// API для начала аутентификации
app.post('/api/auth/start', async (req: Request<{}, {}, StartAuthRequest>, res: Response) => {
    try {
        const { phoneNumber } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'phoneNumber is required' });
        }

        const result = await telegram.startAuth(phoneNumber);
        res.json(result);
    } catch (error: any) {
        console.error('Error starting auth:', error);
        res.status(500).json({ error: error.message });
    }
});

// API для входа с кодом
app.post('/api/auth/signin', async (req: Request<{}, {}, SignInRequest>, res: Response) => {
    try {
        const { phoneNumber, phoneCodeHash, phoneCode } = req.body;

        if (!phoneNumber || !phoneCodeHash || !phoneCode) {
            return res.status(400).json({ error: 'phoneNumber, phoneCodeHash, and phoneCode are required' });
        }

        const result = await telegram.signIn(phoneNumber, phoneCodeHash, phoneCode);
        res.json(result);
    } catch (error: any) {
        console.error('Error signing in:', error);
        res.status(500).json({ error: error.message });
    }
});

// API для проверки пароля 2FA
app.post('/api/auth/password', async (req: Request<{}, {}, CheckPasswordRequest>, res: Response) => {
    try {
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ error: 'password is required' });
        }

        const result = await telegram.checkPassword(password);
        res.json(result);
    } catch (error: any) {
        console.error('Error checking password:', error);
        res.status(500).json({ error: error.message });
    }
});

// API для получения текущей сессии
app.get('/api/session', (req: Request, res: Response) => {
    try {
        const sessionString = telegram.getSessionString();
        res.json({ session: sessionString });
    } catch (error: any) {
        console.error('Error getting session:', error);
        res.status(500).json({ error: error.message });
    }
});

// Хранилище активных и недавних job'ов рассылки
type RecipientStatus = 'sent' | 'failed' | 'skipped';

interface RecipientResult {
    username: string;
    status: RecipientStatus;
    error?: string;
    attemptedAt?: string;
    attempts: number;
}

interface Job {
    id: string;
    status: 'Processing' | 'Completed' | 'Failed';
    errorMessage?: string;
    total: number;
    processed: number;
    sent: number;
    failed: number;
    currentUsername?: string;
    results: RecipientResult[];
    createdAt: string;
    finishedAt?: string;
}

const jobs = new Map<string, Job>();

function gcOldJobs() {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [id, j] of jobs) {
        if (j.finishedAt && Date.parse(j.finishedAt) < cutoff) {
            jobs.delete(id);
        }
    }
}

// API для запуска рассылки сообщений
app.post('/api/send-messages', async (req: Request<{}, {}, SendMessagesRequest>, res: Response) => {
    try {
        const { usernames, message, cooldownSeconds } = req.body;

        if (!usernames || !Array.isArray(usernames) || usernames.length === 0) {
            return res.status(400).json({ error: 'usernames array is required' });
        }

        if (!message) {
            return res.status(400).json({ error: 'message is required' });
        }

        gcOldJobs();

        const jobId = crypto.randomUUID();
        const job: Job = {
            id: jobId,
            status: 'Processing',
            total: usernames.length,
            processed: 0,
            sent: 0,
            failed: 0,
            results: [],
            createdAt: new Date().toISOString(),
        };
        jobs.set(jobId, job);

        res.json({
            jobId,
            status: 'Processing',
            totalUsers: usernames.length,
        });

        sendMessagesAsync(jobId, usernames, message, cooldownSeconds || 10);
    } catch (error: any) {
        console.error('Error sending messages:', error);
        res.status(500).json({ error: error.message });
    }
});

// API для получения состояния job'а рассылки
app.get('/api/job/:jobId', (req: Request, res: Response) => {
    const jobId = req.params.jobId;
    if (!jobId) {
        return res.status(404).json({ error: 'Job not found' });
    }
    const job = jobs.get(jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
});

// Функция для асинхронной отправки сообщений
async function sendMessagesAsync(
    jobId: string,
    usernames: string[],
    message: string,
    cooldownSeconds: number
) {
    const job = jobs.get(jobId);
    if (!job) return;

    for (let i = 0; i < usernames.length; i++) {
        const username = usernames[i];

        if (!username) {
            console.error(`⚠️ Skipping empty username at index ${i}`);
            continue;
        }

        job.currentUsername = username;

        let attempts = 0;
        let sent = false;
        let failedError: string | null = null;
        let fatalError: string | null = null;

        try {
            attempts++;
            console.log(`[${i + 1}/${usernames.length}] Sending message to ${username}...`);
            await telegram.sendMessage(username, message);
            console.log(`✓ Message sent to ${username}`);
            sent = true;
        } catch (err: unknown) {
            const errCode = telegram.extractTelegramError(err);

            if (
                errCode === 'USER_BANNED' ||
                errCode === 'SESSION_REVOKED' ||
                errCode.startsWith('AUTH_KEY_')
            ) {
                fatalError = errCode;
            } else if (errCode.startsWith('FLOOD_WAIT_')) {
                const seconds = telegram.extractFloodWaitSeconds(err);
                if (attempts < 2 && seconds !== null) {
                    console.log(`⏳ Flood wait ${seconds}s, retrying ${username}...`);
                    await sleep(seconds * 1000);
                    try {
                        attempts++;
                        await telegram.sendMessage(username, message);
                        console.log(`✓ Message sent to ${username} (retry)`);
                        sent = true;
                    } catch (err2: unknown) {
                        failedError = telegram.extractTelegramError(err2);
                    }
                } else {
                    failedError = errCode;
                }
            } else {
                failedError = errCode;
            }
        }

        if (fatalError !== null) {
            console.error(`✗ Fatal error on ${username}: ${fatalError}. Stopping job.`);
            job.results.push({
                username,
                status: 'skipped',
                error: fatalError,
                attempts,
            });
            for (let j = i + 1; j < usernames.length; j++) {
                const u = usernames[j];
                if (u) {
                    job.results.push({
                        username: u,
                        status: 'skipped',
                        error: fatalError,
                        attempts: 0,
                    });
                    job.processed++;
                }
            }
            job.status = 'Failed';
            job.errorMessage = fatalError;
            job.finishedAt = new Date().toISOString();
            delete job.currentUsername;
            jobs.set(jobId, { ...job });
            return;
        }

        if (sent) {
            job.results.push({
                username,
                status: 'sent',
                attempts,
                attemptedAt: new Date().toISOString(),
            });
            job.sent++;
        } else {
            const errorMsg = failedError ?? 'UNKNOWN_ERROR';
            job.results.push({
                username,
                status: 'failed',
                error: errorMsg,
                attempts,
                attemptedAt: new Date().toISOString(),
            });
            job.failed++;
        }
        job.processed++;
        delete job.currentUsername;

        // Периодически сбрасываем обновлённый job в Map, чтобы ссылки оставались свежими
        if (job.results.length % 20 === 0) {
            jobs.set(jobId, { ...job });
        }

        if (i < usernames.length - 1) {
            console.log(`Waiting ${cooldownSeconds} seconds before next message...`);
            await sleep(cooldownSeconds * 1000);
        }
    }

    job.status = 'Completed';
    job.finishedAt = new Date().toISOString();
    delete job.currentUsername;
    jobs.set(jobId, { ...job });
    console.log('✓ Message sending completed');
}

// Утилита для задержки
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/', (req, res) => {
    res.send('Telegram Promotion Bot Backend is running!');
});

app.listen(port, () => {
    console.log(`Backend server is running at http://localhost:${port}`);
});
