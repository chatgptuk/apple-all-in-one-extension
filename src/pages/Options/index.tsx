import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Options from './Options';
import './index.css';
import { initializeI18n, tr } from '../../i18n';

const container = document.getElementById('app-container') as HTMLElement;

const render = async () => {
  await initializeI18n();
  document.title = tr('Apple All-In-One — Settings', 'Apple All-In-One — 设置');
  createRoot(container).render(
    <StrictMode>
      <Options />
    </StrictMode>
  );
};

render().catch(console.error);
