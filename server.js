// ================================================================
//  Water Desalination — Backend API
//  Node.js + Express + Turso (LibSQL)
// ================================================================

const express      = require('express');
const cors         = require('cors');
const { createClient } = require('@libsql/client');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ================================================================
//  Turso — اتصال قاعدة البيانات
// ================================================================
const db = createClient({
  url:       process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

// إنشاء الجدول إذا ما كانش موجود
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ph        REAL    DEFAULT 0,
      tds       REAL    DEFAULT 0,
      turb1     REAL    DEFAULT 0,
      turb2     REAL    DEFAULT 0,
      pres1     REAL    DEFAULT 0,
      pres2     REAL    DEFAULT 0,
      flow1     REAL    DEFAULT 0,
      flow2     REAL    DEFAULT 0,
      vol1      REAL    DEFAULT 0,
      vol2      REAL    DEFAULT 0,
      tank1     INTEGER DEFAULT 0,
      tank2     INTEGER DEFAULT 0,
      tank3     INTEGER DEFAULT 0,
      tank4     INTEGER DEFAULT 0,
      p1        INTEGER DEFAULT 0,
      p2        INTEGER DEFAULT 0,
      p3        INTEGER DEFAULT 0,
      p4        INTEGER DEFAULT 0,
      p5        INTEGER DEFAULT 0,
      p6        INTEGER DEFAULT 0,
      p7        INTEGER DEFAULT 0,
      sys1      INTEGER DEFAULT 0,
      sys3      INTEGER DEFAULT 0,
      mode      INTEGER DEFAULT 0,
      valve     INTEGER DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Turso جاهز');
}

// ================================================================
//  حالة النظام في الذاكرة
// ================================================================
let latestData = {
  ph:0, tds:0, turb1:0, turb2:0,
  pres1:0, pres2:0, flow1:0, flow2:0, vol1:0, vol2:0,
  tank1:0, tank2:0, tank3:0, tank4:0,
  p1:0, p2:0, p3:0, p4:0, p5:0, p6:0, p7:0,
  sys1:0, sys3:0, mode:0, valve:0,
  timestamp: new Date().toISOString()
};

let pendingCommands = [];

// ================================================================
//  POST /api/sensor — يستقبل البيانات من ESP32
// ================================================================
app.post('/api/sensor', async (req, res) => {
  try {
    const d = req.body;
    latestData = { ...d, timestamp: new Date().toISOString() };

    await db.execute({
      sql: `INSERT INTO sensor_data
              (ph, tds, turb1, turb2, pres1, pres2, flow1, flow2,
               vol1, vol2, tank1, tank2, tank3, tank4,
               p1, p2, p3, p4, p5, p6, p7,
               sys1, sys3, mode, valve)
            VALUES
              (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        d.ph    ?? 0, d.tds   ?? 0, d.turb1 ?? 0, d.turb2 ?? 0,
        d.pres1 ?? 0, d.pres2 ?? 0, d.flow1 ?? 0, d.flow2 ?? 0,
        d.vol1  ?? 0, d.vol2  ?? 0,
        d.tank1 ?? 0, d.tank2 ?? 0, d.tank3 ?? 0, d.tank4 ?? 0,
        d.p1    ?? 0, d.p2    ?? 0, d.p3    ?? 0, d.p4    ?? 0,
        d.p5    ?? 0, d.p6    ?? 0, d.p7    ?? 0,
        d.sys1  ?? 0, d.sys3  ?? 0, d.mode  ?? 0, d.valve ?? 0,
      ]
    });

    const cmds = [...pendingCommands];
    pendingCommands = [];

    console.log(`[ESP32] ph=${d.ph} tds=${d.tds} sys1=${d.sys1}`);
    res.json({ status: 'ok', commands: cmds });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ================================================================
//  GET /api/sensor/latest
// ================================================================
app.get('/api/sensor/latest', (req, res) => {
  res.json(latestData);
});

// ================================================================
//  GET /api/sensor/history?limit=50
// ================================================================
app.get('/api/sensor/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await db.execute({
      sql:  'SELECT * FROM sensor_data ORDER BY id DESC LIMIT ?',
      args: [limit]
    });
    const rows = result.rows.reverse();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ================================================================
//  POST /api/command — أوامر من Flutter للـ ESP32
// ================================================================
app.post('/api/command', (req, res) => {
  const { command } = req.body;
  const valid = [
    'CMD:PUMP1_ON',  'CMD:PUMP1_OFF',
    'CMD:PUMP2_ON',  'CMD:PUMP2_OFF',
    'CMD:PUMP3_ON',  'CMD:PUMP3_OFF',
    'CMD:PUMP4_ON',  'CMD:PUMP4_OFF',
    'CMD:PUMP5_ON',  'CMD:PUMP5_OFF',
    'CMD:PUMP6_ON',  'CMD:PUMP6_OFF',
    'CMD:PUMP7_ON',  'CMD:PUMP7_OFF',
    'CMD:START',     'CMD:STOP',
    'CMD:START3',    'CMD:VALVE_ON',  'CMD:VALVE_OFF',
  ];
  if (!valid.includes(command)) {
    return res.status(400).json({ status: 'error', message: 'أمر غير صالح' });
  }
  pendingCommands.push(command);
  console.log(`[CMD] ${command}`);
  res.json({ status: 'ok', queued: command });
});

// ================================================================
//  GET /api/alerts
// ================================================================
app.get('/api/alerts', (req, res) => {
  const alerts = [];
  const d = latestData;
  if (d.ph < 6.5 || d.ph > 8.5)
    alerts.push({ level: 'danger',  message: `pH غير طبيعي: ${d.ph}`,        field: 'ph' });
  if (d.tds > 500)
    alerts.push({ level: 'warning', message: `TDS مرتفع: ${d.tds} ppm`,      field: 'tds' });
  if (d.turb1 > 4 || d.turb2 > 4)
    alerts.push({ level: 'warning', message: 'عكارة مرتفعة',                  field: 'turbidity' });
  if (d.pres1 > 10 || d.pres2 > 10)
    alerts.push({ level: 'danger',  message: 'ضغط خطير!',                    field: 'pressure' });
  if (d.tank1 < 10)
    alerts.push({ level: 'warning', message: `خزان 1 شبه فارغ: ${d.tank1}%`, field: 'tank1' });
  if (d.tank4 > 95)
    alerts.push({ level: 'info',    message: `خزان 4 ممتلئ: ${d.tank4}%`,    field: 'tank4' });
  res.json({ count: alerts.length, alerts });
});

// ================================================================
//  GET /health
// ================================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), db: 'Turso' });
});

// ================================================================
//  Self-ping — يمنع render.com من النوم
// ================================================================
const https = require('https');
setInterval(() => {
  const host = process.env.RENDER_EXTERNAL_HOSTNAME;
  if (!host) return;
  https.get(`https://${host}/health`, () => {
    console.log('[PING] alive ✓');
  }).on('error', () => {});
}, 4 * 60 * 1000);

// ================================================================
//  تشغيل الخادم
// ================================================================
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 الخادم يعمل على المنفذ ${PORT}`);
    console.log(`🔗 http://localhost:${PORT}/health`);
  });
}).catch(err => {
  console.error('❌ خطأ في Turso:', err.message);
  process.exit(1);
});
