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

export async function signInWithSession(session_string: string) {
  const res = await fetch(`${BASE}/auth/sign-in-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_string }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof err.detail === 'string' ? err.detail : '';
    throw parseError(detail, 'Failed to sign in with session');
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

export type RecipientResult = {
  recipient: string;
  status: 'sent' | 'failed';
  error: string | null;
};

export type JobStatus = {
  job_id: string;
  status: 'Processing' | 'Completed' | 'Failed';
  total: number;
  sent: number;
  failed: number;
  current: string | null;
  results: RecipientResult[];
  error: string | null;
};

export class JobNotFoundError extends Error {
  constructor() {
    super('Job not found');
    this.name = 'JobNotFoundError';
  }
}

export async function getJobStatus(job_id: string): Promise<JobStatus> {
  const res = await fetch(`${BASE}/job/${encodeURIComponent(job_id)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof err.detail === 'string' ? err.detail : '';
    if (res.status === 404 && detail === 'Job not found') {
      throw new JobNotFoundError();
    }
    throw parseError(detail, 'Failed to fetch job status');
  }
  return res.json() as Promise<JobStatus>;
}

export async function startQrLogin(): Promise<{ qr_id: string; qr_url: string }> {
  const res = await fetch(`${BASE}/auth/qr/start`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof err.detail === 'string' ? err.detail : '';
    throw parseError(detail, 'Failed to start QR login');
  }
  return res.json() as Promise<{ qr_id: string; qr_url: string }>;
}

export type QrStatus =
  | { status: 'pending' }
  | { status: 'password_required' }
  | { status: 'success'; session_string: string }
  | { status: 'expired' | 'error'; error?: string };

export async function getQrStatus(qr_id: string): Promise<QrStatus> {
  const res = await fetch(`${BASE}/auth/qr/${encodeURIComponent(qr_id)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = typeof err.detail === 'string' ? err.detail : '';
    throw parseError(detail, 'Failed to fetch QR login status');
  }
  return res.json() as Promise<QrStatus>;
}

export async function submitQrPassword(
  qr_id: string,
  password: string,
): Promise<void> {
  const res = await fetch(
    `${BASE}/auth/qr/${encodeURIComponent(qr_id)}/password`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    const detail = err.detail;
    if (detail && typeof detail === 'object') {
      const message = typeof detail.detail === 'string' ? detail.detail : '';
      const code = typeof detail.code === 'string' ? detail.code : undefined;
      throw new AuthError(message || 'Failed to submit QR password', code);
    }
    throw parseError(typeof detail === 'string' ? detail : '', 'Failed to submit QR password');
  }
}
