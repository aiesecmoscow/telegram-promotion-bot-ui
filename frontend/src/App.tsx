import { useState, useEffect } from 'react';
import {
  Container,
  TextField,
  Button,
  Typography,
  Alert,
  Paper,
  Stack,
  CircularProgress,
} from '@mui/material';
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
    <Container maxWidth="sm" sx={{ mt: 8 }}>
      <Paper elevation={3} sx={{ p: 4 }}>
        <Typography variant="h5" gutterBottom align="center">
          Telegram Promotion Bot
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {page === 'login' && (
          <Stack spacing={2}>
            <TextField
              label="Phone number"
              placeholder="+1234567890"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              fullWidth
            />
            <Button
              variant="contained"
              onClick={handleSendCode}
              disabled={loading || !phone.trim()}
              fullWidth
            >
              {loading ? <CircularProgress size={24} /> : 'Continue'}
            </Button>
          </Stack>
        )}

        {page === 'verify' && (
          <Stack spacing={2}>
            <TextField
              label="Verification code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              fullWidth
            />
            <TextField
              label="2FA Password (optional)"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              fullWidth
            />
            <Button
              variant="contained"
              onClick={handleSignIn}
              disabled={loading || !code.trim()}
              fullWidth
            >
              {loading ? <CircularProgress size={24} /> : 'Login'}
            </Button>
          </Stack>
        )}

        {page === 'main' && (
          <Stack spacing={2}>
            <TextField
              label="Usernames (one per line)"
              multiline
              minRows={4}
              value={usernames}
              onChange={(e) => setUsernames(e.target.value)}
              placeholder={'username1\nusername2\nusername3'}
              fullWidth
            />
            <TextField
              label="Message"
              multiline
              minRows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              fullWidth
            />
            <Button
              variant="contained"
              color="primary"
              onClick={handleStart}
              disabled={loading}
              fullWidth
            >
              {loading ? <CircularProgress size={24} /> : 'Start'}
            </Button>
            {jobStatus && (
              <Alert severity="success">{jobStatus}</Alert>
            )}
            <Button
              variant="text"
              color="secondary"
              onClick={handleLogout}
              size="small"
            >
              Logout
            </Button>
          </Stack>
        )}
      </Paper>
    </Container>
  );
}

export default App;
