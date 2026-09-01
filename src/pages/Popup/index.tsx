import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Popup from './Popup';
import './index.css';
import { initializeI18n, tr } from '../../i18n';

const container = document.getElementById('app-container') as HTMLElement;

const render = async () => {
  await initializeI18n();
  document.title = tr('Apple All-In-One', 'Apple All-In-One');
  createRoot(container).render(
    <StrictMode>
      <Popup />
    </StrictMode>
  );
};

render().catch(console.error);
