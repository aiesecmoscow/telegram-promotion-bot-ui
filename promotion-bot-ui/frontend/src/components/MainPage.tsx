import { useState } from 'react';
import './MainPage.css';

const API_URL = '/api';

interface MainPageProps {
  onLogout: () => void;
}

interface Status {
  message: string;
  type: 'success' | 'error' | 'info';
}

function MainPage({ onLogout }: MainPageProps) {
  const [usernames, setUsernames] = useState('');
  const [message, setMessage] = useState('');
  const [cooldown, setCooldown] = useState('10');
  const [isSending, setIsSending] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);

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

    setIsSending(true);
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

      setStatus({
        message: `✓ Task started for ${data.totalUsers} users. Check the backend console for real-time progress.`,
        type: 'success',
      });
    } catch (err: any) {
      setStatus({ message: `✗ Error: ${err.message}`, type: 'error' });
    } finally {
      setIsSending(false);
    }
  };

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
                Enter Telegram usernames, one per line (with or without @)
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

            <button type="submit" disabled={isSending} className="send-btn">
              {isSending ? 'Sending...' : 'Start Sending'}
            </button>

            {status && (
              <div className={`status-message status-${status.type}`}>
                {status.message}
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

export default MainPage;
