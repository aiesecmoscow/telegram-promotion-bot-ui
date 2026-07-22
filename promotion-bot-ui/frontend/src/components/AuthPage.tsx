import { useState } from 'react';
import './AuthPage.css';

const API_URL = '/api';

interface AuthPageProps {
  onAuthSuccess: (session: string) => void;
}

function AuthPage({ onAuthSuccess }: AuthPageProps) {
  const [step, setStep] = useState<'credentials' | 'phone' | 'code' | 'password'>('credentials');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleInitClient = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiId: Number(apiId), apiHash }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to initialize client');
      }

      setStep('phone');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/auth/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to send code');
      }

      setPhoneCodeHash(data.phoneCodeHash);
      setStep('code');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber, phoneCodeHash, phoneCode: code }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to verify code');
      }

      if (data.needPassword) {
        setStep('password');
      } else if (data.success && data.session) {
        onAuthSuccess(data.session);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to verify password');
      }

      if (data.success && data.session) {
        onAuthSuccess(data.session);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-container">
        <h1>Telegram Promotion Bot</h1>
        <p className="subtitle">Authenticate your Telegram account</p>

        {error && <div className="error-message">{error}</div>}

        {step === 'credentials' && (
          <form onSubmit={handleInitClient}>
            <div className="form-group">
              <label htmlFor="apiId">API ID</label>
              <input
                id="apiId"
                type="text"
                value={apiId}
                onChange={(e) => setApiId(e.target.value)}
                placeholder="Enter your API ID"
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="apiHash">API Hash</label>
              <input
                id="apiHash"
                type="text"
                value={apiHash}
                onChange={(e) => setApiHash(e.target.value)}
                placeholder="Enter your API Hash"
                required
              />
            </div>
            <button type="submit" disabled={loading}>
              {loading ? 'Initializing...' : 'Next'}
            </button>
            <p className="help-text">
              Get your API credentials at{' '}
              <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer">
                my.telegram.org
              </a>
            </p>
          </form>
        )}

        {step === 'phone' && (
          <form onSubmit={handleSendCode}>
            <div className="form-group">
              <label htmlFor="phoneNumber">Phone Number</label>
              <input
                id="phoneNumber"
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+1234567890"
                required
              />
            </div>
            <button type="submit" disabled={loading}>
              {loading ? 'Sending code...' : 'Send Code'}
            </button>
          </form>
        )}

        {step === 'code' && (
          <form onSubmit={handleVerifyCode}>
            <div className="form-group">
              <label htmlFor="code">Verification Code</label>
              <input
                id="code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Enter the code from Telegram"
                required
              />
            </div>
            <button type="submit" disabled={loading}>
              {loading ? 'Verifying...' : 'Verify'}
            </button>
          </form>
        )}

        {step === 'password' && (
          <form onSubmit={handleVerifyPassword}>
            <div className="form-group">
              <label htmlFor="password">2FA Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your 2FA password"
                required
              />
            </div>
            <button type="submit" disabled={loading}>
              {loading ? 'Verifying...' : 'Verify'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default AuthPage;
