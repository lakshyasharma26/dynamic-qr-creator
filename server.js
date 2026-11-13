const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const QRCode = require('qrcode');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Render / reverse proxies so IP & protocol are accurate
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Built-in Node.js SQLite Database Setup (Zero native build tools required)
const db = new DatabaseSync('qr_database.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS qrcodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    target_url TEXT NOT NULL,
    fg_color TEXT DEFAULT '#000000',
    bg_color TEXT DEFAULT '#ffffff',
    scans INTEGER DEFAULT 0,
    max_scans INTEGER DEFAULT NULL,
    expires_at TEXT DEFAULT NULL,
    pin_code TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_scanned_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    qr_id INTEGER NOT NULL,
    device_type TEXT,
    os_name TEXT,
    browser_name TEXT,
    city TEXT,
    country TEXT,
    scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (qr_id) REFERENCES qrcodes(id) ON DELETE CASCADE
  );
`);

// Auto-migrate existing database if upgrading from v1
const cols = db.prepare("PRAGMA table_info(qrcodes)").all().map(c => c.name);
if (!cols.includes('max_scans')) db.exec("ALTER TABLE qrcodes ADD COLUMN max_scans INTEGER DEFAULT NULL");
if (!cols.includes('expires_at')) db.exec("ALTER TABLE qrcodes ADD COLUMN expires_at TEXT DEFAULT NULL");
if (!cols.includes('pin_code')) db.exec("ALTER TABLE qrcodes ADD COLUMN pin_code TEXT DEFAULT NULL");

// Helpers
function generateSlug() {
  return crypto.randomBytes(3).toString('hex');
}

function sanitizeColor(hex, fallback) {
  if (typeof hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(hex.trim())) {
    return hex.trim();
  }
  return fallback;
}

function formatUrl(url) {
  let clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) {
    clean = 'https://' + clean;
  }
  return clean;
}

function parseUserAgent(ua = '') {
  let device = 'Desktop';
  if (/mobile|android|iphone|ipod/i.test(ua)) device = 'Mobile';
  else if (/ipad|tablet/i.test(ua)) device = 'Tablet';

  let os = 'Other';
  if (/android/i.test(ua)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/windows/i.test(ua)) os = 'Windows';
  else if (/mac os/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  let browser = 'Other';
  if (/edg/i.test(ua)) browser = 'Edge';
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/safari/i.test(ua) && !/chrome|crios/i.test(ua)) browser = 'Safari';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';

  return { device, os, browser };
}

async function getGeoLocation(ip) {
  try {
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return { city: 'Localhost', country: 'Local' };
    }
    const cleanIp = ip.split(',')[0].trim().replace('::ffff:', '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://ip-api.com/json/${cleanIp}?fields=status,country,city`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (data.status === 'success') {
      return { city: data.city || 'Unknown', country: data.country || 'Unknown' };
    }
  } catch (e) {
    // Fail silently so redirect speed is never blocked
  }
  return { city: 'Unknown', country: 'Unknown' };
}

function statusPage(title, message, accentColor = '#f43f5e') {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4 font-sans">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-8 text-center shadow-xl">
      <div class="w-14 h-14 rounded-full mx-auto mb-4 flex items-center justify-center" style="background:${accentColor}22; color:${accentColor}">
        <span class="text-2xl font-bold">!</span>
      </div>
      <h1 class="text-2xl font-bold mb-2">${title}</h1>
      <p class="text-slate-400 text-sm">${message}</p>
    </div>
  </body>
  </html>`;
}

function pinPromptPage(slug, title, errorMsg = '') {
  return `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Protected QR - ${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body class="bg-slate-950 text-slate-100 min-h-screen flex items-center justify-center p-4 font-sans">
    <div class="bg-slate-900 border border-slate-800 rounded-2xl max-w-sm w-full p-7 shadow-xl">
      <h1 class="text-xl font-bold text-indigo-400 mb-1">PIN Protected QR</h1>
      <p class="text-slate-400 text-xs mb-5">"${title}" kholne ke liye PIN enter karein.</p>
      ${errorMsg ? `<p class="bg-rose-500/20 text-rose-300 text-xs px-3 py-2 rounded-lg mb-4">${errorMsg}</p>` : ''}
      <form method="POST" action="/q/${slug}/unlock" class="space-y-4">
        <input type="password" name="pin" required autofocus placeholder="Enter PIN"
          class="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-center tracking-widest text-lg focus:outline-none focus:border-indigo-500" />
        <button type="submit"
          class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 rounded-lg text-sm transition cursor-pointer">
          Unlock & Continue →
        </button>
      </form>
    </div>
  </body>
  </html>`;
}

// 1. API: List all QR Codes
app.get('/api/qrs', async (req, res) => {
  try {
    const qrs = db.prepare('SELECT * FROM qrcodes ORDER BY id DESC').all();
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const qrsWithImages = await Promise.all(
      qrs.map(async (qr) => {
        const dynamicUrl = `${baseUrl}/q/${qr.slug}`;
        const qrImage = await QRCode.toDataURL(dynamicUrl, {
          width: 400,
          margin: 2,
          color: {
            dark: qr.fg_color || '#000000',
            light: qr.bg_color || '#ffffff'
          }
        });
        return { ...qr, dynamicUrl, qrImage };
      })
    );

    res.json(qrsWithImages);
  } catch (err) {
    res.status(500).json({ error: 'Data fetch karne mein dikkat aayi' });
  }
});

// 2. API: Create Dynamic QR with Smart Redirect rules
app.post('/api/qrs', (req, res) => {
  const { title, target_url, custom_slug, fg_color, bg_color, max_scans, expires_at, pin_code } = req.body;

  if (!title || !target_url) {
    return res.status(400).json({ error: 'Title aur Target URL zaroori hain' });
  }

  const formattedUrl = formatUrl(target_url);
  const slug = custom_slug ? custom_slug.trim().replace(/[^a-zA-Z0-9-_]/g, '') : generateSlug();
  const safeFg = sanitizeColor(fg_color, '#000000');
  const safeBg = sanitizeColor(bg_color, '#ffffff');
  const parsedMaxScans = max_scans && parseInt(max_scans, 10) > 0 ? parseInt(max_scans, 10) : null;
  const parsedExpiry = expires_at && expires_at.trim() !== '' ? expires_at.trim() : null;
  const parsedPin = pin_code && pin_code.trim() !== '' ? pin_code.trim() : null;

  try {
    const stmt = db.prepare(
      `INSERT INTO qrcodes (slug, title, target_url, fg_color, bg_color, max_scans, expires_at, pin_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(slug, title.trim(), formattedUrl, safeFg, safeBg, parsedMaxScans, parsedExpiry, parsedPin);
    res.status(201).json({ id: Number(info.lastInsertRowid), slug, message: 'Dynamic QR ban gaya!' });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'Ye custom link pehle se maujood hai, dusra chunein' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. API: Update QR Code & Smart Redirect rules
app.put('/api/qrs/:id', (req, res) => {
  const { id } = req.params;
  const { title, target_url, fg_color, bg_color, max_scans, expires_at, pin_code } = req.body;

  const formattedUrl = formatUrl(target_url);
  const safeFg = sanitizeColor(fg_color, '#000000');
  const safeBg = sanitizeColor(bg_color, '#ffffff');
  const parsedMaxScans = max_scans && parseInt(max_scans, 10) > 0 ? parseInt(max_scans, 10) : null;
  const parsedExpiry = expires_at && expires_at.trim() !== '' ? expires_at.trim() : null;
  const parsedPin = pin_code && pin_code.trim() !== '' ? pin_code.trim() : null;

  try {
    const stmt = db.prepare(
      `UPDATE qrcodes
       SET title = ?, target_url = ?, fg_color = ?, bg_color = ?, max_scans = ?, expires_at = ?, pin_code = ?
       WHERE id = ?`
    );
    const result = stmt.run(title.trim(), formattedUrl, safeFg, safeBg, parsedMaxScans, parsedExpiry, parsedPin, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'QR Code nahi mila' });
    }
    res.json({ message: 'QR Code update ho gaya!' });
  } catch (err) {
    res.status(500).json({ error: 'Update fail ho gaya' });
  }
});

// 4. API: Delete QR Code
app.delete('/api/qrs/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM scan_logs WHERE qr_id = ?').run(req.params.id);
    db.prepare('DELETE FROM qrcodes WHERE id = ?').run(req.params.id);
    res.json({ message: 'Delete ho gaya' });
  } catch (err) {
    res.status(500).json({ error: 'Delete fail ho gaya' });
  }
});

// 5. API: Detailed Analytics for a specific QR Code
app.get('/api/qrs/:id/analytics', (req, res) => {
  try {
    const qr = db.prepare('SELECT * FROM qrcodes WHERE id = ?').get(req.params.id);
    if (!qr) return res.status(404).json({ error: 'QR nahi mila' });

    const byDevice = db.prepare(
      'SELECT device_type as label, COUNT(*) as count FROM scan_logs WHERE qr_id = ? GROUP BY device_type ORDER BY count DESC'
    ).all(qr.id);

    const byOS = db.prepare(
      'SELECT os_name as label, COUNT(*) as count FROM scan_logs WHERE qr_id = ? GROUP BY os_name ORDER BY count DESC'
    ).all(qr.id);

    const byLocation = db.prepare(
      "SELECT (city || ', ' || country) as label, COUNT(*) as count FROM scan_logs WHERE qr_id = ? GROUP BY city, country ORDER BY count DESC LIMIT 6"
    ).all(qr.id);

    const dailyScans = db.prepare(
      `SELECT DATE(scanned_at) as day, COUNT(*) as count
       FROM scan_logs
       WHERE qr_id = ? AND scanned_at >= datetime('now', '-7 days')
       GROUP BY DATE(scanned_at)
       ORDER BY day ASC`
    ).all(qr.id);

    const recentLogs = db.prepare(
      'SELECT device_type, os_name, browser_name, city, country, scanned_at FROM scan_logs WHERE qr_id = ? ORDER BY id DESC LIMIT 10'
    ).all(qr.id);

    res.json({
      qr,
      byDevice,
      byOS,
      byLocation,
      dailyScans,
      recentLogs
    });
  } catch (err) {
    res.status(500).json({ error: 'Analytics load nahi ho payi' });
  }
});

// Helper to record scan and redirect
async function completeRedirect(req, res, qr) {
  const uaInfo = parseUserAgent(req.headers['user-agent']);
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const geo = await getGeoLocation(ip);

  db.prepare('UPDATE qrcodes SET scans = scans + 1, last_scanned_at = CURRENT_TIMESTAMP WHERE id = ?').run(qr.id);
  db.prepare(
    'INSERT INTO scan_logs (qr_id, device_type, os_name, browser_name, city, country) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(qr.id, uaInfo.device, uaInfo.os, uaInfo.browser, geo.city, geo.country);

  return res.redirect(302, qr.target_url);
}

// 6. CORE SMART REDIRECT ROUTE
app.get('/q/:slug', async (req, res) => {
  const { slug } = req.params;
  const qr = db.prepare('SELECT * FROM qrcodes WHERE slug = ?').get(slug);

  if (!qr) {
    return res.status(404).send(statusPage('404 - QR Not Found', 'Ye QR Code active nahi hai ya delete ho chuka hai.'));
  }

  // Check Expiry Date
  if (qr.expires_at && new Date(qr.expires_at) < new Date()) {
    return res.status(410).send(statusPage('QR Code Expired', 'Is QR code ki validity khatam ho chuki hai.', '#f59e0b'));
  }

  // Check Max Scan Limit
  if (qr.max_scans && qr.scans >= qr.max_scans) {
    return res.status(410).send(statusPage('Scan Limit Reached', 'Is QR code ki maximum scan limit poori ho chuki hai.', '#f59e0b'));
  }

  // Check PIN Protection
  if (qr.pin_code) {
    return res.send(pinPromptPage(slug, qr.title));
  }

  return completeRedirect(req, res, qr);
});

// 7. PIN Unlock Handler
app.post('/q/:slug/unlock', async (req, res) => {
  const { slug } = req.params;
  const { pin } = req.body;
  const qr = db.prepare('SELECT * FROM qrcodes WHERE slug = ?').get(slug);

  if (!qr) {
    return res.status(404).send(statusPage('404 - QR Not Found', 'Ye QR Code active nahi hai.'));
  }

  if (qr.expires_at && new Date(qr.expires_at) < new Date()) {
    return res.status(410).send(statusPage('QR Code Expired', 'Is QR code ki validity khatam ho chuki hai.', '#f59e0b'));
  }

  if (qr.max_scans && qr.scans >= qr.max_scans) {
    return res.status(410).send(statusPage('Scan Limit Reached', 'Is QR code ki maximum scan limit poori ho chuki hai.', '#f59e0b'));
  }

  if (qr.pin_code && pin !== qr.pin_code) {
    return res.status(401).send(pinPromptPage(slug, qr.title, 'Galat PIN! Dobara koshish karein.'));
  }

  return completeRedirect(req, res, qr);
});

app.listen(PORT, () => {
  console.log(`Dynamic QR Studio v2.0 chal raha hai: http://localhost:${PORT}`);
});
