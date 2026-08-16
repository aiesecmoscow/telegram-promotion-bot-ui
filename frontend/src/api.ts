const BASE = '/api';

export class AuthError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

function parseError(message: string, fallback: string): Error {
  return new Error(message || fallback);
}

export async function sendCode(phone_number: string) {
  const res = await fetch(`${BASE}/auth/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof err.detail === 'string' ? err.detail : '';
    throw parseError(detail, 'Failed to send code');
  }
  return res.json() as Promise<{
    phone_number: string;
    phone_code_hash: string;
    session_string: string;
  }>;
}

export async function signIn(data: {
  session_string: string;
  phone_code_hash: string;
  phone_number: string;
  verification_code: string;
  password?: string;
}) {
  const res = await fetch(`${BASE}/auth/sign-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = err.detail;
    if (detail && typeof detail === 'object') {
      const message = typeof detail.detail === 'string' ? detail.detail : '';
      const code = typeof detail.code === 'string' ? detail.code : undefined;
      throw new AuthError(message || 'Failed to sign in', code);
    }
    throw parseError(typeof detail === 'string' ? detail : '', 'Failed to sign in');
  }
  return res.json() as Promise<{ session_string: string }>;
}

export async function createJob(data: {
  session_string: string;
  usernames: string[];
  message: string;
}) {
  const res = await fetch(`${BASE}/job`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof err.detail === 'string' ? err.detail : '';
    throw parseError(detail, 'Failed to create job');
  }
  return res.json() as Promise<{ job_id: string; status: string }>;
}
