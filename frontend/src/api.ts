const BASE = '/api';

export async function sendCode(phone_number: string) {
  const res = await fetch(`${BASE}/auth/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || 'Failed to send code');
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
    throw new Error(err.detail || 'Failed to sign in');
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
    throw new Error(err.detail || 'Failed to create job');
  }
  return res.json() as Promise<{ job_id: string; status: string }>;
}
