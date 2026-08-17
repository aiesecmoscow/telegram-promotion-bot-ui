import { useState } from 'react';
import Auth from './components/Auth';
import MainView from './components/MainView';

type Page = 'login' | 'main';

function App() {
  const [session, setSession] = useState<string>(
    () => localStorage.getItem('tg_session') ?? '',
  );
  const [page, setPage] = useState<Page>(() =>
    localStorage.getItem('tg_session') ? 'main' : 'login',
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleAuthenticated = (s: string) => {
    localStorage.setItem('tg_session', s);
    setSession(s);
    setError('');
    setLoading(false);
    setPage('main');
  };

  const handleLogout = () => {
    localStorage.removeItem('tg_session');
    setSession('');
    setError('');
    setLoading(false);
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

        {page === 'main' && session ? (
          <MainView
            session={session}
            loading={loading}
            setLoading={setLoading}
            error={error}
            setError={setError}
            onLogout={handleLogout}
          />
        ) : (
          <Auth
            loading={loading}
            setLoading={setLoading}
            error={error}
            setError={setError}
            onAuthenticated={handleAuthenticated}
          />
        )}
      </div>
    </div>
  );
}

export default App;
