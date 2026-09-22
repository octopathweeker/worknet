import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import PlatformApp from './PlatformApp';
import './style.css';
import {useLanguage} from './i18n';
import {ToastProvider} from './Toast';
function LocalizedApp(){
  useLanguage();
  const [legacy, setLegacy] = useState(() => window.location.hash.startsWith('#legacy'));
  useEffect(() => {
    const onHash = () => setLegacy(window.location.hash.startsWith('#legacy'));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return legacy ? <App/> : <PlatformApp/>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><ToastProvider><LocalizedApp/></ToastProvider></React.StrictMode>);
