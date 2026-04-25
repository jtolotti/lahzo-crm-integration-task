import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { api } from '../lib/api.ts';

interface User {
  userId: string;
  email: string;
  name: string;
  role: 'admin' | 'operator';
}

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('lahzo_token'));
  const [user, setUser] = useState<User | null>(() => {
    const stored = localStorage.getItem('lahzo_user');
    return stored ? (JSON.parse(stored) as User) : null;
  });

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    localStorage.setItem('lahzo_token', res.token);
    localStorage.setItem('lahzo_user', JSON.stringify(res.user));
    setToken(res.token);
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('lahzo_token');
    localStorage.removeItem('lahzo_user');
    setToken(null);
    setUser(null);
  }, []);

  const isAdmin = user?.role === 'admin';

  return (
    <AuthContext.Provider value={{ user, token, isAdmin, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
