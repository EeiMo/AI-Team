/**
 * main.tsx
 * 应用入口：挂载 React 18 到 #root
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// 全局样式重置
const style = document.createElement('style');
style.textContent = `
  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }
  body {
    line-height: 1.5;
    -webkit-tap-highlight-color: transparent;
  }
  input, button {
    font-family: inherit;
  }
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
