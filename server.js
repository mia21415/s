const express = require('express');
const session = require('express-session');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'mia-secret-key',
    resave: false,
    saveUninitialized: true
}));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.redirect('/login.html');
});

const upload = multer({ dest: 'uploads/' });
const BOTS_FILE = path.join(__dirname, 'bots.json');
let activeProcesses = {};
let botLogs = {};

function getBots() {
    if (!fs.existsSync(BOTS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(BOTS_FILE));
    } catch {
        return [];
    }
}

function saveBots(bots) {
    fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2));
}

// התחברות
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'mia' && password === '2234') {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'שם משתמש או סיסמה שגויים' });
    }
});

app.use('/dashboard.html', (req, res, next) => {
    if (req.session.authenticated) next();
    else res.redirect('/login.html');
});

// קבלת רשימת בוטים
app.get('/api/bots', (req, res) => {
    const bots = getBots().map(b => ({
        ...b,
        status: activeProcesses[b.id] ? 'running' : 'stopped',
        hasFiles: fs.existsSync(b.folder) && fs.readdirSync(b.folder).length > 0
    }));
    res.json(bots);
});

// יצירת בוט חדש עם תיקייה
app.post('/api/bots/create', (req, res) => {
    const { name } = req.body;
    if (!name) return res.json({ success: false, message: 'חסר שם' });

    const botId = 'bot_' + Date.now();
    const botFolder = path.join(__dirname, 'extracted_bots', botId);
    fs.mkdirSync(botFolder, { recursive: true });

    const newBot = { id: botId, name, folder: botFolder, mainFile: 'index.js', token: '', avatar: '' };
    const bots = getBots();
    bots.push(newBot);
    saveBots(bots);

    botLogs[botId] = `[System] Bot ${name} created successfully.\n`;

    res.json({ success: true, bot: newBot });
});

// לוגים חיים
app.get('/api/bots/:id/logs', (req, res) => {
    const botId = req.params.id;
    res.json({ logs: botLogs[botId] || 'No logs yet...' });
});

// שמירת טוקן והעלאת קבצים בצורה אסינכרונית מהירה לשידור חי בלוגים
app.post('/api/bots/:id/deploy', upload.single('file'), (req, res) => {
    const botId = req.params.id;
    const { token } = req.body;
    const file = req.file;

    const bots = getBots();
    const botIndex = bots.findIndex(b => b.id === botId);
    if (botIndex === -1 || !token) {
        return res.json({ success: false, message: 'נתונים חסרים' });
    }

    res.json({ success: true }); // מחזיר תשובה מיד כדי שהאתר לא יתקע!

    // ממשיך לבצע ברקע ומדפיס ללוגים בלייב
    runDeployProcess(botId, botIndex, file, token);
});

function runDeployProcess(botId, botIndex, file, token) {
    const bots = getBots();
    const bot = bots[botIndex];

    if (activeProcesses[botId]) {
        activeProcesses[botId].kill();
        delete activeProcesses[botId];
    }

    botLogs[botId] = `[System] Starting deployment process...\n`;

    try {
        if (file) {
            const zip = new AdmZip(file.path);
            zip.extractAllTo(bot.folder, true);
            fs.unlinkSync(file.path);
            botLogs[botId] += `[System] ZIP extracted successfully.\n`;

            const packageJsonPath = path.join(bot.folder, 'package.json');
            let mainFile = 'index.js';

            if (fs.existsSync(packageJsonPath)) {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath));
                if (pkg.main) mainFile = pkg.main;
            }
            bot.mainFile = mainFile;
        }

        bot.token = token;
        saveBots(bots);

        // התקנת חבילות ברקע עם הצגת פלט חי בלוגים
        botLogs[botId] += `[System] Running npm install (this may take a few seconds)...\n`;
        
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const npmProcess = spawn(npmCmd, ['install'], { cwd: bot.folder });

        npmProcess.stdout.on('data', (data) => {
            botLogs[botId] += data.toString();
        });

        npmProcess.stderr.on('data', (data) => {
            botLogs[botId] += data.toString();
        });

        npmProcess.on('close', (code) => {
            botLogs[botId] += `[System] npm install finished with code ${code}.\n`;
            
            // יצירת עטיפת הרצה
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

            // שליפת אוואטר של הבוט
            fetchBotAvatar(token).then(avatarUrl => {
                if (avatarUrl) {
                    const latestBots = getBots();
                    const target = latestBots.find(b => b.id === botId);
                    if (target) {
                        target.avatar = avatarUrl;
                        saveBots(latestBots);
                    }
                }
            });

            botLogs[botId] += `[System] Starting bot process now...\n`;
            startBotProcess(botId, bot.folder, '_mia_runner.js', token);
        });

    } catch (err) {
        botLogs[botId] += `[ERROR] ${err.message}\n`;
    }
}

async function fetchBotAvatar(token) {
    try {
        const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
        const response = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bot ${token}` }
        });
        const data = await response.json();
        if (data && data.id && data.avatar) {
            return `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png?size=128`;
        }
    } catch (e) {}
    return null;
}

function startBotProcess(id, folder, runnerFile, token) {
    const env = { ...process.env, DISCORD_TOKEN: token, TOKEN: token };
    const child = spawn('node', [runnerFile], { cwd: folder, env });

    activeProcesses[id] = child;

    child.stdout.on('data', (data) => {
        const msg = data.toString();
        botLogs[id] = (botLogs[id] || '') + msg;
    });

    child.stderr.on('data', (data) => {
        const msg = data.toString();
        botLogs[id] = (botLogs[id] || '') + `[ERROR] ${msg}`;
    });

    child.on('close', (code) => {
        botLogs[id] = (botLogs[id] || '') + `[System] Process exited with code ${code}\n`;
        delete activeProcesses[id];
    });
}

// מחיקת בוט
app.delete('/api/bots/:id', (req, res) => {
    const botId = req.params.id;
    let bots = getBots();
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
        saveBots(bots);
        delete botLogs[botId];
    }

    res.json({ success: true });
});

function restoreBots() {
    const bots = getBots();
    bots.forEach(bot => {
        const runnerPath = path.join(bot.folder, '_mia_runner.js');
        if (bot.token && fs.existsSync(runnerPath)) {
            botLogs[bot.id] = `[System] Restoring bot on server startup...\n`;
            startBotProcess(bot.id, bot.folder, '_mia_runner.js', bot.token);
        }
    });
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    restoreBots();
});
