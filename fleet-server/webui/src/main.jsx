import { render } from 'preact';
import { App } from './App.jsx';
import './style/main.css';
import './style/topbar.css';
import './style/cards.css';
import './style/table.css';
import './style/detail.css';
import './style/logs.css';

render(<App />, document.getElementById('app'));
