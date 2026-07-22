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

        // Отправляем сообщение о начале рассылки
        res.json({
            success: true,
            message: 'Messages sending started',
            totalUsers: usernames.length
        });

        // Запускаем рассылку асинхронно
        sendMessagesAsync(usernames, message, cooldownSeconds || 10);
    } catch (error: any) {
        console.error('Error sending messages:', error);
        res.status(500).json({ error: error.message });
    }
});

// Функция для асинхронной отправки сообщений
async function sendMessagesAsync(usernames: string[], message: string, cooldownSeconds: number) {
    for (let i = 0; i < usernames.length; i++) {
        const username = usernames[i];

        if (!username) {
            console.error(`⚠️ Skipping empty username at index ${i}`);
            continue;
        }

        try {
            console.log(`[${i + 1}/${usernames.length}] Sending message to ${username}...`);
            await telegram.sendMessage(username, message);
            console.log(`✓ Message sent to ${username}`);

            // Ждем указанное время перед отправкой следующего сообщения (кроме последнего)
            if (i < usernames.length - 1) {
                console.log(`Waiting ${cooldownSeconds} seconds before next message...`);
                await sleep(cooldownSeconds * 1000);
            }
        } catch (error: any) {
            console.error(`✗ Error sending message to ${username}:`, error.message);

            // Проверяем на бан или ограничения
            if (error.message.includes('FLOOD') || error.message.includes('SLOWMODE')) {
                console.error('⚠️ RATE LIMIT detected. You may be sending messages too fast.');
            } else if (error.message.includes('USER_BANNED')) {
                console.error('⚠️ ACCOUNT BANNED. Cannot send messages.');
                break; // Прекращаем рассылку при бане
            } else if (error.message.includes('AUTH_KEY')) {
                console.error('⚠️ SESSION EXPIRED. Please re-authenticate.');
                break;
            }
        }
    }

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
