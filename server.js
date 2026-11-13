const express = require('express');
const session = require('express-session');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000; // <--- כאן תוכל לשנות פורט אם תרצה (למשל ל-8080)

// ==========================================
// 📌 כאן משנים את שם המשתמש והסיסמה להתחברות לפאנל:
const AUTH_USER = 'mia';
const AUTH_PASS = '2234';
// ==========================================

// תיקיות אחסון
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const BOTS_DIR = path.join(__dirname, 'bots_storage');
const DATA_FILE = path.join(__dirname, 'bots.json');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR);
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([]));

// ניהול תהליכים רצים בזיכרון
const runningProcesses = {};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'super-secret-bot-panel-key-9988', // <--- כאן אפשר לשנות מפתח הצפנה לסשן אם תرצה
    resave: false,
    saveUninitialized: false
}));

const upload = multer({ dest: UPLOADS_DIR });

// קריאה ושמירה של נתוני הבוטים
function getBots() {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveBots(bots) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(bots, null, 2));
}

// הגדרת תיקיית הקבצים הסטטיים (HTML/CSS)
app.use(express.static(path.join(__dirname, 'public')));

// Middleware לבדיקת התחברות
function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
        return next();
    }
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.redirect('/login.html');
}

// נתיבי התחברות
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === AUTH_USER && password === AUTH_PASS) {
        req.session.authenticated = true;
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, message: 'שם משתמש או סיסמה שגויים' });
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// הגנה על דשבורד
app.get('/dashboard.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public/dashboard.html'));
});

// פונקציית הפעלת בוט
function startBotProcess(bot) {
    if (runningProcesses[bot.id]) return;

    const botPath = path.join(BOTS_DIR, bot.id);
    if (!fs.existsSync(botPath)) return;

    // זיהוי קובץ ההפעלה הראשי של הבוט
    let entryFile = 'index.js'; // <--- ברירת המחדל היא index.js
    const pkgPath = path.join(botPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.main) entryFile = pkg.main; // אם מוגדר main ב-package.json של הבוט, השרת ייקח משם את הקובץ
        } catch (e) {}
    }

    if (!fs.existsSync(path.join(botPath, entryFile))) {
        const jsFiles = fs.readdirSync(botPath).filter(f => f.endsWith('.js'));
        if (jsFiles.length > 0) entryFile = jsFiles[0];
    }

    // העברת ה-Token דרך משתני סביבה לבוט
    const envVars = { ...process.env, TOKEN: bot.token, DISCORD_TOKEN: bot.token };
    
    const child = spawn('node', [entryFile], {
        cwd: botPath,
        env: envVars,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    bot.logs = bot.logs || [];
    const addLog = (data) => {
        const line = `[${new Date().toLocaleTimeString()}] ${data.toString().trim()}`;
        bot.logs.push(line);
        if (bot.logs.length > 50) bot.logs.shift(); // שומר עד 50 לוגים אחרונים לכל בוט
    };

    child.stdout.on('data', addLog);
    child.stderr.on('data', addLog);

    child.on('exit', (code) => {
        addLog(`הבוט נעצר (קוד יציאה: ${code})`);
        delete runningProcesses[bot.id];
        const bots = getBots();
        const b = bots.find(x => x.id === bot.id);
        if (b && b.shouldRun) {
            setTimeout(() => startBotProcess(b), 5000); // הפעלה מחדש אוטומטית אחרי 5 שניות אם קרס
        }
    });

    runningProcesses[bot.id] = { process: child, logs: bot.logs };
}

function stopBotProcess(botId) {
    if (runningProcesses[botId]) {
        runningProcesses[botId].process.kill('SIGTERM');
        delete runningProcesses[botId];
    }
}

// API: קבלת רשימת בוטים
app.get('/api/bots', requireAuth, (req, res) => {
    const bots = getBots().map(b => ({
        ...b,
        isRunning: !!runningProcesses[b.id],
        logs: runningProcesses[b.id] ? runningProcesses[b.id].logs : (b.logs || [])
    }));
    res.json(bots);
});

// API: יצירת בוט חדש
app.post('/api/bots', requireAuth, upload.array('files'), (req, res) => {
    try {
        const { name, token } = req.body;
        const files = req.files;

        if (!name || !token || !files || files.length === 0) {
            return res.status(400).json({ error: 'חסרים פרטים או קבצים' });
        }

        const botId = 'bot_' + Date.now();
        const botPath = path.join(BOTS_DIR, botId);
        fs.mkdirSync(botPath, { recursive: true });

        for (const file of files) {
            if (file.originalname.endsWith('.zip')) {
                const zip = new AdmZip(file.path);
                zip.extractAllTo(botPath, true);
                
                const extractedItems = fs.readdirSync(botPath);
                if (extractedItems.length === 1 && fs.statSync(path.join(botPath, extractedItems[0])).isDirectory()) {
                    const innerDir = path.join(botPath, extractedItems[0]);
                    fs.readdirSync(innerDir).forEach(item => {
                        fs.renameSync(path.join(innerDir, item), path.join(botPath, item));
                    });
                    fs.rmdirSync(innerDir);
                }
            } else {
                fs.renameSync(file.path, path.join(botPath, file.originalname));
            }
            if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        }

        fs.writeFileSync(path.join(botPath, '.env'), `TOKEN=${token}\nDISCORD_TOKEN=${token}\n`);

        if (fs.existsSync(path.join(botPath, 'package.json'))) {
            try {
                execSync('npm install --omit=dev', { cwd: botPath, stdio: 'ignore' });
            } catch (err) {
                console.error('שגיאה בהתקנת חבילות לבוט:', err);
            }
        }

        const newBot = {
            id: botId,
            name,
            token,
            shouldRun: true,
            createdAt: new Date().toISOString()
        };

        const bots = getBots();
        bots.push(newBot);
        saveBots(bots);

        startBotProcess(newBot);
        res.json({ success: true, bot: newBot });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'שגיאה ביצירת הבוט' });
    }
});

// API: הפעלה / כיבוי בוט
app.post('/api/bots/:id/toggle', requireAuth, (req, res) => {
    const bots = getBots();
    const bot = bots.find(b => b.id === req.params.id);
    if (!bot) return res.status(404).json({ error: 'בוט לא נמצא' });

    if (runningProcesses[bot.id]) {
        bot.shouldRun = false;
        saveBots(bots);
        stopBotProcess(bot.id);
    } else {
        bot.shouldRun = true;
        saveBots(bots);
        startBotProcess(bot);
    }
    res.json({ success: true });
});

// API: מחיקת בוט
app.delete('/api/bots/:id', requireAuth, (req, res) => {
    let bots = getBots();
    const botIndex = bots.findIndex(b => b.id === req.params.id);
    if (botIndex === -1) return res.status(404).json({ error: 'בוט לא נמצא' });

    const botId = bots[botIndex].id;
    stopBotProcess(botId);

    const botPath = path.join(BOTS_DIR, botId);
    if (fs.existsSync(botPath)) {
        fs.rmSync(botPath, { recursive: true, force: true });
    }

    bots.splice(botIndex, 1);
    saveBots(bots);
    res.json({ success: true });
});

// הפעלה אוטומטית של בוטים שהוגדרו לפעול בזמן עליית השרת
getBots().forEach(bot => {
    if (bot.shouldRun) startBotProcess(bot);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});