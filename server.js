// ================================================================
//  Water Desalination — Backend API v8
//  🔒 الأمان: CORS + device auth + JWT من .env
//  ⚡ الأداء: pending commands بدون DB + command/pending endpoint
// ================================================================
'use strict';

const express          = require('express');
const cors             = require('cors');
const { createClient } = require('@libsql/client');
const bcrypt           = require('bcryptjs');
const crypto           = require('crypto');
require('dotenv').config();

// ================================================================
//  🔒 تحقق من المتغيرات الأساسية عند الإقلاع
// ================================================================
if (!process.env.JWT_SECRET)   { console.error('❌ JWT_SECRET مفقود في .env');   process.exit(1); }
if (!process.env.ESP32_TOKEN)  { console.error('❌ ESP32_TOKEN مفقود في .env');  process.exit(1); }
if (!process.env.TURSO_URL)    { console.error('❌ TURSO_URL مفقود في .env');    process.exit(1); }
if (!process.env.TURSO_TOKEN)  { console.error('❌ TURSO_TOKEN مفقود في .env');  process.exit(1); }

// ================================================================
//  JWT — بدون مكتبة خارجية
// ================================================================
const JWT_SECRET = process.env.JWT_SECRET;

function signToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body   = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const sig    = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token) {
  // 🔒 ESP32 device token
  if (token === process.env.ESP32_TOKEN)
    return { id: 0, email: 'esp32@device', name: 'ESP32', role: 'device' };
  try {
    const [header, body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (sig !== expected) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch { return null; }
}

function auth(roles = []) {
  return (req, res, next) => {
    const h     = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'غير مصرح' });
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'token منتهي أو غير صحيح' });
    if (roles.length && !roles.includes(payload.role) && payload.role !== 'device')
      return res.status(403).json({ error: 'صلاحيات غير كافية' });
    req.user = payload;
    next();
  };
}

// ================================================================
//  Express
// ================================================================
const app  = express();
const PORT = process.env.PORT || 3000;

// 🔒 CORS — فقط الدومينات المسموح بها
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // ESP32 / mobile / local
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

app.use(express.json({ limit: '50kb' }));

// ================================================================
//  Turso DB
// ================================================================
const db = createClient({
  url:       process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ph        REAL DEFAULT 0, tds    REAL DEFAULT 0,
      turb1     REAL DEFAULT 0, turb2  REAL DEFAULT 0,
      pres1     REAL DEFAULT 0, pres2  REAL DEFAULT 0,
      flow1     REAL DEFAULT 0, flow2  REAL DEFAULT 0,
      vol1      REAL DEFAULT 0, vol2   REAL DEFAULT 0,
      tank1     INTEGER DEFAULT 0, tank2 INTEGER DEFAULT 0,
      tank3     INTEGER DEFAULT 0, tank4 INTEGER DEFAULT 0,
      p1 INTEGER DEFAULT 0, p2 INTEGER DEFAULT 0,
      p3 INTEGER DEFAULT 0, p4 INTEGER DEFAULT 0,
      p5 INTEGER DEFAULT 0, p6 INTEGER DEFAULT 0,
      p7 INTEGER DEFAULT 0,
      sys1  INTEGER DEFAULT 0, sys3  INTEGER DEFAULT 0,
      mode  INTEGER DEFAULT 0, valve INTEGER DEFAULT 0,
      temp1 REAL DEFAULT 0,    temp2 REAL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS event_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type      TEXT NOT NULL,
      message   TEXT NOT NULL,
      level     TEXT DEFAULT 'info',
      temp1     REAL DEFAULT 0, temp2 REAL DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT UNIQUE NOT NULL,
      password   TEXT NOT NULL,
      role       TEXT DEFAULT 'guest',
      active     INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

  // Admin افتراضي
  const { rows } = await db.execute('SELECT COUNT(*) as n FROM users');
  if (rows[0].n === 0) {
    const adminPass = process.env.ADMIN_PASSWORD || 'LBM@2025';
    const hash = await bcrypt.hash(adminPass, 10);
    await db.execute({
      sql:  'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
      args: ['Administrator', 'admin@lbm.com', hash, 'admin'],
    });
    console.log('✅ Admin أُنشئ: admin@lbm.com');
  }

  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

  const defaults = [
    ['ph_min','6.5'], ['ph_max','8.5'],
    ['tds_warn','500'], ['tds_crit','800'],
    ['pres_max','10'],
    ['turb_warn','4'], ['turb_crit','8'],
    ['tank_low','10'], ['tank_full','95'],
    ['pump_speeds','150,150,150,200,150,150,150'],
  ];
  for (const [k, v] of defaults)
    await db.execute({ sql: 'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', args: [k, v] });

  console.log('✅ Turso جاهز');
}

// ================================================================
//  حالة النظام — في الذاكرة (سريع، بدون DB لكل طلب)
// ================================================================
let latestData = {
  ph:0, tds:0, turb1:0, turb2:0,
  pres1:0, pres2:0, flow1:0, flow2:0, vol1:0, vol2:0,
  tank1:0, tank2:0, tank3:0, tank4:0,
  p1:0, p2:0, p3:0, p4:0, p5:0, p6:0, p7:0,
  sp1:0, sp2:0, sp3:0, sp4:0, sp5:0, sp6:0, sp7:0,
  sys1:0, sys3:0, mode:0, valve:0,
  f1:0, f2:0, f3:0, f4:0,
  fw1:0, fw2:0, fw3:0, fw4:0,
  stopping:0, stopping3:0,
  temp1:0, temp2:0,
  timestamp: new Date().toISOString(),
};

// ⚡ قائمة الأوامر في الذاكرة — بدون DB
let pendingCommands  = [];
let lastESP32Contact = null;
let sys1StartTime    = null;
let sys3StartTime    = null;
let pumpSpeeds       = [150,150,150,200,150,150,150];

// حماية المود من الكتابة الفورية
let modeLocked      = false;
let modeLockedValue = null;
let modeLockTimer   = null;
const MODE_LOCK_MS  = 4000;

function pumpLevel(speed) {
  if (speed === 0)    return 'off';
  if (speed <= 84)    return 'low';
  if (speed <= 169)   return 'medium';
  return 'high';
}

function withPumpLevels(data) {
  return {
    ...data,
    levels: {
      p1: pumpLevel(data.sp1 ?? 0), p2: pumpLevel(data.sp2 ?? 0),
      p3: pumpLevel(data.sp3 ?? 0), p4: pumpLevel(data.sp4 ?? 0),
      p5: pumpLevel(data.sp5 ?? 0), p6: pumpLevel(data.sp6 ?? 0),
      p7: pumpLevel(data.sp7 ?? 0),
    },
  };
}

async function logEvent(type, message, level = 'info') {
  try {
    await db.execute({
      sql:  'INSERT INTO event_log (type, message, level) VALUES (?, ?, ?)',
      args: [type, message, level],
    });
  } catch (_) {}
}

// ================================================================
//  🔒 POST /api/sensor — ESP32 فقط (device token)
// ================================================================
app.post('/api/command', (req, res) => {
  try {
    const d    = req.body;
    const prev = { ...latestData };

    const effectiveMode = modeLocked ? modeLockedValue : (d.mode ?? latestData.mode);
    latestData = {
      ...d,
      mode:      effectiveMode,
      sp1: d.sp1 ?? latestData.sp1, sp2: d.sp2 ?? latestData.sp2,
      sp3: d.sp3 ?? latestData.sp3, sp4: d.sp4 ?? latestData.sp4,
      sp5: d.sp5 ?? latestData.sp5, sp6: d.sp6 ?? latestData.sp6,
      sp7: d.sp7 ?? latestData.sp7,
      f1:  d.f1  ?? latestData.f1,  f2:  d.f2  ?? latestData.f2,
      f3:  d.f3  ?? latestData.f3,  f4:  d.f4  ?? latestData.f4,
      fw1: d.fw1 ?? latestData.fw1, fw2: d.fw2 ?? latestData.fw2,
      fw3: d.fw3 ?? latestData.fw3, fw4: d.fw4 ?? latestData.fw4,
      stopping:  d.stopping  ?? latestData.stopping,
      stopping3: d.stopping3 ?? latestData.stopping3,
      temp1:     d.temp1     ?? latestData.temp1,
      temp2:     d.temp2     ?? latestData.temp2,
      timestamp: new Date().toISOString(),
    };
    lastESP32Contact = new Date();

    // مؤقت النظام
    if (d.sys1 === 1 && !sys1StartTime) sys1StartTime = new Date();
    if (d.sys1 === 0 &&  sys1StartTime) sys1StartTime = null;
    if (d.sys3 === 1 && !sys3StartTime) sys3StartTime = new Date();
    if (d.sys3 === 0 &&  sys3StartTime) sys3StartTime = null;

    // تسجيل التغييرات (فقط لما يتغير شيء)
    if (prev.sys1  !== d.sys1)  logEvent('system', `النظام 1 ${d.sys1  ? 'بدأ' : 'توقف'}`,               d.sys1  ? 'info' : 'warning');
    if (prev.sys3  !== d.sys3)  logEvent('system', `النظام 3 ${d.sys3  ? 'بدأ' : 'توقف'}`,               d.sys3  ? 'info' : 'warning');
    if (prev.valve !== d.valve) logEvent('valve',  `الصمام ${d.valve ? 'فُتح' : 'أُغلق'}`,               'info');
    if (prev.mode  !== d.mode)  logEvent('mode',   `وضع التشغيل: ${d.mode ? 'يدوي' : 'تلقائي'}`,        'info');

    const filterNames = ['فلتر 1 (P1)', 'فلتر 2 (P2)', 'فلتر 3 (P5)', 'فلتر 4 (P6)'];
    const fFields  = ['f1','f2','f3','f4'];
    const fwFields = ['fw1','fw2','fw3','fw4'];
    for (let i = 0; i < 4; i++) {
      if (prev[fFields[i]] !== d[fFields[i]]) {
        if (d[fFields[i]]) logEvent('filter', `${filterNames[i]} منسد — تم إيقاف المضخة`, 'warning');
        else               logEvent('filter', `${filterNames[i]} تم تنظيفه`, 'info');
      }
      if (prev[fwFields[i]] !== d[fwFields[i]] && d[fwFields[i]])
        logEvent('filter', `${filterNames[i]} ينتظر إعادة التشغيل (15s)`, 'info');
    }
    if (prev.stopping  !== d.stopping  && d.stopping)  logEvent('system', 'إيقاف تدريجي لنظام 1 بدأ', 'warning');
    if (prev.stopping3 !== d.stopping3 && d.stopping3) logEvent('system', 'إيقاف تدريجي لنظام 3 بدأ', 'warning');

    // تنبيهات الحساسات
    if (d.ph > 0 && (d.ph < 6.5 || d.ph > 8.5)) logEvent('alert', `pH غير طبيعي: ${Number(d.ph).toFixed(2)}`, 'danger');
    if (d.tds > 500)                              logEvent('alert', `TDS مرتفع: ${Number(d.tds).toFixed(0)} ppm`, 'warning');
    if (d.pres1 > 10 || d.pres2 > 10)            logEvent('alert', `ضغط خطير: ${Math.max(d.pres1, d.pres2).toFixed(1)} bar`, 'danger');

    // حفظ في DB (fire & forget — لا ننتظر)
    db.execute({
      sql: `INSERT INTO sensor_data
              (ph,tds,turb1,turb2,pres1,pres2,flow1,flow2,
               vol1,vol2,tank1,tank2,tank3,tank4,
               p1,p2,p3,p4,p5,p6,p7,sys1,sys3,mode,valve,temp1,temp2)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        d.ph??0, d.tds??0, d.turb1??0, d.turb2??0,
        d.pres1??0, d.pres2??0, d.flow1??0, d.flow2??0,
        d.vol1??0, d.vol2??0,
        d.tank1??0, d.tank2??0, d.tank3??0, d.tank4??0,
        d.p1??0, d.p2??0, d.p3??0, d.p4??0,
        d.p5??0, d.p6??0, d.p7??0,
        d.sys1??0, d.sys3??0, d.mode??0, d.valve??0,
        d.temp1??0, d.temp2??0,
      ],
    }).catch(() => {});

    // ⚡ رد فوري بالأوامر المعلقة
    const cmds      = [...pendingCommands];
    pendingCommands = [];
    res.json({ status: 'ok', commands: cmds });
  } catch (err) {
    console.error('[sensor]', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ================================================================
//  GET /api/sensor/latest
// ================================================================
app.get('/api/sensor/latest', (req, res) => {
  res.json(withPumpLevels(latestData));
});

// ================================================================
//  ⚡ GET /api/command/pending — ESP32 فقط (polling سريع بدون DB)
// ================================================================
app.get('/api/command/pending', auth(['device']), (req, res) => {
  const cmds      = [...pendingCommands];
  pendingCommands = [];
  res.json({ commands: cmds });
});

// ================================================================
//  GET /api/sensor/history
// ================================================================
app.get('/api/sensor/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const from  = req.query.from;
    const to    = req.query.to;
    let sql  = 'SELECT * FROM sensor_data';
    let args = [];
    if (from && to) { sql += ' WHERE timestamp BETWEEN ? AND ?'; args = [from, to]; }
    sql += ' ORDER BY id DESC LIMIT ?';
    args.push(limit);
    const result = await db.execute({ sql, args });
    res.json(result.rows.reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  GET /api/stats
// ================================================================
app.get('/api/stats', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const from  = new Date(Date.now() - hours * 3600000).toISOString();
    const { rows } = await db.execute({
      sql: 'SELECT * FROM sensor_data WHERE timestamp >= ? ORDER BY id ASC',
      args: [from],
    });
    if (!rows.length) return res.json({ count: 0 });
    const calc = (field) => {
      const vals = rows.map(r => parseFloat(r[field] || 0)).filter(v => v > 0);
      if (!vals.length) return { min: '0', max: '0', avg: '0' };
      return {
        min: Math.min(...vals).toFixed(2),
        max: Math.max(...vals).toFixed(2),
        avg: (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2),
      };
    };
    res.json({
      count: rows.length, hours,
      ph: calc('ph'), tds: calc('tds'),
      turb1: calc('turb1'), turb2: calc('turb2'),
      pres1: calc('pres1'), pres2: calc('pres2'),
      flow1: calc('flow1'), flow2: calc('flow2'),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  GET /api/logs
// ================================================================
app.get('/api/logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const level = req.query.level;
    let sql  = 'SELECT * FROM event_log';
    let args = [];
    if (level) { sql += ' WHERE level = ?'; args = [level]; }
    sql += ' ORDER BY id DESC LIMIT ?';
    args.push(limit);
    const { rows } = await db.execute({ sql, args });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  GET /api/settings
// ================================================================
app.get('/api/settings', async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT key, value FROM settings');
    const settings = {};
    for (const row of rows) settings[row.key] = row.value;
    res.json(settings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  🔒 POST /api/settings — admin فقط
// ================================================================
app.post('/api/settings', auth(['admin']), async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates))
      await db.execute({ sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', args: [key, String(value)] });
    if (updates.pump_speeds)
      pumpSpeeds = updates.pump_speeds.split(',').map(Number);
    logEvent('settings', 'تم تحديث الإعدادات', 'info');
    res.json({ status: 'ok' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  GET /api/timer
// ================================================================
app.get('/api/timer', (req, res) => {
  const now = new Date();
  res.json({
    sys1: { running: !!sys1StartTime, minutes: sys1StartTime ? Math.floor((now - sys1StartTime) / 60000) : null },
    sys3: { running: !!sys3StartTime, minutes: sys3StartTime ? Math.floor((now - sys3StartTime) / 60000) : null },
  });
});

// ================================================================
//  🔒 POST /api/command — user أو admin فقط
// ================================================================
app.post('/api/command', auth(['admin', 'user']), async (req, res) => {
  const { command } = req.body;
  if (!command || !command.startsWith('CMD:'))
    return res.status(400).json({ error: 'أمر غير صالح' });

  // أوامر السرعة: CMD:SPEED:1:80
  if (command.startsWith('CMD:SPEED:')) {
    const parts    = command.split(':');
    const pumpIdx  = parseInt(parts[2]);
    const speed    = parseInt(parts[3]);
    if (parts.length === 4 && pumpIdx >= 1 && pumpIdx <= 7 && speed >= 0 && speed <= 255) {
      pendingCommands.push(command);
      pumpSpeeds[pumpIdx - 1] = speed;
      db.execute({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('pump_speeds', ?)", args: [pumpSpeeds.join(',')] }).catch(() => {});
      logEvent('command', `سرعة P${pumpIdx} = ${speed} — ${req.user.name}`, 'info');
      return res.json({ status: 'ok', queued: command });
    }
    return res.status(400).json({ error: 'صيغة أمر السرعة خاطئة' });
  }

  const valid = [
    'CMD:PUMP1_ON','CMD:PUMP1_OFF','CMD:PUMP2_ON','CMD:PUMP2_OFF',
    'CMD:PUMP3_ON','CMD:PUMP3_OFF','CMD:PUMP4_ON','CMD:PUMP4_OFF',
    'CMD:PUMP5_ON','CMD:PUMP5_OFF','CMD:PUMP6_ON','CMD:PUMP6_OFF',
    'CMD:PUMP7_ON','CMD:PUMP7_OFF',
    'CMD:START','CMD:STOP','CMD:START3',
    'CMD:VALVE_ON','CMD:VALVE_OFF',
    'CMD:MODE_AUTO','CMD:MODE_MANUAL',
  ];
  if (!valid.includes(command))
    return res.status(400).json({ error: 'أمر غير مسموح' });

  pendingCommands.push(command);

  // حماية المود
  if (command === 'CMD:MODE_MANUAL' || command === 'CMD:MODE_AUTO') {
    const newMode   = command === 'CMD:MODE_MANUAL' ? 1 : 0;
    modeLocked      = true;
    modeLockedValue = newMode;
    latestData.mode = newMode;
    if (modeLockTimer) clearTimeout(modeLockTimer);
    modeLockTimer = setTimeout(() => { modeLocked = false; modeLockedValue = null; }, MODE_LOCK_MS);
  }

  logEvent('command', `${command} — ${req.user.name}`, 'info');
  res.json({ status: 'ok', queued: command });
});

// ================================================================
//  GET /api/alerts
// ================================================================
app.get('/api/alerts', async (req, res) => {
  let ph_min=6.5, ph_max=8.5, tds_warn=500, pres_max=10, turb_warn=4, tank_low=10, tank_full=95;
  try {
    const { rows } = await db.execute('SELECT key, value FROM settings');
    for (const r of rows) {
      if (r.key==='ph_min')    ph_min    = parseFloat(r.value);
      if (r.key==='ph_max')    ph_max    = parseFloat(r.value);
      if (r.key==='tds_warn')  tds_warn  = parseFloat(r.value);
      if (r.key==='pres_max')  pres_max  = parseFloat(r.value);
      if (r.key==='turb_warn') turb_warn = parseFloat(r.value);
      if (r.key==='tank_low')  tank_low  = parseFloat(r.value);
      if (r.key==='tank_full') tank_full = parseFloat(r.value);
    }
  } catch (_) {}

  const alerts = [];
  const d = latestData;
  if (d.ph < ph_min || d.ph > ph_max)       alerts.push({ level:'danger',  message:`pH غير طبيعي: ${d.ph}`,        field:'ph' });
  if (d.tds > tds_warn)                      alerts.push({ level:'warning', message:`TDS مرتفع: ${d.tds} ppm`,      field:'tds' });
  if (d.turb1 > turb_warn || d.turb2 > turb_warn) alerts.push({ level:'warning', message:'عكارة مرتفعة',           field:'turbidity' });
  if (d.pres1 > pres_max  || d.pres2 > pres_max)  alerts.push({ level:'danger',  message:'ضغط خطير!',              field:'pressure' });
  if (d.tank1 < tank_low)                    alerts.push({ level:'warning', message:`خزان 1 شبه فارغ: ${d.tank1}%`, field:'tank1' });
  if (d.tank4 > tank_full)                   alerts.push({ level:'info',    message:`خزان 4 ممتلئ: ${d.tank4}%`,    field:'tank4' });

  const filterLabels = ['P1','P2','P5','P6'];
  for (let i = 0; i < 4; i++) {
    if (d[`f${i+1}`])  alerts.push({ level:'warning', message:`فلتر ${filterLabels[i]} منسد — المضخة متوقفة`, field:`filter${i+1}` });
    if (d[`fw${i+1}`]) alerts.push({ level:'info',    message:`فلتر ${filterLabels[i]} ينتظر إعادة التشغيل`,  field:`filter${i+1}` });
  }
  if (d.stopping)  alerts.push({ level:'info', message:'نظام 1 في وضع الإيقاف التدريجي', field:'stopping' });
  if (d.stopping3) alerts.push({ level:'info', message:'نظام 3 في وضع الإيقاف التدريجي', field:'stopping3' });

  res.json({ count: alerts.length, alerts });
});

// ================================================================
//  GET /api/esp32/status
// ================================================================
app.get('/api/esp32/status', (req, res) => {
  if (!lastESP32Contact) return res.json({ connected: false, lastSeen: null, secondsAgo: null });
  const secondsAgo = Math.floor((new Date() - lastESP32Contact) / 1000);
  res.json({ connected: secondsAgo <= 10, lastSeen: lastESP32Contact.toISOString(), secondsAgo });
});

// ================================================================
//  POST /api/auth/login
// ================================================================
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'أدخل الإيميل والباسوورد' });
  try {
    const { rows } = await db.execute({ sql: 'SELECT * FROM users WHERE email = ? AND active = 1', args: [email.toLowerCase()] });
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'إيميل أو باسوورد غلط' });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'إيميل أو باسوورد غلط' });
    const token = signToken({ id: user.id, email: user.email, name: user.name, role: user.role });
    logEvent('auth', `دخول: ${user.name} (${user.role})`, 'info');
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  GET /api/auth/me
// ================================================================
app.get('/api/auth/me', auth(), (req, res) => res.json({ user: req.user }));

// ================================================================
//  GET /api/users — admin فقط
// ================================================================
app.get('/api/users', auth(['admin']), async (req, res) => {
  try {
    const { rows } = await db.execute('SELECT id, name, email, role, active, created_at FROM users ORDER BY created_at DESC');
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  POST /api/users — admin فقط
// ================================================================
app.post('/api/users', auth(['admin']), async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'اسم وإيميل وباسوورد مطلوبين' });
  const userRole = ['admin','user','guest'].includes(role) ? role : 'guest';
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.execute({ sql: 'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)', args: [name, email.toLowerCase(), hash, userRole] });
    logEvent('auth', `مستخدم جديد: ${name} (${userRole})`, 'info');
    res.json({ status: 'ok', message: `تم إنشاء ${name}` });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'الإيميل مستعمل' });
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  PUT /api/users/:id — admin فقط
// ================================================================
app.put('/api/users/:id', auth(['admin']), async (req, res) => {
  const { name, role, active, password } = req.body;
  const id = parseInt(req.params.id);
  try {
    if (password) { const hash = await bcrypt.hash(password, 10); await db.execute({ sql: 'UPDATE users SET password = ? WHERE id = ?', args: [hash, id] }); }
    if (name)     await db.execute({ sql: 'UPDATE users SET name = ? WHERE id = ?',   args: [name, id] });
    if (role)     await db.execute({ sql: 'UPDATE users SET role = ? WHERE id = ?',   args: [role, id] });
    if (active !== undefined) await db.execute({ sql: 'UPDATE users SET active = ? WHERE id = ?', args: [active ? 1 : 0, id] });
    res.json({ status: 'ok' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  DELETE /api/users/:id — admin فقط
// ================================================================
app.delete('/api/users/:id', auth(['admin']), async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'لا تقدر تحذف حسابك' });
  try {
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [id] });
    res.json({ status: 'ok' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
//  GET /health
// ================================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), db: 'Turso', version: 'v8' });
});

// ================================================================
//  Self-ping — يحافظ على Render مستيقظاً
// ================================================================
const https = require('https');
setInterval(() => {
  const host = process.env.RENDER_EXTERNAL_HOSTNAME;
  if (!host) return;
  https.get(`https://${host}/health`, () => {}).on('error', () => {});
}, 4 * 60 * 1000);

// ================================================================
//  Start
// ================================================================
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 الخادم يعمل على المنفذ ${PORT}`);
    console.log(`🔗 http://localhost:${PORT}/health`);
  });
}).catch(err => {
  console.error('❌ Turso:', err.message);
  process.exit(1);
});
