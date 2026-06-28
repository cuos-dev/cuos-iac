import { render } from 'preact';
import { App } from './App.jsx';
import '@fontsource/sora/400.css';
import '@fontsource/sora/500.css';
import '@fontsource/sora/600.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/400-italic.css';
import '@fontsource/dm-mono/500.css';
import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import './style/main.css';
import './style/topbar.css';
import './style/cards.css';
import './style/table.css';
import './style/detail.css';
import './style/logs.css';

render(<App />, document.getElementById('app'));
