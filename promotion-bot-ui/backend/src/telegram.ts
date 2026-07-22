import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';

// Храним клиент и сессию в памяти
let client: TelegramClient | null = null;
let session = new StringSession('');

// Коллбэки для получения данных аутентификации
let phoneCodeCallback: ((code: string) => void) | null = null;
let passwordCallback: ((password: string) => void) | null = null;

export async function initClient(apiId: number, apiHash: string, sessionString?: string) {
    if (sessionString) {
        session = new StringSession(sessionString);
    }

    client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
    });

    return client;
}

export async function startAuth(phoneNumber: string): Promise<{ phoneCodeHash: string }> {
    if (!client) {
        throw new Error('Client not initialized. Call initClient first.');
    }

    await client.connect();

    const result = await client.invoke(
        new Api.auth.SendCode({
            phoneNumber: phoneNumber,
            apiId: client.apiId,
            apiHash: client.apiHash,
            settings: new Api.CodeSettings({}),
        })
    );

    // result может быть разных типов, проверяем наличие phoneCodeHash
    if ('phoneCodeHash' in result) {
        return {
            phoneCodeHash: result.phoneCodeHash,
        };
    }

    throw new Error('Unexpected response from Telegram');
}

export async function signIn(
    phoneNumber: string,
    phoneCodeHash: string,
    phoneCode: string
): Promise<{ success: boolean; needPassword?: boolean; session?: string }> {
    if (!client) {
        throw new Error('Client not initialized');
    }

    try {
        await client.invoke(
            new Api.auth.SignIn({
                phoneNumber,
                phoneCodeHash,
                phoneCode,
            })
        );

        return {
            success: true,
            session: (client.session as StringSession).save(),
        };
    } catch (error: any) {
        if (error.errorMessage === 'SESSION_PASSWORD_NEEDED') {
            return {
                success: false,
                needPassword: true,
            };
        }
        throw error;
    }
}

export async function checkPassword(password: string): Promise<{ success: boolean; session?: string }> {
    if (!client) {
        throw new Error('Client not initialized');
    }

    const passwordSrpResult = await client.invoke(
        new Api.account.GetPassword()
    );

    const { computeCheck } = require('telegram/Password');
    const passwordSrpCheck = await computeCheck(passwordSrpResult, password);

    await client.invoke(
        new Api.auth.CheckPassword({
            password: passwordSrpCheck,
        })
    );

    return {
        success: true,
        session: (client.session as StringSession).save(),
    };
}

export async function sendMessage(username: string, message: string): Promise<void> {
    if (!client) {
        throw new Error('Client not initialized');
    }

    await client.sendMessage(username, { message });
}

export function getClient(): TelegramClient | null {
    return client;
}

export function getSessionString(): string {
    if (!client) {
        return '';
    }
    return (client.session as StringSession).save();
}
