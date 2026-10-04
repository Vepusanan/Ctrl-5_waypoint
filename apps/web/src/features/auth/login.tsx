import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card } from '../../components/waypoint';
import { message } from '../../lib/api';
import { useAuth } from './auth';
import './login.css';

const steps = [
  ['Plan', 'Layers'],
  ['Load', 'Pkg'],
  ['Deliver', 'Truck'],
  ['Receive', 'Store'],
] as const;
const columns = [0, 1, 2, 1, 4, 2, 6, 4, 2, 6, 4, 6, 2, 4, 6, 6, 4, 6].map((asset, position) => ({
  id: `column-${position}`,
  asset,
}));
export function SignIn() {
  const { login: signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => signIn(email, password),
  });
  return (
    <main className="auth-signin">
      <section className="auth-brand-panel" aria-label="Waypoint">
        <a className="wp-brand" href="/">
          <span>W</span>Waypoint
        </a>
        <div className="auth-intro">
          <h2>
            Plan. Load. Deliver.
            <br />
            One version for everyone.
          </h2>
          <ol className="auth-workflow">
            {steps.map(([label, icon], index) => (
              <li key={label}>
                {index > 0 && <img src="/waypoint/auth/imgIconCr.svg" alt="" />}
                <span>
                  <img src={`/waypoint/auth/imgIcon${icon}.svg`} alt="" />
                  {label}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="auth-matrix" aria-hidden="true">
          {columns.map((column) => (
            // Each position is a fixed column in the Figma illustration.
            <img key={column.id} src={`/waypoint/auth/imgC${column.asset}.svg`} alt="" />
          ))}
        </div>
      </section>
      <div className="auth-form-side">
        <a className="wp-brand auth-mobile-brand" href="/" aria-label="Waypoint home">
          <span>W</span>Waypoint
        </a>
        <Card className="auth-card">
          <h1>Sign in</h1>
          <p className="wp-muted">Use your work email to open your workspace.</p>
          <form
            className="store-form"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate();
            }}
          >
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {login.error && (
              <p role="alert" className="store-error">
                {message(login.error)}
              </p>
            )}
            <Button type="submit" busy={login.isPending}>
              {login.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </Card>
      </div>
    </main>
  );
}
