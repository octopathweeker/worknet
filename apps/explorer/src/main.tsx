import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import PlatformApp from './PlatformApp';
import './style.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.hash.startsWith('#legacy') ? <App/> : <PlatformApp/>}</React.StrictMode>);
