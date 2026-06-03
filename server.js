// ================================================================
//  Water Desalination — Backend API v5
//  Node.js + Express + Turso (LibSQL)
//  ✅ v4: أوامر السرعة CMD:SPEED:X:Y
//  ✅ v5 FIX: Mode Lock — يمنع الـ JSON من الـ Mega من الكتابة فوق
//            المود المطلوب بعد CMD:MODE_X لمدة 4 ثواني
// ================================================================

const express          = require('express');
const cors             = require('cors');
const { createClient } = require('@libsql/client');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ================================================================
//  Turso
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
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS event_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type      TEXT NOT NULL,
      message   TEXT NOT NULL,
      level     TEXT DEFAULT 'info',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const defaults = [
    ['ph_min',    '6.5'],  ['ph_max',   '8.5'],
    ['tds_warn',  '500'],  ['tds_crit', '800'],
    ['pres_max',  '10'],
    ['turb_warn', '4'],    ['turb_crit','8'],
    ['tank_low',  '10'],   ['tank_full','95'],
    ['pump_speeds', '150,150,150,200,150,150,150'],
  ];
  for (const [k, v] of defaults) {
    await db.execute({
      sql:  `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
      args: [k, v]
    });
  }
  console.log('✅ Turso جاهز');
}

// ================================================================
//  حالة النظام
// ================================================================
let latestData = {
  ph:0, tds:0, turb1:0, turb2:0,
  pres1:0, pres2:0, flow1:0, flow2:0, vol1:0, vol2:0,
  tank1:0, tank2:0, tank3:0, tank4:0,
  p1:0, p2:0, p3:0, p4:0, p5:0, p6:0, p7:0,
  sys1:0, sys3:0, mode:0, valve:0,
  timestamp: new Date().toISOString()
};

let pendingCommands  = [];
let lastESP32Contact = null;
let sys1StartTime    = null;
let sys3StartTime    = null;
let pumpSpeeds       = [150,150,150,200,150,150,150];

// ✅ v5 FIX: حماية المود من الكتابة الفورية
// لما يجي أمر CMD:MODE_X، نحفظ المود المطلوب ونتجاهل
// قيمة "mode" اللي تجي من الـ Mega لمدة MODE_LOCK_MS
let modeLocked     = false;   // هل المود محمي؟
let modeLockedValue = null;   // القيمة المحمية (0=auto, 1=manual)
let modeLockTimer  = null;    // Timer لإلغاء الحماية
const MODE_LOCK_MS = 4000;    // 4 ثواني — أكثر من SEND_INTERVAL (1s) × 3

// ================================================================
//  تسجيل الأحداث
// ================================================================
async function logEvent(type, message, level = 'info') {
  try {
    await db.execute({
      sql:  `INSERT INTO event_log (type, message, level) VALUES (?, ?, ?)`,
      args: [type, message, level]
    });
  } catch (_) {}
}

// ================================================================
//  POST /api/sensor
// ================================================================
app.post('/api/sensor', async (req, res) => {
  try {
    const d    = req.body;
    const prev = { ...latestData };

    // ✅ v5 FIX: إذا المود محمي، احتفظ بالقيمة المحمية ولا تكتب قيمة الـ Mega
    const effectiveMode = modeLocked ? modeLockedValue : (d.mode ?? latestData.mode);
    latestData = { ...d, mode: effectiveMode, timestamp: new Date().toISOString() };
    lastESP32Contact = new Date();

    // مؤقت النظام
    if (d.sys1 === 1 && !sys1StartTime) sys1StartTime = new Date();
    if (d.sys1 === 0 && sys1StartTime)  sys1StartTime = null;
    if (d.sys3 === 1 && !sys3StartTime) sys3StartTime = new Date();
    if (d.sys3 === 0 && sys3StartTime)  sys3StartTime = null;

    // تسجيل التغييرات
    if (prev.sys1  !== d.sys1)  await logEvent('system',  `النظام 1 ${d.sys1  ? 'بدأ' : 'توقف'}`, d.sys1  ? 'info' : 'warning');
    if (prev.sys3  !== d.sys3)  await logEvent('system',  `النظام 3 ${d.sys3  ? 'بدأ' : 'توقف'}`, d.sys3  ? 'info' : 'warning');
    if (prev.valve !== d.valve) await logEvent('valve',   `الصمام ${d.valve ? 'فُتح' : 'أُغلق'}`,  'info');
    if (prev.mode  !== d.mode)  await logEvent('mode',    `وضع التشغيل: ${d.mode ? 'يدوي' : 'تلقائي'}`, 'info');

    // تنبيهات الحساسات
    if (d.ph > 0 && (d.ph < 6.5 || d.ph > 8.5))
      await logEvent('alert', `pH غير طبيعي: ${Number(d.ph).toFixed(2)}`, 'danger');
    if (d.tds > 500)
      await logEvent('alert', `TDS مرتفع: ${Number(d.tds).toFixed(0)} ppm`, 'warning');
    if (d.pres1 > 10 || d.pres2 > 10)
      await logEvent('alert', `ضغط خطير: ${Math.max(d.pres1, d.pres2).toFixed(1)} bar`, 'danger');

    await db.execute({
      sql: `INSERT INTO sensor_data
              (ph,tds,turb1,turb2,pres1,pres2,flow1,flow2,
               vol1,vol2,tank1,tank2,tank3,tank4,
               p1,p2,p3,p4,p5,p6,p7,sys1,sys3,mode,valve)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        d.ph??0,    d.tds??0,   d.turb1??0, d.turb2??0,
        d.pres1??0, d.pres2??0, d.flow1??0, d.flow2??0,
        d.vol1??0,  d.vol2??0,
        d.tank1??0, d.tank2??0, d.tank3??0, d.tank4??0,
        d.p1??0, d.p2??0, d.p3??0, d.p4??0,
        d.p5??0, d.p6??0, d.p7??0,
        d.sys1??0,  d.sys3??0,  d.mode??0,  d.valve??0,
      ]
    });

    const cmds      = [...pendingCommands];
    pendingCommands = [];
    console.log(`[ESP32 ✓] ph=${d.ph} tds=${d.tds} sys1=${d.sys1} mode=${d.mode}`);
    res.json({ status: 'ok', commands: cmds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ================================================================
//  GET /api/sensor/latest
// ================================================================
app.get('/api/sensor/latest', (req, res) => res.json(latestData));

// ================================================================
//  GET /api/sensor/history
// ================================================================
app.get('/api/sensor/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const from  = req.query.from;
    const to    = req.query.to;
    let sql  = 'SELECT * FROM sensor_data';
    let args = [];
    if (from && to) { sql += ' WHERE timestamp BETWEEN ? AND ?'; args = [from, to]; }
    sql += ' ORDER BY id DESC LIMIT ?';
    args.push(limit);
    const result = await db.execute({ sql, args });
    res.json(result.rows.reverse());
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ================================================================
//  GET /api/stats
// ================================================================
app.get('/api/stats', async (req, res) => {
  try {
    const hours  = parseInt(req.query.hours) || 24;
    const from   = new Date(Date.now() - hours * 3600000).toISOString();
    const result = await db.execute({
      sql:  `SELECT * FROM sensor_data WHERE timestamp >= ? ORDER BY id ASC`,
      args: [from]
    });
    const rows = result.rows;
    if (rows.length === 0) return res.json({ count: 0 });
    const calc = (field) => {
      const vals = rows.map(r => parseFloat(r[field] || 0)).filter(v => v > 0);
      if (!vals.length) return { min:'0', max:'0', avg:'0' };
      return {
        min: Math.min(...vals).toFixed(2),
        max: Math.max(...vals).toFixed(2),
        avg: (vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2),
      };
    };
    res.json({
      count: rows.length, hours,
      ph:    calc('ph'),  tds:   calc('tds'),
      turb1: calc('turb1'), turb2: calc('turb2'),
      pres1: calc('pres1'), pres2: calc('pres2'),
      flow1: calc('flow1'), flow2: calc('flow2'),
    });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ================================================================
//  GET /api/logs
// ================================================================
app.get('/api/logs', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const level = req.query.level;
    let sql = 'SELECT * FROM event_log';
    let args = [];
    if (level) { sql += ' WHERE level = ?'; args = [level]; }
    sql += ' ORDER BY id DESC LIMIT ?';
    args.push(limit);
    const result = await db.execute({ sql, args });
    res.json(result.rows);
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ================================================================
//  GET/POST /api/settings
// ================================================================
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.execute('SELECT key, value FROM settings');
    const settings = {};
    for (const row of result.rows) settings[row.key] = row.value;
    res.json(settings);
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

app.post('/api/settings', async (req, res) => {
  try {
    const updates = req.body;
    for (const [key, value] of Object.entries(updates)) {
      await db.execute({
        sql:  `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
        args: [key, String(value)]
      });
    }
    if (updates.pump_speeds) {
      pumpSpeeds = updates.pump_speeds.split(',').map(Number);
    }
    await logEvent('settings', 'تم تحديث الإعدادات', 'info');
    res.json({ status: 'ok' });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
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
//  POST /api/command ✅ مع دعم CMD:SPEED:X:Y
// ================================================================
app.post('/api/command', async (req, res) => {
  const { command } = req.body;

  if (!command || !command.startsWith('CMD:')) {
    return res.status(400).json({ status: 'error', message: 'أمر غير صالح' });
  }

  // ✅ أوامر السرعة — CMD:SPEED:1:80
  if (command.startsWith('CMD:SPEED:')) {
    const parts = command.split(':');
    if (parts.length === 4) {
      const pumpIdx = parseInt(parts[2]);
      const speed   = parseInt(parts[3]);
      if (pumpIdx >= 1 && pumpIdx <= 7 && speed >= 0 && speed <= 255) {
        pendingCommands.push(command);
        // تحديث الـ settings
        if (pumpIdx >= 1 && pumpIdx <= 7) {
          pumpSpeeds[pumpIdx - 1] = speed;
          const newSpeeds = pumpSpeeds.join(',');
          await db.execute({
            sql:  `INSERT OR REPLACE INTO settings (key, value) VALUES ('pump_speeds', ?)`,
            args: [newSpeeds]
          });
        }
        await logEvent('command', `سرعة P${pumpIdx} = ${speed}`, 'info');
        console.log(`[SPEED] P${pumpIdx} = ${speed}`);
        return res.json({ status: 'ok', queued: command });
      }
    }
    return res.status(400).json({ status: 'error', message: 'صيغة أمر السرعة خاطئة' });
  }

  // ✅ الأوامر العادية
  const valid = [
    'CMD:PUMP1_ON',  'CMD:PUMP1_OFF', 'CMD:PUMP2_ON',  'CMD:PUMP2_OFF',
    'CMD:PUMP3_ON',  'CMD:PUMP3_OFF', 'CMD:PUMP4_ON',  'CMD:PUMP4_OFF',
    'CMD:PUMP5_ON',  'CMD:PUMP5_OFF', 'CMD:PUMP6_ON',  'CMD:PUMP6_OFF',
    'CMD:PUMP7_ON',  'CMD:PUMP7_OFF',
    'CMD:START',     'CMD:STOP',      'CMD:START3',
    'CMD:VALVE_ON',  'CMD:VALVE_OFF',
    'CMD:MODE_AUTO', 'CMD:MODE_MANUAL',
  ];

  if (!valid.includes(command)) {
    return res.status(400).json({ status: 'error', message: 'أمر غير صالح' });
  }

  pendingCommands.push(command);

  // ✅ v5 FIX: لما يجي أمر تبديل المود — قفل المود فوراً
  if (command === 'CMD:MODE_MANUAL' || command === 'CMD:MODE_AUTO') {
    const newMode = command === 'CMD:MODE_MANUAL' ? 1 : 0;
    modeLocked      = true;
    modeLockedValue = newMode;
    latestData.mode = newMode;   // حدّث الـ latestData فوراً باش التطبيق يشوفه في أول GET
    if (modeLockTimer) clearTimeout(modeLockTimer);
    modeLockTimer = setTimeout(() => {
      modeLocked      = false;
      modeLockedValue = null;
      console.log(`[MODE LOCK] انتهت الحماية — المود الآن حسب الـ Mega`);
    }, MODE_LOCK_MS);
    console.log(`[MODE LOCK] مود مقفول على ${newMode} لـ ${MODE_LOCK_MS}ms`);
  }

  await logEvent('command', `أمر: ${command}`, 'info');
  console.log(`[CMD] ${command}`);
  res.json({ status: 'ok', queued: command });
});

// ================================================================
//  GET /api/alerts
// ================================================================
app.get('/api/alerts', async (req, res) => {
  let ph_min=6.5, ph_max=8.5, tds_warn=500, pres_max=10, turb_warn=4, tank_low=10, tank_full=95;
  try {
    const result = await db.execute('SELECT key, value FROM settings');
    for (const row of result.rows) {
      if (row.key==='ph_min')    ph_min    = parseFloat(row.value);
      if (row.key==='ph_max')    ph_max    = parseFloat(row.value);
      if (row.key==='tds_warn')  tds_warn  = parseFloat(row.value);
      if (row.key==='pres_max')  pres_max  = parseFloat(row.value);
      if (row.key==='turb_warn') turb_warn = parseFloat(row.value);
      if (row.key==='tank_low')  tank_low  = parseFloat(row.value);
      if (row.key==='tank_full') tank_full = parseFloat(row.value);
    }
  } catch (_) {}

  const alerts = [];
  const d = latestData;
  if (d.ph < ph_min || d.ph > ph_max)
    alerts.push({ level:'danger',  message:`pH غير طبيعي: ${d.ph}`,        field:'ph' });
  if (d.tds > tds_warn)
    alerts.push({ level:'warning', message:`TDS مرتفع: ${d.tds} ppm`,      field:'tds' });
  if (d.turb1 > turb_warn || d.turb2 > turb_warn)
    alerts.push({ level:'warning', message:'عكارة مرتفعة',                  field:'turbidity' });
  if (d.pres1 > pres_max || d.pres2 > pres_max)
    alerts.push({ level:'danger',  message:'ضغط خطير!',                    field:'pressure' });
  if (d.tank1 < tank_low)
    alerts.push({ level:'warning', message:`خزان 1 شبه فارغ: ${d.tank1}%`, field:'tank1' });
  if (d.tank4 > tank_full)
    alerts.push({ level:'info',    message:`خزان 4 ممتلئ: ${d.tank4}%`,    field:'tank4' });

  res.json({ count: alerts.length, alerts });
});

// ================================================================
//  GET /api/esp32/status
// ================================================================
app.get('/api/esp32/status', (req, res) => {
  if (!lastESP32Contact)
    return res.json({ connected: false, lastSeen: null, secondsAgo: null });
  const secondsAgo = Math.floor((new Date() - lastESP32Contact) / 1000);
  res.json({ connected: secondsAgo <= 10, lastSeen: lastESP32Contact.toISOString(), secondsAgo });
});

// ================================================================
//  GET /health
// ================================================================
app.get('/health', (req, res) => {
  res.json({ status:'ok', uptime: process.uptime(), db:'Turso', version:'v4' });
});

// ================================================================
//  Self-ping
// ================================================================
const https = require('https');
setInterval(() => {
  const host = process.env.RENDER_EXTERNAL_HOSTNAME;
  if (!host) return;
  https.get(`https://${host}/health`, () => console.log('[PING] alive ✓'))
       .on('error', () => {});
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
