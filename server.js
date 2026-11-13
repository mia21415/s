const express = require('express');
const session = require('express-session');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'mia-hosting-secure-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // תוקף סשן
}));

app.use(express.static(path.join(__dirname, 'public')));

// כניסה ראשונית מפנה לעמוד ההתחברות
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

const upload = multer({ dest: 'uploads/' });
let activeProcesses = {};
let botLogs = {};

// קובץ בוטים נפרד לכל משתמש
function getBotsFile(username) {
    return path.join(__dirname, `bots_${username}.json`);
}

function getBots(username) {
    const file = getBotsFile(username);
    if (!fs.existsSync(file)) return [];
    try {
        return JSON.parse(fs.readFileSync(file));
    } catch {
        return [];
    }
}

function saveBots(username, bots) {
    fs.writeFileSync(getBotsFile(username), JSON.stringify(bots, null, 2));
}

// התחברות
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if ((username === 'mia' && password === '2234') || (username === 'Trigger' && password === '8921')) {
        req.session.authenticated = true;
        req.session.username = username;
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'שם משתמש או סיסמה שגויים' });
    }
});

// בדיקת משתמש מחובר
app.get('/api/user', (req, res) => {
    if (req.session && req.session.authenticated) {
        res.json({ loggedIn: true, username: req.session.username });
    } else {
        res.json({ loggedIn: false });
    }
});

// התנתקות (Logout) - מוחק את הסשן ומחייב כניסה מחדש
app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

// הגנה על הדשבורד
app.use('/dashboard.html', (req, res, next) => {
    if (req.session && req.session.authenticated) next();
    else res.redirect('/login.html');
});

// קבלת הבוטים של המשתמש המחובר בלבד
app.get('/api/bots', (req, res) => {
    if (!req.session || !req.session.authenticated) return res.status(401).json([]);
    const username = req.session.username;
    
    const bots = getBots(username).map(b => ({
        ...b,
        status: activeProcesses[b.id] ? 'running' : 'stopped',
        hasFiles: fs.existsSync(b.folder) && fs.readdirSync(b.folder).length > 0
    }));
    res.json(bots);
});

// יצירת בוט חדש למשתמש המחובר
app.post('/api/bots/create', (req, res) => {
    if (!req.session || !req.session.authenticated) return res.json({ success: false, message: 'לא מורשה' });
    const username = req.session.username;
    const { name } = req.body;
    if (!name) return res.json({ success: false, message: 'חסר שם' });

    const botId = `${username}_bot_${Date.now()}`;
    const botFolder = path.join(__dirname, 'extracted_bots', botId);
    fs.mkdirSync(botFolder, { recursive: true });

    const newBot = { id: botId, name, folder: botFolder, mainFile: 'index.js', token: '', avatar: '' };
    const bots = getBots(username);
    bots.push(newBot);
    saveBots(username, bots);

    botLogs[botId] = `[System] Bot ${name} created successfully.\n`;

    res.json({ success: true, bot: newBot });
});

app.get('/api/bots/:id/logs', (req, res) => {
    if (!req.session || !req.session.authenticated) return res.json({ logs: 'Unauthorized' });
    const botId = req.params.id;
    res.json({ logs: botLogs[botId] || 'No logs yet...' });
});

// העלאה ושמירה לבוט של המשתמש
app.post('/api/bots/:id/deploy', upload.single('file'), (req, res) => {
    if (!req.session || !req.session.authenticated) return res.json({ success: false, message: 'לא מורשה' });
    const username = req.session.username;
    const botId = req.params.id;
    const { token } = req.body;
    const file = req.file;

    const bots = getBots(username);
    const botIndex = bots.findIndex(b => b.id === botId);
    if (botIndex === -1 || !token) {
        return res.json({ success: false, message: 'נתונים חסרים (חובה להזין Token)' });
    }

    res.json({ success: true });
    runDeployProcess(username, botId, botIndex, file, token);
});

function runDeployProcess(username, botId, botIndex, file, token) {
    const bots = getBots(username);
    const bot = bots[botIndex];

    if (activeProcesses[botId]) {
        activeProcesses[botId].kill();
        delete activeProcesses[botId];
    }

    botLogs[botId] = `[System] Saving settings and preparing bot...\n`;

    try {
        if (file) {
            const zip = new AdmZip(file.path);
            zip.extractAllTo(bot.folder, true);
            fs.unlinkSync(file.path);
            botLogs[botId] += `[System] New ZIP file extracted successfully.\n`;

            const packageJsonPath = path.join(bot.folder, 'package.json');
            let mainFile = 'index.js';

            if (fs.existsSync(packageJsonPath)) {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath));
                if (pkg.main) mainFile = pkg.main;
            }
            bot.mainFile = mainFile;
        }

        bot.token = token;
        saveBots(username, bots);

        const hasNodeModules = fs.existsSync(path.join(bot.folder, 'node_modules'));

        const startExecution = () => {
            const runnerPath = path.join(bot.folder, '_mia_runner.js');
            const wrapperContent = `
const { Client } = require('discord.js');
const origLogin = Client.prototype.login;
Client.prototype.login = function(t) {
    this.once('ready', () => {
        if (this.user) {
            this.user.setPresence({
                activities: [{ name: 'miahosting', type: 0 }],
                status: 'online'
            });
        }
    });
    return origLogin.call(this, t || process.env.DISCORD_TOKEN);
};
require('./${bot.mainFile}');
`;
            fs.writeFileSync(runnerPath, wrapperContent);

            fetchBotAvatar(token, (avatarUrl) => {
                if (avatarUrl) {
                    const latestBots = getBots(username);
                    const target = latestBots.find(b => b.id === botId);
                    if (target) {
                        target.avatar = avatarUrl;
                        saveBots(username, latestBots);
                    }
                }
            });

            botLogs[botId] += `[System] Starting bot process...\n`;
            startBotProcess(botId, bot.folder, '_mia_runner.js', token);
        };

        if (file && !hasNodeModules) {
            botLogs[botId] += `[System] Running npm install...\n`;
            const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
            const npmProcess = spawn(npmCmd, ['install'], { cwd: bot.folder });

            npmProcess.stdout.on('data', (data) => { botLogs[botId] += data.toString(); });
            npmProcess.stderr.on('data', (data) => { botLogs[botId] += data.toString(); });
            npmProcess.on('close', () => {
                botLogs[botId] += `[System] npm install finished.\n`;
                startExecution();
            });
        } else {
            botLogs[botId] += `[System] Using existing files and modules.\n`;
            startExecution();
        }

    } catch (err) {
        botLogs[botId] += `[ERROR] ${err.message}\n`;
    }
}

function fetchBotAvatar(token, callback) {
    const options = {
        hostname: 'discord.com',
        path: '/api/v10/users/@me',
        method: 'GET',
        headers: {
            'Authorization': `Bot ${token}`,
            'User-Agent': 'DiscordBot (https://miahosting.com, v1.0)'
        }
    };

    const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            try {
                const json = JSON.parse(data);
                if (json && json.id && json.avatar) {
                    const ext = json.avatar.startsWith('a_') ? 'gif' : 'png';
                    const avatarUrl = `https://cdn.discordapp.com/avatars/${json.id}/${json.avatar}.${ext}?size=128`;
                    callback(avatarUrl);
                } else {
                    callback(null);
                }
            } catch (e) {
                callback(null);
            }
        });
    });

    req.on('error', () => { callback(null); });
    req.end();
}

function startBotProcess(id, folder, runnerFile, token) {
    const env = { ...process.env, DISCORD_TOKEN: token, TOKEN: token };
    const child = spawn('node', [runnerFile], { cwd: folder, env });

    activeProcesses[id] = child;

    child.stdout.on('data', (data) => {
        botLogs[id] = (botLogs[id] || '') + data.toString();
    });

    child.stderr.on('data', (data) => {
        botLogs[id] = (botLogs[id] || '') + `[ERROR] ${data.toString()}`;
    });

    child.on('close', (code) => {
        botLogs[id] = (botLogs[id] || '') + `[System] Process exited with code ${code}\n`;
        delete activeProcesses[id];
    });
}

// מחיקת בוט של המשתמש
app.delete('/api/bots/:id', (req, res) => {
    if (!req.session || !req.session.authenticated) return res.json({ success: false });
    const username = req.session.username;
    const botId = req.params.id;
    let bots = getBots(username);
    const bot = bots.find(b => b.id === botId);

    if (bot) {
        if (activeProcesses[botId]) {
            activeProcesses[botId].kill();
            delete activeProcesses[botId];
        }
        try {
            fs.rmSync(bot.folder, { recursive: true, force: true });
        } catch (e) {}

        bots = bots.filter(b => b.id !== botId);
        saveBots(username, bots);
        delete botLogs[botId];
    }

    res.json({ success: true });
});

// שחזור בוטים של שני המשתמשים בעליית השרת
function restoreAllBots() {
    ['mia', 'Trigger'].forEach(username => {
        const bots = getBots(username);
        bots.forEach(bot => {
            const runnerPath = path.join(bot.folder, '_mia_runner.js');
            if (bot.token && fs.existsSync(runnerPath)) {
                botLogs[bot.id] = `[System] Restoring bot on server startup...\n`;
                startBotProcess(bot.id, bot.folder, '_mia_runner.js', bot.token);
            }
        });
    });
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    restoreAllBots();
});
