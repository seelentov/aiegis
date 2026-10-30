import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api } from './api';
import { lang, syncLanguage } from './i18n';
import './styles.css';

document.documentElement.lang = lang;
void api.uiLanguage().then(syncLanguage, () => undefined);
createRoot(document.getElementById('root')!).render(<App />);
