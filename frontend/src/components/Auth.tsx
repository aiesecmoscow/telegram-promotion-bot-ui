import { useState, useEffect } from 'react';
import {
  ChevronLeftIcon,
  EyeIcon,
  EyeSlashIcon,
} from '@heroicons/react/24/outline';
import { QRCodeSVG } from 'qrcode.react';
import {
  sendCode,
  signIn,
  signInWithSession,
  startQrLogin,
  getQrStatus,
  submitQrPassword,
  AuthError,
} from '../api';

type AuthProps = {
  loading: boolean;
  setLoading: (v: boolean) => void;
  error: string;
  setError: (v: string) => void;
  onAuthenticated: (sessionString: string) => void;
};

type AuthPage = 'login' | 'verify' | 'password' | 'qr';

export default function Auth({
  loading,
  setLoading,
  setError,
  onAuthenticated,
}: AuthProps) {
  const [page, setPage] = useState<AuthPage>('login');
  const [loginMode, setLoginMode] = useState<'phone' | 'session'>('phone');
  const [phone, setPhone] = useState('');
  const [sessionInput, setSessionInput] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [phoneCodeHash, setPhoneCodeHash] = useState('');
  const [tempSession, setTempSession] = useState('');
  const [qrId, setQrId] = useState('');
  const [qrUrl, setQrUrl] = useState('');
  const [qrStatus, setQrStatus] = useState<
    'pending' | 'password_required' | 'expired' | 'error' | null
  >(null);
  const [qrPassword, setQrPassword] = useState('');

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
      });
      setLoading(false);
      onAuthenticated(res.session_string);
    } catch (e: unknown) {
      if (e instanceof AuthError && e.code === 'password_required') {
        setPage('password');
      } else {
        setError(e instanceof Error ? e.message : 'Unknown error');
      }
      setLoading(false);
    }
  };

  const handleSubmitPassword = async () => {
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
        password,
      });
      setLoading(false);
      setPassword('');
      onAuthenticated(res.session_string);
    } catch (e: unknown) {
      if (e instanceof AuthError && e.code === 'invalid_password') {
        setError('Invalid password. Please try again.');
      } else {
        setError(e instanceof Error ? e.message : 'Unknown error');
      }
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

  const handleBackToPhoneLogin = () => {
    setError('');
    setSessionInput('');
    setLoginMode('phone');
  };

  const handleSignInWithSession = async () => {
    setError('');
    const trimmed = sessionInput.trim();
    if (trimmed.length === 0) {
      setError('Please paste a session string');
      return;
    }
    setLoading(true);
    try {
      const res = await signInWithSession(trimmed);
      setLoading(false);
      setSessionInput('');
      setLoginMode('phone');
      onAuthenticated(res.session_string);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setLoading(false);
    }
  };

  const handleStartQr = async () => {
    setError('');
    setLoading(true);
    setPage('qr');
    try {
      const res = await startQrLogin();
      setQrId(res.qr_id);
      setQrUrl(res.qr_url);
      setQrStatus('pending');
      setLoading(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error');
      setLoading(false);
      setPage('login');
    }
  };

  const handleBackToPhoneFromQr = () => {
    setError('');
    setQrId('');
    setQrUrl('');
    setQrStatus(null);
    setQrPassword('');
    setPage('login');
  };

  const handleSubmitQrPassword = async () => {
    if (!qrId || !qrPassword.trim()) return;
    setError('');
    setLoading(true);
    try {
      await submitQrPassword(qrId, qrPassword);
      setQrPassword('');
      setLoading(false);
    } catch (e: unknown) {
      if (e instanceof AuthError && e.code === 'invalid_password') {
        setError('Invalid password. Please try again.');
      } else {
        setError(e instanceof Error ? e.message : 'Unknown error');
      }
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!qrId) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const status = await getQrStatus(qrId);
        if (cancelled) return;
        if (status.status === 'success') {
          setQrId('');
          setQrUrl('');
          setQrStatus(null);
          setQrPassword('');
          setPage('login');
          onAuthenticated(status.session_string);
          return;
        }
        if (status.status === 'password_required') {
          setQrStatus('password_required');
        }
        if (status.status === 'expired' || status.status === 'error') {
          setQrStatus(status.status);
          setError(
            status.status === 'expired'
              ? 'QR code expired. Click "Refresh QR" to generate a new one.'
              : status.error ?? 'QR login failed. Please try again.',
          );
        }
      } catch {
        // Transient polling errors are ignored; next tick will retry.
      }
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [qrId, onAuthenticated]);

  return (
    <>
      {page === 'login' && loginMode === 'phone' && (
        <div className="flex flex-col gap-4">
          <div className="collapse collapse-arrow bg-base-200">
            <input type="checkbox" aria-label="Show bot info" />
            <div className="collapse-title text-sm font-medium">
              Информация о боте
            </div>
            <div className="collapse-content text-sm leading-relaxed">
              <p>
                Этот бот работает как приложение Telegram, позволяя вам
                отписывать несколько людей за раз. Рекомендуется не делать
                более 15-20 отписок в день
              </p>
              <p className="mt-2">
                Логинившись в него, ваш аккаунт используется для отписки
                полностью под вашим контролем. Данные для входа в аккаунт
                остаются только в вашем браузере и не сохраняются на сервере
              </p>
              <p className="mt-2">
                Вы можете выйти из своего аккаунта в любой момент
              </p>
            </div>
          </div>
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
          <div className="divider text-xs">or</div>
          <button
            type="button"
            className="btn btn-primary w-full"
            onClick={handleStartQr}
            disabled={loading}
          >
            Sign in with QR
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm self-center"
            onClick={() => {
              setError('');
              setLoginMode('session');
            }}
            disabled={loading}
          >
            Sign in with session string
          </button>
        </div>
      )}

      {page === 'login' && loginMode === 'session' && (
        <div className="flex flex-col gap-4">
          <button
            type="button"
            className="btn btn-ghost btn-sm self-start -mt-2 -ml-2"
            onClick={handleBackToPhoneLogin}
            disabled={loading}
            aria-label="Back to phone number"
          >
            <ChevronLeftIcon className="h-5 w-5" aria-hidden="true" />
            Back
          </button>
          <p className="text-sm text-base-content/70 text-center -mt-4 mb-2">
            Paste an existing Telethon StringSession to sign in
            <br />
            without a phone number and SMS code.
          </p>
          <label className="form-control w-full">
            <div className="label">
              <span className="label-text">Session string</span>
            </div>
            <textarea
              className="textarea textarea-bordered w-full font-mono text-xs break-all"
              rows={3}
              placeholder="Paste your StringSession here…"
              value={sessionInput}
              onChange={(e) => setSessionInput(e.target.value)}
            />
          </label>
          <button
            className="btn btn-primary w-full"
            onClick={handleSignInWithSession}
            disabled={loading || !sessionInput.trim()}
          >
            {loading ? (
              <span className="loading loading-spinner loading-md"></span>
            ) : (
              'Login'
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

      {page === 'password' && (
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
            This account has two-factor authentication enabled.
            <br />
            Please enter your cloud password.
          </p>
          <label className="form-control w-full">
            <div className="label">
              <span className="label-text">2FA Password</span>
            </div>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                className="input input-bordered w-full pr-12"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-ghost btn-sm absolute top-1/2 right-1 -translate-y-1/2"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? (
                  <EyeSlashIcon className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <EyeIcon className="h-5 w-5" aria-hidden="true" />
                )}
              </button>
            </div>
          </label>
          <button
            className="btn btn-primary w-full"
            onClick={handleSubmitPassword}
            disabled={loading || !password.trim()}
          >
            {loading ? (
              <span className="loading loading-spinner loading-md"></span>
            ) : (
              'Login'
            )}
          </button>
        </div>
      )}

      {page === 'qr' && (
        <div className="flex flex-col gap-4">
          <button
            type="button"
            className="btn btn-ghost btn-sm self-start -mt-2 -ml-2"
            onClick={handleBackToPhoneFromQr}
            disabled={loading}
            aria-label="Back to phone number"
          >
            <ChevronLeftIcon className="h-5 w-5" aria-hidden="true" />
            Back
          </button>
          <p className="text-sm text-base-content/70 text-center -mt-4 mb-2">
            Sign in with QR
          </p>
          {qrStatus !== 'password_required' && (
            <>
              <p className="text-sm text-base-content/70 text-center -mt-2">
                Open Telegram on your phone, go to
                <br />
                <span className="font-medium text-base-content">
                  Settings → Devices → Scan QR
                </span>
                , and point it at the code below.
              </p>
              {loading ? (
                <div className="flex justify-center py-12">
                  <span className="loading loading-spinner loading-lg"></span>
                </div>
              ) : (
                qrUrl && (
                  <div className="flex justify-center">
                    <div className="rounded-box bg-base-100 p-4 border border-base-300">
                      <QRCodeSVG value={qrUrl} size={256} />
                    </div>
                  </div>
                )
              )}
              <div className="flex items-center justify-center gap-2 text-sm text-base-content/70">
                {qrStatus === null && (
                  <>
                    <span className="loading loading-spinner loading-sm"></span>
                    <span>Waiting for confirmation…</span>
                  </>
                )}
                {qrStatus === 'expired' && <span>QR code expired</span>}
                {qrStatus === 'error' && <span>QR login failed</span>}
              </div>
              {(qrStatus === 'expired' || qrStatus === 'error') && (
                <button
                  className="btn btn-primary w-full"
                  onClick={handleStartQr}
                  disabled={loading}
                >
                  Refresh QR
                </button>
              )}
            </>
          )}
          {qrStatus === 'password_required' && (
            <>
              <p className="text-sm text-base-content/70 text-center -mt-2">
                QR confirmed on your phone.
                <br />
                This account has two-factor authentication enabled.
                <br />
                Please enter your cloud password.
              </p>
              <label className="form-control w-full">
                <div className="label">
                  <span className="label-text">2FA Password</span>
                </div>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="input input-bordered w-full pr-12"
                    value={qrPassword}
                    onChange={(e) => setQrPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm absolute top-1/2 right-1 -translate-y-1/2"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? (
                      <EyeSlashIcon className="h-5 w-5" aria-hidden="true" />
                    ) : (
                      <EyeIcon className="h-5 w-5" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </label>
              <button
                className="btn btn-primary w-full"
                onClick={handleSubmitQrPassword}
                disabled={loading || !qrPassword.trim()}
              >
                {loading ? (
                  <span className="loading loading-spinner loading-md"></span>
                ) : (
                  'Login'
                )}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
