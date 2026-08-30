import { useState, useEffect, useRef } from 'react';
import {
  createJob,
  getJobStatus,
  JobNotFoundError,
  type JobStatus,
} from '../api';

type MainViewProps = {
  session: string;
  loading: boolean;
  setLoading: (v: boolean) => void;
  error: string;
  setError: (v: string) => void;
  onLogout: () => void;
};

const ACTIVE_JOB_KEY = 'tg_active_job_id';
const POLL_INTERVAL_MS = 2000;

export default function MainView({
  session,
  loading,
  setLoading,
  setError,
  onLogout,
}: MainViewProps) {
  const [usernames, setUsernames] = useState('');
  const [message, setMessage] = useState('');
  const [activeJobId, setActiveJobId] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_JOB_KEY),
  );
  const [job, setJob] = useState<JobStatus | null>(null);
  const [pollError, setPollError] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const isStartingRef = useRef(false);

  const clearActiveJob = () => {
    localStorage.removeItem(ACTIVE_JOB_KEY);
    setActiveJobId(null);
    setJob(null);
  };

  useEffect(() => {
    if (!activeJobId) {
      setJob(null);
      return;
    }
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const status = await getJobStatus(activeJobId);
        if (cancelled) return;
        setJob(status);
        setPollError('');
        if (status.status !== 'Processing') {
          return true;
        }
        return false;
      } catch (e: unknown) {
        if (cancelled) return;
        if (e instanceof JobNotFoundError) {
          setPollError('Job lost on server (server restart?). Local lock cleared.');
          clearActiveJob();
          return true;
        }
        setPollError(
          e instanceof Error ? e.message : 'Failed to fetch job status',
        );
        return false;
      }
    };

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const stop = () => {
      stopped = true;
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    void (async () => {
      const done = await fetchOnce();
      if (stopped || done || cancelled) return;
      intervalId = setInterval(async () => {
        const finished = await fetchOnce();
        if (finished && intervalId !== null) {
          clearInterval(intervalId);
          intervalId = null;
        }
      }, POLL_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [activeJobId]);

  useEffect(() => {
    if (copyState === 'idle') return;
    const t = setTimeout(() => setCopyState('idle'), 1500);
    return () => clearTimeout(t);
  }, [copyState]);

  const handleStart = async () => {
    setError('');
    setPollError('');
    if (activeJobId && job?.status === 'Processing') {
      setError('A job is already running. Wait or force-reset it.');
      return;
    }
    if (activeJobId && !isStartingRef.current) {
      clearActiveJob();
    }
    if (isStartingRef.current) return;
    isStartingRef.current = true;
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
      localStorage.setItem(ACTIVE_JOB_KEY, res.job_id);
      setActiveJobId(res.job_id);
      setJob(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
      isStartingRef.current = false;
    }
  };

  const handleForceReset = () => {
    const ok = window.confirm(
      'Force reset the local lock? The server-side job may still be running — this only unlocks the UI on this client.',
    );
    if (!ok) return;
    clearActiveJob();
    setPollError('');
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

  const isLocked = !!activeJobId && job?.status === 'Processing';
  const showResults = !!activeJobId;

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
        disabled={loading || isLocked}
      >
        {loading ? (
          <span className="loading loading-spinner loading-md"></span>
        ) : isLocked ? (
          'Locked — job in progress'
        ) : (
          'Start'
        )}
      </button>
      {isLocked && (
        <div role="alert" className="alert alert-warning">
          <span>
            A job is currently running. Wait for it to finish, or force-reset
            below.
          </span>
        </div>
      )}

      {showResults && job && (
        <div className="flex flex-col gap-2 border border-base-300 rounded-box p-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="font-semibold">Job results</div>
            <span
              className={`badge ${
                job.status === 'Completed'
                  ? 'badge-success'
                  : job.status === 'Failed'
                    ? 'badge-error'
                    : 'badge-info'
              }`}
            >
              {job.status}
            </span>
          </div>
          <div className="text-sm opacity-80">
            sent {job.sent} / {job.total} · failed {job.failed}
            {job.status === 'Processing' && job.current
              ? ` · current: ${job.current}`
              : ''}
          </div>
          {job.error && (
            <div className="text-sm text-error">job error: {job.error}</div>
          )}
          {job.results.length > 0 && (
            <ul className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {job.results.map((r) => (
                <li
                  key={`${r.recipient}-${job.results.indexOf(r)}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <span
                    className={`badge ${
                      r.status === 'sent' ? 'badge-success' : 'badge-error'
                    }`}
                  >
                    {r.status === 'sent' ? '✓' : '✗'}
                  </span>
                  <span className="font-mono">{r.recipient}</span>
                  {r.error && (
                    <span className="opacity-70">— {r.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <button
            className="btn btn-ghost btn-sm self-end"
            onClick={handleForceReset}
            disabled={loading}
          >
            Force reset
          </button>
        </div>
      )}

      {showResults && !job && !pollError && (
        <div className="flex items-center gap-2 text-sm opacity-80">
          <span className="loading loading-spinner loading-xs"></span>
          Loading job status…
        </div>
      )}

      {pollError && (
        <div role="alert" className="alert alert-warning">
          <span>{pollError}</span>
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
