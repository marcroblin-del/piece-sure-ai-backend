const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');
const PUBLIC_DIR = path.join(ROOT, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new sqlite3.Database(DB_PATH);

const now = () => new Date().toISOString();
const uid = () => 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
const safeString = (v) => (v == null ? '' : String(v));
const toJson = (v) => JSON.stringify(Array.isArray(v) ? v : []);
const parseJson = (v) => {
  try { return v ? JSON.parse(v) : []; } catch { return []; }
};

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err); else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
  });
}

function rowToClient(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name || '', company: row.company || '',
    phone: row.phone || '', email: row.email || '', vehicle: row.vehicle || '',
    plate: row.plate || '', vin: row.vin || '', engine: row.engine || '',
    oe: row.oe || '', notes: row.notes || '',
    files: parseJson(row.files_json),
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

function normalizeClient(body = {}, createdAt = now()) {
  return {
    id: safeString(body.id) || uid(),
    name: safeString(body.name), company: safeString(body.company),
    phone: safeString(body.phone), email: safeString(body.email),
    vehicle: safeString(body.vehicle), plate: safeString(body.plate),
    vin: safeString(body.vin), engine: safeString(body.engine),
    oe: safeString(body.oe), notes: safeString(body.notes),
    files: Array.isArray(body.files) ? body.files : [],
    createdAt: safeString(body.createdAt) || createdAt,
    updatedAt: now()
  };
}

async function upsertClient(body) {
  const incoming = normalizeClient(body);
  const existing = await get('SELECT created_at FROM clients WHERE id = ?', [incoming.id]);
  const createdAt = existing?.created_at || incoming.createdAt || now();

  await run(`INSERT INTO clients (id, name, company, phone, email, vehicle, plate, vin, engine, oe, notes, files_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, company = excluded.company, phone = excluded.phone, email = excluded.email, vehicle = excluded.vehicle, plate = excluded.plate, vin = excluded.vin, engine = excluded.engine, oe = excluded.oe, notes = excluded.notes, files_json = excluded.files_json, updated_at = excluded.updated_at`,
    [incoming.id, incoming.name, incoming.company, incoming.phone, incoming.email, incoming.vehicle, incoming.plate, incoming.vin, incoming.engine, incoming.oe, incoming.notes, toJson(incoming.files), createdAt, incoming.updatedAt]
  );
  return rowToClient(await get('SELECT * FROM clients WHERE id = ?', [incoming.id]));
}

async function insertHistory(body = {}) {
  const row = { id: safeString(body.id) || uid(), type: safeString(body.type), label: safeString(body.label), detail: safeString(body.detail), at: safeString(body.at) || now() };
  await run('INSERT INTO history (id, type, label, detail, at) VALUES (?, ?, ?, ?, ?)', [row.id, row.type, row.label, row.detail, row.at]);
  return row;
}

async function insertMessage(body = {}) {
  const row = { id: safeString(body.id) || uid(), role: safeString(body.role) || 'assistant', text: safeString(body.text), at: safeString(body.at) || now() };
  await run('INSERT INTO messages (id, role, text, at) VALUES (?, ?, ?, ?)', [row.id, row.role, row.text, row.at]);
  return row;
}

db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL;');
  db.run(`CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT, company TEXT, phone TEXT, email TEXT, vehicle TEXT, plate TEXT, vin TEXT, engine TEXT, oe TEXT, notes TEXT, files_json TEXT, created_at TEXT, updated_at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, type TEXT, label TEXT, detail TEXT, at TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, role TEXT, text TEXT, at TEXT)`);
});

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (req, res) => { res.json({ ok: true, mode: 'sqlite', time: now(), db: path.basename(DB_PATH) }); });
app.get('/api/bootstrap', async (req, res) => {
  try {
    const [clients, history, messages] = await Promise.all([
      all('SELECT * FROM clients ORDER BY updated_at DESC'),
      all('SELECT * FROM history ORDER BY at DESC'),
      all('SELECT * FROM messages ORDER BY at ASC')
    ]);
    res.json({ ok: true, clients: clients.map(rowToClient), history, messages, serverTime: now() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Clients
app.get('/api/clients', async (req, res) => {
  try { const rows = await all('SELECT * FROM clients ORDER BY updated_at DESC'); res.json(rows.map(rowToClient)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients', async (req, res) => {
  try { const client = await upsertClient(req.body || {}); res.status(201).json(client); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:id', async (req, res) => {
  try { await run('DELETE FROM clients WHERE id = ?', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// History
app.get('/api/history', async (req, res) => {
  try { const rows = await all('SELECT * FROM history ORDER BY at DESC'); res.json(rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/history', async (req, res) => {
  try { const item = await insertHistory(req.body || {}); res.status(201).json(item); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/history', async (req, res) => {
  try { await run('DELETE FROM history'); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Messages
app.get('/api/messages', async (req, res) => {
  try { const rows = await all('SELECT * FROM messages ORDER BY at ASC'); res.json(rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/messages', async (req, res) => {
  try { const item = await insertMessage(req.body || {}); res.status(201).json(item); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (req, res) => { res.sendFile(path.join(PUBLIC_DIR, 'index.html')); });

app.listen(PORT, () => { console.log(`PIÈCE-SÛRE AI backend running on http://localhost:${PORT}`); });
