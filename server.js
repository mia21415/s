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

const upload = multer({ dest: 'uploads/' });

// ניהול בוטים (תומך בריבוי בוטים ללא הגבלה)
const BOTS_FILE = path.join(__dirname, 'bots.json');
let activeProcesses = {};

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

// התחברות לפאנל
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'mia' && password === '2234') {
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'שם משתמש או סיסמה שגויים' });
    }
});

// הגנה על הדשבורד
app.use('/dashboard.html', (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.redirect('/login.html');
    }
});

// קבלת רשימת הבוטים
app.get('/api/bots', (req, res) => {
    const bots = getBots();
    res.json(bots);
});

// העלאת והרצת בוט חדש
app.post('/api/bots/upload', upload.single('file'), (req, res) => {
    try {
        const { name, token } = req.body;
        const file = req.file;
        if (!file || !name || !token) {
            return res.json({ success: false, message: 'נא למלא את כל השדות' });
        }

        const botId = 'bot_' + Date.now();
        const botFolder = path.join(__dirname, 'extracted_bots', botId);
        fs.mkdirSync(botFolder, { recursive: true });

        // חילוץ קובץ ה-ZIP
        const zip = new AdmZip(file.path);
        zip.extractAllTo(botFolder, true);
        fs.unlinkSync(file.path);

        // מציאת קובץ ההפעלה הראשי
        let mainFile = 'index.js';
        const packageJsonPath = path.join(botFolder, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath));
            if (pkg.main) mainFile = pkg.main;
        }

        // שמירת הבוט ברשימה
        const bots = getBots();
        bots.push({ id: botId, name, folder: botFolder, mainFile, token });
        saveBots(bots);

        // הרצת הבוט ברקע עם העברת הטוקן
        startBotProcess(botId, botFolder, mainFile, token);

        res.json({ success: true });
    } catch (err) {
        console.log(err);
        res.json({ success: false, message: 'שגיאה בחילוץ או בהרצת הבוט' });
    }
});

// פונקציה להפעלת תהליך הבוט
function startBotProcess(id, folder, mainFile, token) {
    const env = { ...process.env, DISCORD_TOKEN: token, TOKEN: token };
    const child = spawn('node', [mainFile], { cwd: folder, env });
    
    activeProcesses[id] = child;

    child.stdout.on('data', (data) => console.log(`[Bot ${id}]: ${data}`));
    child.stderr.on('data', (data) => console.error(`[Bot ${id} Error]: ${data}`));
    
    child.on('close', (code) => {
        console.log(`Bot ${id} exited with code ${code}`);
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
        // מחיקת התיקייה
        try {
            fs.rmSync(bot.folder, { recursive: true, force: true });
        } catch (e) {}

        bots = bots.filter(b => b.id !== botId);
        saveBots(bots);
    }

    res.json({ success: true });
});

// הפעלת הבוטים הקיימים בעליית השרת מחדש
function restoreBots() {
    const bots = getBots();
    bots.forEach(bot => {
        if (fs.existsSync(bot.folder)) {
            startBotProcess(bot.id, bot.folder, bot.mainFile, bot.token);
        }
    });
}

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    restoreBots();
});
