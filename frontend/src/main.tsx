import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts: the console must work on an offline hackathon/field network.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import './styles/global.css';
import App from './App';
import { startSocket } from './socket';

// Outside React so StrictMode's double-mount in dev can't open two sockets.
startSocket();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
