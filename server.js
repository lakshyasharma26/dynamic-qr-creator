const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const QRCode = require('qrcode');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite Database Setup
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_scanned_at DATETIME
  )
`);

// Helper: Random 6-character slug generator
function generateSlug() {
  return crypto.randomBytes(3).toString('hex');
}

// Helper: Validate Hex Color
function sanitizeColor(hex, fallback) {
  if (typeof hex === 'string' && /^#[0-9A-Fa-f]{6}$/.test(hex.trim())) {
    return hex.trim();
  }
  return fallback;
}

// 1. API: Sabhi QR Codes ki list laane ke liye
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

// 2. API: Naya Dynamic QR Code banane ke liye
app.post('/api/qrs', (req, res) => {
  const { title, target_url, custom_slug, fg_color, bg_color } = req.body;

  if (!title || !target_url) {
    return res.status(400).json({ error: 'Title aur Target URL zaroori hain' });
  }

  let formattedUrl = target_url.trim();
  if (!/^https?:\/\//i.test(formattedUrl)) {
    formattedUrl = 'https://' + formattedUrl;
  }

  const slug = custom_slug ? custom_slug.trim().replace(/[^a-zA-Z0-9-_]/g, '') : generateSlug();
  const safeFg = sanitizeColor(fg_color, '#000000');
  const safeBg = sanitizeColor(bg_color, '#ffffff');

  try {
    const stmt = db.prepare(
      'INSERT INTO qrcodes (slug, title, target_url, fg_color, bg_color) VALUES (?, ?, ?, ?, ?)'
    );
    const info = stmt.run(slug, title.trim(), formattedUrl, safeFg, safeBg);
    res.status(201).json({ id: info.lastInsertRowid, slug, message: 'Dynamic QR ban gaya!' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Ye custom link pehle se maujood hai, dusra chunein' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. API: Existing QR Code ka Target URL, Title ya Color Update karne ke liye
app.put('/api/qrs/:id', (req, res) => {
  const { id } = req.params;
  const { title, target_url, fg_color, bg_color } = req.body;

  let formattedUrl = target_url.trim();
  if (!/^https?:\/\//i.test(formattedUrl)) {
    formattedUrl = 'https://' + formattedUrl;
  }

  const safeFg = sanitizeColor(fg_color, '#000000');
  const safeBg = sanitizeColor(bg_color, '#ffffff');

  try {
    const stmt = db.prepare(
      'UPDATE qrcodes SET title = ?, target_url = ?, fg_color = ?, bg_color = ? WHERE id = ?'
    );
    const result = stmt.run(title.trim(), formattedUrl, safeFg, safeBg, id);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'QR Code nahi mila' });
    }
    res.json({ message: 'QR Code update ho gaya!' });
  } catch (err) {
    res.status(500).json({ error: 'Update fail ho gaya' });
  }
});

// 4. API: QR Code Delete karne ke liye
app.delete('/api/qrs/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM qrcodes WHERE id = ?').run(req.params.id);
    res.json({ message: 'Delete ho gaya' });
  } catch (err) {
    res.status(500).json({ error: 'Delete fail ho gaya' });
  }
});

// 5. CORE DYNAMIC REDIRECT ROUTE
app.get('/q/:slug', (req, res) => {
  const { slug } = req.params;
  const qr = db.prepare('SELECT * FROM qrcodes WHERE slug = ?').get(slug);

  if (!qr) {
    return res.status(404).send('<h1>404 - Ye QR Code active nahi hai ya delete ho chuka hai.</h1>');
  }

  db.prepare('UPDATE qrcodes SET scans = scans + 1, last_scanned_at = CURRENT_TIMESTAMP WHERE id = ?').run(qr.id);
  res.redirect(302, qr.target_url);
});

app.listen(PORT, () => {
  console.log(`Dynamic QR Server chal raha hai: http://localhost:${PORT}`);
});
