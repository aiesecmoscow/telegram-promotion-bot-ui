import { useState, useEffect } from 'react';
import './MainPage.css';

const API_URL = '/api';

interface MainPageProps {
  onLogout: () => void;
}

interface Status {
  message: string;
  type: 'success' | 'error' | 'info';
}

interface RecipientResult {
  username: string;
  status: 'sent' | 'failed' | 'skipped';
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

const COLLAPSE_THRESHOLD = 10;

function MainPage({ onLogout }: MainPageProps) {
  const [usernames, setUsernames] = useState('');
  const [message, setMessage] = useState('');
  const [cooldown, setCooldown] = useState('10');
  const [status, setStatus] = useState<Status | null>(null);

  const [activeJobId, setActiveJobId] = useState<string | null>(
    () => localStorage.getItem('last_job_id')
  );
  const [job, setJob] = useState<Job | null>(null);

  // Polling effect: refetch the current job on a 2s cadence while Processing,
  // 10s cadence after Completed/Failed. Stops when activeJobId is cleared.
  useEffect(() => {
    if (!activeJobId) {
      setJob(null);
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;
    let currentDelay = 2000;

    const tick = async () => {
      try {
        const res = await fetch(`${API_URL}/job/${activeJobId}`);
        if (cancelled) return;

        if (res.status === 404) {
          setActiveJobId(null);
          localStorage.removeItem('last_job_id');
          if (intervalId !== null) {
            clearInterval(intervalId);
            intervalId = null;
          }
          return;
        }
        if (!res.ok) {
          console.error('Failed to fetch job:', res.status);
          return;
        }

        const data = (await res.json()) as Job;
        if (cancelled) return;
        setJob(data);

        const nextDelay = data.status === 'Processing' ? 2000 : 10000;
        if (nextDelay !== currentDelay) {
          currentDelay = nextDelay;
          if (intervalId !== null) {
            clearInterval(intervalId);
            intervalId = window.setInterval(tick, currentDelay);
          }
        }
      } catch (err) {
        console.error('Polling error:', err);
      }
    };

    tick();
    intervalId = window.setInterval(tick, currentDelay);

    return () => {
      cancelled = true;
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [activeJobId]);

  const isProcessing = job?.status === 'Processing';

  const handleSendMessages = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus(null);

    if (!usernames.trim() || !message.trim()) {
      setStatus({ message: 'Please fill in all fields', type: 'error' });
      return;
    }

    const usernameList = usernames
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (usernameList.length === 0) {
      setStatus({ message: 'No valid usernames provided', type: 'error' });
      return;
    }

    setStatus({
      message: `Starting message sending to ${usernameList.length} users...`,
      type: 'info',
    });

    try {
      const response = await fetch(`${API_URL}/send-messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usernames: usernameList,
          message,
          cooldownSeconds: Number(cooldown),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to send messages');
      }

      const newJobId = data.jobId as string | undefined;
      if (newJobId) {
        setActiveJobId(newJobId);
        localStorage.setItem('last_job_id', newJobId);
        setStatus({
          message: `Task started for ${data.totalUsers} users.`,
          type: 'success',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setStatus({ message: `✗ Error: ${msg}`, type: 'error' });
    }
  };

  const handleClearResults = () => {
    setActiveJobId(null);
    setJob(null);
    localStorage.removeItem('last_job_id');
  };

  const handleCopyList = async (
    items: RecipientResult[],
    withError: boolean
  ) => {
    const text = items
      .map((r) => (withError ? `${r.username}\t${r.error ?? ''}` : r.username))
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setStatus({
        message: `Copied ${items.length} entries to clipboard`,
        type: 'success',
      });
    } catch {
      setStatus({ message: 'Failed to copy to clipboard', type: 'error' });
    }
  };

  const sent = job?.results.filter((r) => r.status === 'sent') ?? [];
  const failed = job?.results.filter((r) => r.status === 'failed') ?? [];
  const skipped = job?.results.filter((r) => r.status === 'skipped') ?? [];

  const submitLabel = isProcessing
    ? `Sending… (${job?.sent ?? 0}/${job?.total ?? 0})`
    : 'Start Sending';

  return (
    <div className="main-page">
      <header className="header">
        <h1>Telegram Promotion Bot</h1>
        <button onClick={onLogout} className="logout-btn">
          Logout
        </button>
      </header>

      <div className="main-content">
        <div className="panel">
          <form onSubmit={handleSendMessages}>
            <h2>Send Messages</h2>
            <div className="form-group">
              <label htmlFor="usernames">
                Usernames (one per line)
                <span className="required">*</span>
              </label>
              <textarea
                id="usernames"
                value={usernames}
                onChange={(e) => setUsernames(e.target.value)}
                placeholder={'@username1\n@username2\n@username3'}
                rows={10}
                required
              />
              <small className="help-text">
                Enter Telegram usernames, one per line (with or without @).
                Keep lists reasonable (≤500 per send).
              </small>
            </div>

            <div className="form-group">
              <label htmlFor="message">
                Message
                <span className="required">*</span>
              </label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Enter the message to send..."
                rows={6}
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="cooldown">
                Cooldown (seconds)
                <span className="required">*</span>
              </label>
              <input
                id="cooldown"
                type="number"
                value={cooldown}
                onChange={(e) => setCooldown(e.target.value)}
                min="1"
                max="300"
                required
              />
              <small className="help-text">
                Delay between messages to avoid rate limits (recommended: 10-30 seconds)
              </small>
            </div>

            <button
              type="submit"
              disabled={isProcessing}
              className="send-btn"
            >
              {submitLabel}
            </button>

            {status && (
              <div className={`status-message status-${status.type}`}>
                {status.message}
              </div>
            )}
          </form>
        </div>

        {job && (
          <ResultsBlock
            job={job}
            sent={sent}
            failed={failed}
            skipped={skipped}
            onClear={handleClearResults}
            onCopyList={handleCopyList}
          />
        )}
      </div>
    </div>
  );
}

interface ResultsBlockProps {
  job: Job;
  sent: RecipientResult[];
  failed: RecipientResult[];
  skipped: RecipientResult[];
  onClear: () => void;
  onCopyList: (items: RecipientResult[], withError: boolean) => void;
}

function ResultsBlock({
  job,
  sent,
  failed,
  skipped,
  onClear,
  onCopyList,
}: ResultsBlockProps) {
  return (
    <div className="panel results-panel">
      <div className="results-header">
        <h2>Results</h2>
        <button onClick={onClear} className="clear-btn">
          Clear results
        </button>
      </div>

      <div className="results-meta">
        <span className={`status-pill status-${job.status.toLowerCase()}`}>
          {job.status}
        </span>
        <span>
          Processed: {job.processed}/{job.total}
        </span>
        <span>Sent: {job.sent}</span>
        <span>Failed: {job.failed}</span>
        {skipped.length > 0 && <span>Skipped: {skipped.length}</span>}
      </div>

      {job.status === 'Processing' && job.processed < job.total && (
        <ProgressBar job={job} />
      )}

      {job.currentUsername && job.status === 'Processing' && (
        <div className="current-target">
          Sending now to: <strong>{job.currentUsername}</strong>
        </div>
      )}

      {job.errorMessage && (
        <div className="error-banner">
          Job failed: <strong>{job.errorMessage}</strong>
        </div>
      )}

      {job.status !== 'Processing' && (
        <div className="results-summary">
          Sent: <strong>{job.sent}</strong>, Failed:{' '}
          <strong>{job.failed}</strong>
          {skipped.length > 0 && (
            <>
              , Skipped: <strong>{skipped.length}</strong>
            </>
          )}
        </div>
      )}

      {failed.length > 0 && (
        <CollapsibleList
          title={`Failed (${failed.length})`}
          items={failed}
          withError
          onCopy={() => onCopyList(failed, true)}
          copyLabel="Copy failed list"
        />
      )}

      {sent.length > 0 && (
        <CollapsibleList
          title={`Sent (${sent.length})`}
          items={sent}
          withError={false}
          onCopy={() => onCopyList(sent, false)}
          copyLabel="Copy sent list"
        />
      )}

      {skipped.length > 0 && (
        <CollapsibleList
          title={`Skipped (${skipped.length})`}
          items={skipped}
          withError
          onCopy={() => onCopyList(skipped, true)}
          copyLabel="Copy skipped list"
        />
      )}
    </div>
  );
}

interface ProgressBarProps {
  job: Job;
}

function ProgressBar({ job }: ProgressBarProps) {
  const total = Math.max(job.total, 1);
  const sentPct = (job.sent / total) * 100;
  const failedPct = (job.failed / total) * 100;
  return (
    <div className="progress">
      <div
        className="progress-segment progress-sent"
        style={{ width: `${sentPct}%` }}
      />
      <div
        className="progress-segment progress-failed"
        style={{ width: `${failedPct}%` }}
      />
    </div>
  );
}

interface CollapsibleListProps {
  title: string;
  items: RecipientResult[];
  withError: boolean;
  onCopy: () => void;
  copyLabel: string;
}

function CollapsibleList({
  title,
  items,
  withError,
  onCopy,
  copyLabel,
}: CollapsibleListProps) {
  const defaultOpen = items.length <= COLLAPSE_THRESHOLD;
  return (
    <details className="results-section" open={defaultOpen}>
      <summary>
        {title}
        <button
          type="button"
          className="copy-btn"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCopy();
          }}
        >
          {copyLabel}
        </button>
      </summary>
      <ul className="results-list">
        {items.map((r, idx) => (
          <li
            key={`${r.username}-${idx}`}
            className={`result-item result-${r.status}`}
          >
            <span className="result-username">{r.username}</span>
            {withError && r.error && (
              <span className="result-error"> — {r.error}</span>
            )}
            {r.attempts > 1 && (
              <span className="result-attempts"> (attempts: {r.attempts})</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export default MainPage;