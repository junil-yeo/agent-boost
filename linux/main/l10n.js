// Translations shared with the macOS app: <repo>/Resources/l10n/*.json → { "<Korean source>": { en, ja, zh, es } }.
const fs = require('fs');
const path = require('path');
const os = require('os');

const LANGS = ['en', 'ko', 'ja', 'zh', 'es'];
const NATIVE = { en: 'English', ko: '한국어', ja: '日本語', zh: '简体中文', es: 'Español' };
const settingsFile = path.join(os.homedir(), '.agent-boost', 'linux-settings.json');

function dirs() {
  return [path.join(__dirname, '..', 'l10n'), path.join(__dirname, '..', '..', 'Resources', 'l10n')];
}
let table = null;
function load() {
  if (table) return table;
  table = {};
  for (const d of dirs()) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      try { const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); for (const k in j) if (!(k in table)) table[k] = j[k]; } catch { }
    }
    break;   // the first folder that exists wins (an installed copy, else the repo's)
  }
  // texts only the Linux version has
  const extra = path.join(__dirname, '..', 'l10n-extra');
  for (const f of (fs.existsSync(extra) ? fs.readdirSync(extra) : [])) {
    if (!f.endsWith('.json')) continue;
    try { const j = JSON.parse(fs.readFileSync(path.join(extra, f), 'utf8')); for (const k in j) if (!(k in table)) table[k] = j[k]; } catch { }
  }
  return table;
}
function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } }
function writeSettings(s) { fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2)); }

let lang = readSettings().language || null;
/** null until the user picked a language (the first launch asks). */
function chosen() { return lang; }
function setLanguage(l) { if (!LANGS.includes(l)) return; lang = l; const s = readSettings(); s.language = l; writeSettings(s); }
function text(k) {
  const l = lang || 'en';
  if (l === 'ko') return k;
  const row = load()[k];
  return (row && (row[l] || row.en)) || k;
}
/** L('…%@…', a, b): the Korean source is the key; %@ in order, or %1$@ %2$@ when a translation reorders them. */
function L(k, ...args) {
  let s = text(k);
  args.forEach((a, i) => { s = s.split(`%${i + 1}$@`).join(String(a)); });
  let i = 0;
  s = s.replace(/%@/g, (m) => (i < args.length ? String(args[i++]) : m));
  return s;
}
module.exports = { L, chosen, setLanguage, table: () => load(), languages: () => LANGS.map((id) => ({ id, native: NATIVE[id] })), readSettings, writeSettings };
