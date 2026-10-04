// The base stylesheet loads before the app so each feature's own CSS wins at equal specificity.
import './styles/globals.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { linkManifest, UpdatePrompt } from './lib/pwa.tsx';
// Loads after the app's own stylesheets, so its narrow-screen rules have the last word.
import './styles/responsive.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing #root element');
}

const queryClient = new QueryClient();
linkManifest(window.location.pathname);

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <UpdatePrompt />
    </QueryClientProvider>
  </StrictMode>,
);
