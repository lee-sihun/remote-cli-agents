import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './app.css';

// 이전 서비스 워커 캐시 정리 (한 번만 실행)
if ('serviceWorker' in navigator) {
  const cleanupVersion = 'rca_sw_v2';
  if (!sessionStorage.getItem(cleanupVersion)) {
    sessionStorage.setItem(cleanupVersion, '1');
    navigator.serviceWorker.getRegistrations().then((regs) => {
      if (regs.length > 0) {
        Promise.all(regs.map((r) => r.unregister())).then(() => {
          // 캐시도 삭제
          caches.keys().then((names) => {
            Promise.all(names.map((name) => caches.delete(name))).then(() => {
              window.location.reload();
            });
          });
        });
      }
    });
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
