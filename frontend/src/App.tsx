import { useState, useEffect } from 'react';
import { ChevronLeftIcon } from '@heroicons/react/24/outline';
import { sendCode, signIn, createJob } from './api';

type Page = 'login' | 'verify' | 'main';

function App() {
  const [page, setPage] = useState<Page>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Login
  const [phone, setPhone] = useState('');

  // Verify
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [tempSession, setTempSession] = useState('');

  // Main
  const [session, setSession] = useState('');
  const [usernames, setUsernames] = useState('');
  const [message, setMessage] = useState('');
  const [jobStatus, setJobStatus] = useState('');

  // Restore session from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('tg_session');
    if (saved) {
      setSession(saved);
      setPage('main');
    }
  }, []);

  const handleSendCode = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await sendCode(phone);
      setTempSession(res.session_string);
      setPhoneCodeHash(res.phone_code_hash);
      setPage('verify');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleSignIn = async () => {
    setError('');
    if (!tempSession || !phoneCodeHash) {
      setError('Session expired. Please go back and request a new code.');
      return;
    }
    setLoading(true);
    try {
      const res = await signIn({
        session_string: tempSession,
        phone_code_hash: phoneCodeHash,
        phone_number: phone,
        verification_code: code,
        password: password || undefined,
      });
      localStorage.setItem('tg_session', res.session_string);
      setSession(res.session_string);
      setPage('main');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleBackToLogin = () => {
    setError('');
    setCode('');
    setPassword('');
    setTempSession('');
    setPhoneCodeHash('');
    setPage('login');
  };

  const handleStart = async () => {
    setError('');
    setJobStatus('');
    setLoading(true);
    try {
      const list = usernames
        .split('\n')
        .map((u) => u.trim())
        .filter(Boolean);
      if (list.length === 0) {
        setError('Please enter at least one username');
        return;
      }
      if (!message.trim()) {
        setError('Please enter a message');
        return;
      }
      const res = await createJob({
        session_string: session,
        usernames: list,
        message: message.trim(),
      });
      setJobStatus(`Job created! ID: ${res.job_id} — Status: ${res.status}`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('tg_session');
    setSession('');
    setPhone('');
    setCode('');
    setPassword('');
    setTempSession('');
    setPhoneCodeHash('');
    setUsernames('');
    setMessage('');
    setJobStatus('');
    setError('');
    setPage('login');
  };

  return (
    <div className="mx-auto max-w-sm mt-16 px-4">
      <div className="card bg-base-100 shadow-xl p-8">
        <h1 className="text-2xl font-bold text-center mb-6">
          Telegram Promotion Bot
        </h1>

        {error && (
          <div role="alert" className="alert alert-error mb-4">
            <span>{error}</span>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setError('')}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        )}

        {page === 'login' && (
          <div className="flex flex-col gap-4">
            <label className="form-control w-full">
              <div className="label">
                <span className="label-text">Phone number</span>
              </div>
              <input
                className="input input-bordered w-full"
                placeholder="+1234567890"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
            <button
              className="btn btn-primary w-full"
              onClick={handleSendCode}
              disabled={loading || !phone.trim()}
            >
              {loading ? (
                <span className="loading loading-spinner loading-md"></span>
              ) : (
                'Continue'
              )}
            </button>
          </div>
        )}

        {page === 'verify' && (
          <div className="flex flex-col gap-4">
            <button
              type="button"
              className="btn btn-ghost btn-sm self-start -mt-2 -ml-2"
              onClick={handleBackToLogin}
              disabled={loading}
              aria-label="Back to phone number"
            >
              <ChevronLeftIcon className="h-5 w-5" aria-hidden="true" />
              Back
            </button>
            <p className="text-sm text-base-content/70 text-center -mt-4 mb-2">
              Code sent to
              <br />
              <span className="font-medium text-base-content">{phone}</span>
            </p>
            <label className="form-control w-full">
              <div className="label">
                <span className="label-text">Verification code</span>
              </div>
              <input
                className="input input-bordered w-full"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
            <label className="form-control w-full">
              <div className="label">
                <span className="label-text">2FA Password (optional)</span>
              </div>
              <input
                type="password"
                className="input input-bordered w-full"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <button
              className="btn btn-primary w-full"
              onClick={handleSignIn}
              disabled={
                loading ||
                !code.trim() ||
                !tempSession ||
                !phoneCodeHash
              }
            >
              {loading ? (
                <span className="loading loading-spinner loading-md"></span>
              ) : (
                'Login'
              )}
            </button>
          </div>
        )}

        {page === 'main' && (
          <div className="flex flex-col gap-4">
            <label className="form-control w-full">
              <div className="label">
                <span className="label-text">Usernames (one per line)</span>
              </div>
              <textarea
                className="textarea textarea-bordered w-full"
                rows={4}
                placeholder={'username1\nusername2\nusername3'}
                value={usernames}
                onChange={(e) => setUsernames(e.target.value)}
              />
            </label>
            <label className="form-control w-full">
              <div className="label">
                <span className="label-text">Message</span>
              </div>
              <textarea
                className="textarea textarea-bordered w-full"
                rows={4}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <button
              className="btn btn-primary w-full"
              onClick={handleStart}
              disabled={loading}
            >
              {loading ? (
                <span className="loading loading-spinner loading-md"></span>
              ) : (
                'Start'
              )}
            </button>
            {jobStatus && (
              <div role="alert" className="alert alert-success">
                {jobStatus}
              </div>
            )}
            <button
              className="btn btn-ghost btn-sm self-center"
              onClick={handleLogout}
            >
              Logout
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;