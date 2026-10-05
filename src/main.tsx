import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import { checkVersion, clearUpdateMarker } from './version';

async function start() {
  clearUpdateMarker();
  const update = await checkVersion();
  if (update === 'Updating…') return;
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode><App /></React.StrictMode>,
  );
}
void start();
