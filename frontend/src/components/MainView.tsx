import { useState, useEffect } from 'react';
import { createJob } from '../api';

type MainViewProps = {
  session: string;
  loading: boolean;
  setLoading: (v: boolean) => void;
  error: string;
  setError: (v: string) => void;
  onLogout: () => void;
};

export default function MainView({
  session,
  loading,
  setLoading,
  setError,
  onLogout,
}: MainViewProps) {
  const [usernames, setUsernames] = useState('');
  const [message, setMessage] = useState('');
  const [jobStatus, setJobStatus] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    if (copyState === 'idle') return;
    const t = setTimeout(() => setCopyState('idle'), 1500);
    return () => clearTimeout(t);
  }, [copyState]);

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

  const handleCopySession = async () => {
    if (!session) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(session);
      } else {
        const ta = document.createElement('textarea');
        ta.value = session;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('execCommand copy failed');
      }
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
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
        onClick={handleCopySession}
        disabled={loading || !session}
        aria-live="polite"
      >
        {copyState === 'copied'
          ? 'Copied!'
          : copyState === 'failed'
            ? 'Copy failed'
            : 'Copy session'}
      </button>
      <button
        className="btn btn-ghost btn-sm self-center"
        onClick={onLogout}
      >
        Logout
      </button>
    </div>
  );
}
