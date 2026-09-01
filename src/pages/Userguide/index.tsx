import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Userguide from './Userguide';
import './index.css';
import { initializeI18n, tr } from '../../i18n';

const container = document.getElementById('app-container') as HTMLElement;

const render = async () => {
  await initializeI18n();
  document.title = tr('Apple All-In-One — Setup Guide', 'Apple All-In-One — 使用指南');
  createRoot(container).render(
    <StrictMode>
      <Userguide />
    </StrictMode>
  );
};

render().catch(console.error);
