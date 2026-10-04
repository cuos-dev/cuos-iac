// SPDX-License-Identifier: Apache-2.0
import { render } from 'preact';
import App from './App';
// bundled on purpose: a device may have no internet access
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@tabler/icons-webfont/dist/tabler-icons.min.css';
import './style/main.css';

render(<App />, document.getElementById('app'));
