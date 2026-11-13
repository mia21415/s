const express = require('express');
const session = require('express-session');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

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
        status: activeProcesses[b.id] ? 'running' : 'stopped'
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

    const newBot = { id: botId, name, folder: botFolder, mainFile: 'index.js', token: '' };
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

// העלאת קבצים, התקנת חבילות אוטומטית והפעלת הבוט
app.post('/api/bots/:id/deploy', upload.single('file'), (req, res) => {
    try {
        const botId = req.params.id;
        const { token } = req.body;
        const file = req.file;

        const bots = getBots();
        const botIndex = bots.findIndex(b => b.id === botId);
        if (botIndex === -1 || !file || !token) {
            return res.json({ success: false, message: 'נתונים חסרים' });
        }

        const bot = bots[botIndex];

        if (activeProcesses[botId]) {
            activeProcesses[botId].kill();
            delete activeProcesses[botId];
        }

        // חילוץ ה-ZIP
        const zip = new AdmZip(file.path);
        zip.extractAllTo(bot.folder, true);
        fs.unlinkSync(file.path);

        botLogs[botId] = (botLogs[botId] || '') + `[System] Files extracted successfully.\n`;

        // בדיקה והתקנה אוטומטית של package.json אם קיים
        const packageJsonPath = path.join(bot.folder, 'package.json');
        let mainFile = 'index.js';

        if (fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath));
            if (pkg.main) mainFile = pkg.main;

            botLogs[botId] += `[System] Running npm install for bot dependencies...\n`;
            try {
                execSync('npm install', { cwd: bot.folder, stdio: 'inherit' });
                botLogs[botId] += `[System] Dependencies installed successfully!\n`;
            } catch (installErr) {
                botLogs[botId] += `[ERROR] Failed to run npm install.\n`;
            }
        } else {
            botLogs[botId] += `[System] Warning: No package.json found. Installing discord.js automatically...\n`;
            try {
                execSync('npm init -y && npm install discord.js', { cwd: bot.folder, stdio: 'inherit' });
            } catch (e) {}
        }

        // עטיפת הבוט להזרקת סטטוס miahosting אוטומטית
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
require('./${mainFile}');
`;
        fs.writeFileSync(path.join(bot.folder, '_mia_runner.js'), wrapperContent);

        bots[botIndex].mainFile = mainFile;
        bots[botIndex].token = token;
        saveBots(bots);

        botLogs[botId] += `[System] Starting bot process...\n`;
        startBotProcess(botId, bot.folder, '_mia_runner.js', token);

        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.json({ success: false, message: 'שגיאה בהעלאה' });
    }
});

function startBotProcess(id, folder, runnerFile, token) {
    const env = { ...process.env, DISCORD_TOKEN: token, TOKEN: token };
    const child = spawn('node', [runnerFile], { cwd: folder, env });

    activeProcesses[id] = child;

    child.stdout.on('data', (data) => {
        const msg = data.toString();
        console.log(`[${id}]: ${msg}`);
        botLogs[id] = (botLogs[id] || '') + msg;
    });

    child.stderr.on('data', (data) => {
        const msg = data.toString();
        console.error(`[${id} Error]: ${msg}`);
        botLogs[id] = (botLogs[id] || '') + `[ERROR] ${msg}`;
    });

    child.on('close', (code) => {
        const msg = `[System] Process exited with code ${code}\n`;
        botLogs[id] = (botLogs[id] || '') + msg;
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
