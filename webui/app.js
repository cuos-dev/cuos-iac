import express from 'express';
import { engine } from 'express-handlebars';
import basicAuth from 'basic-auth';
import bodyParser from 'body-parser';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import Handlebars from 'handlebars';
import bcrypt from 'bcrypt';

const locale = process.env.LOCALE || 'de-DE';
const timeZone = process.env.TZ || 'Europe/Berlin';

Handlebars.registerHelper('formatDate', function(dateStr) {
  if (!dateStr) return '';

  if (!dateStr.match(/Z$/)) dateStr = dateStr+"Z";
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleString(locale, { tz: timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '');
});
Handlebars.registerHelper('getColor', function(percent) {
  if (percent < 70) return '#00BCD4'; // Türkis
  if (percent < 80) return '#FFEB3B'; // Gelb
  return '#F44336'; // Rot
});
Handlebars.registerHelper('portsLink', function(ports, options) {
  if (typeof ports !== "string") return ports;
  return ports.replace(/([0-9.]+):([0-9]+)->([0-9]+)(\/tcp)/g, function(all, ip, port, tport, proto) {
    let http = "http";
    if (port == 443 || port == 8443 || (port >= 4430 && port < 4440)) http = "https";
    let hostname = ip;
    if (ip === "0.0.0.0") hostname = options.data.root.hostname;
    return '<a href="'+http+'://'+hostname+':'+port+'">'+ip+":"+port+'</a>-&gt;'+tport+proto;
  });
});
Handlebars.registerHelper('plus', function(a, b) {
  return a+b;
});

Handlebars.registerHelper('formatRoute', function(route) {
  const keywords = ['default', 'via', 'dev', 'proto', 'scope', 'src', 'linkdown', 'metric'];
  const regex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g');
  const escapedRoute = Handlebars.Utils.escapeExpression(route);
  const highlighted = escapedRoute.replace(regex, '<span class="route">$1</span>');
  return new Handlebars.SafeString(highlighted);
});

Handlebars.registerHelper('toLowerCase', function(string) {
  if (typeof string !== 'string') return string;
  return string.toLowerCase();
});

const configPath = "/system.json";
const SOCKET_PATH = '/var/run/cuos.sock';
let USER = 'admin';
let PASS = 'admin';

// Load configuration from /system.json if it exists
let config = {};
try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (config['iac_user'] && config['iac_password']) {
        USER = config['iac_user'];
        PASS = config['iac_password'];
    } else {
        console.warn(`Configuration file ${configPath} does not contain user or pass fields.`);
    }
} catch (err) {
    if (err.code === 'ENOENT') {
        console.warn(`Configuration file /system.json not found, using default credentials.`);
    } else {
        console.error(`Error reading configuration file /system.json: ${err.message}`);
        process.exit(1);
    }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: false }));

app.engine('handlebars', engine());
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, 'views'));

function auth(req, res, next) {
    const user = basicAuth(req);

    if (!user || user.name !== USER) {
        res.set('WWW-Authenticate', 'Basic realm="cuos"');
        return res.status(401).send('Authentication required.');
    }

    // Check if PASS is a bcrypt hash and compare
    const isHash = PASS.startsWith('$2b$') || PASS.startsWith('$2a$') || PASS.startsWith('$2y$');
    const passwordMatches = isHash ? bcrypt.compareSync(user.pass, PASS) : user.pass === PASS;

    if (!passwordMatches) {
        res.set('WWW-Authenticate', 'Basic realm="cuos"');
        return res.status(401).send('Authentication required.');
    }

    next();
}

function cuosApi(command, data = {}) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection(SOCKET_PATH);

        client.on('connect', () => {
            client.write(JSON.stringify({ command, ...data })+"\n");
        });

        let response = '';
        client.on('data', (chunk) => {
            response += chunk.toString();
        });

        client.on('end', () => {
            try {
                const result = JSON.parse(response);
                resolve(result);
            } catch (err) {
		resolve(response.trim());
            }
        });

        client.on('error', (err) => {
            reject(err);
        });
    });
}

app.use(auth);

app.get('/', async (req, res) => {
  const p_state = cuosApi('state');
  const p_resources = cuosApi('resources');
  const p_app_ps = cuosApi('app', {"app_command": "ps"});
  const p_app_state = cuosApi('app', {"app_command": "state"});
  const p_log = cuosApi('log');
  const state = await p_state;
  const resources = await p_resources;
  const app_ps = await p_app_ps;
  const app_state = await p_app_state;
  const log = await p_log;
  const last_10_logs = log.slice(-100).reverse();
  const iac_repo_name = (config['iac_repo_url'] || '').replace(/^https?:\/\/.+\//, '').replace(/^git@.+:/, '').replace(/\.git$/, '');
  const iac_repo_url = (config['iac_repo_url'] || '').replace(/^(https?:\/\/)[^/]+@/, '$1').replace(/^git@/, 'https:\/\/').replace(/\.git$/, '');
  const iac_repo_branch = config['iac_repo_branch'] || 'main';

  resources.ram_percent = Math.round((resources.mem_used_mb / resources.mem_total_mb) * 100);
  resources.disk_percent = Math.round((resources.disk_used_mb / resources.disk_total_mb) * 100);

  res.render('home', { state, resources, app_ps, app_state, hostname: req.hostname, iac_repo_name, iac_repo_url, iac_repo_branch, last_10_logs });
});

app.get('/config', async (req, res) => {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  res.render('config', {
    config: JSON.stringify(config, undefined, "  ")
  });
});

app.post('/config', bodyParser.urlencoded({ extended: false }), async (req, res) => {
  try {
    const config = req.body.config;
    let response = await cuosApi("patch", config);
    res.render('send', { result: response });
  } catch (err) {
    res.render('send', { result: `Socket error: ${err.message}` });
  }
});


app.post('/send', bodyParser.urlencoded({ extended: false }), async (req, res) => {
    let command = req.body.command || 'version';
    let data = {};
    try {
        data = req.body.data ? JSON.parse(req.body.data) : {};
    } catch {
        return res.render('home', { result: 'Ungültiges JSON in Datenfeld.' });
    }

    if (command === "app_update") {
        command = "app";
        data = {"app_command": "update"}
    }

    try {
        let response = await cuosApi(command, data);
        if (response === "") {
            res.redirect('./');
            return;
        }
        res.render('send', { result: response });
    } catch (err) {
        res.render('send', { result: `Socket error: ${err.message}` });
    }
});

const PORT = 3000;
const server = app.listen(PORT, () => {
    console.log(`iac-manager-webui listening on http://localhost:${PORT}`);
});


function shutdown() {
  console.log('Shutting down...');
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forcing shutdown...');
    process.exit(1);
  }, 1000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
