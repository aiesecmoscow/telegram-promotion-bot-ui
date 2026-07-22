import { useState, useEffect } from 'react';
import './App.css';
import AuthPage from './components/AuthPage';
import MainPage from './components/MainPage';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Проверяем наличие сохраненной сессии при загрузке
  useEffect(() => {
    const savedSession = localStorage.getItem('telegram_session');
    if (savedSession) {
      setIsAuthenticated(true);
    }
  }, []);

  const handleAuthSuccess = (session: string) => {
    setIsAuthenticated(true);
    localStorage.setItem('telegram_session', session);
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    localStorage.removeItem('telegram_session');
  };

  return (
    <div className="App">
      {!isAuthenticated ? (
        <AuthPage onAuthSuccess={handleAuthSuccess} />
      ) : (
        <MainPage onLogout={handleLogout} />
      )}
    </div>
  );
}

export default App;
