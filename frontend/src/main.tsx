/**
 * main.tsx
 * 应用入口：挂载 React 18 到 #root + 全局 CSS 变量
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
