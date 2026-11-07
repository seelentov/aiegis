import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api } from './api';
import { lang, syncLanguage } from './i18n';
import { setPageSizes } from './ui';
import './styles.css';

document.documentElement.lang = lang;
void api.uiLanguage().then(syncLanguage, () => undefined);
// Read before the first render: otherwise the tables would first show a page of the default size.
void api.uiPageSizes().then(setPageSizes, () => undefined).finally(() => createRoot(document.getElementById('root')!).render(<App />));
