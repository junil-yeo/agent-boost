// Port of the Attach enum in Format.swift: files for the chat box, dropped files, dropped/pasted images (saved under
// ~/.agent-boost/attachments). Paths are plain strings (Swift used file URLs).
const fs = require('fs');
const os = require('os');
const path = require('path');
const shell = require('./shell');

// AB_READONLY (development on a real machine): attachments go to the temp folder so ~/.agent-boost stays untouched.
const dir = process.env.AB_READONLY ? path.join(os.tmpdir(), 'agent-boost-attachments') : path.join(shell.home, '.agent-boost', 'attachments');

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function rand3() { return 100 + Math.floor(Math.random() * 900); }   // 100...999

/** PNG bytes as given by the renderer or the clipboard: Buffer, Uint8Array, ArrayBuffer, base64 or a data: URL. */
function toBuffer(png) {
  if (Buffer.isBuffer(png)) return png;
  if (png instanceof Uint8Array) return Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (png instanceof ArrayBuffer) return Buffer.from(png);
  if (typeof png === 'string') {
    const comma = png.startsWith('data:') ? png.indexOf(',') : -1;
    return Buffer.from(comma >= 0 ? png.slice(comma + 1) : png, 'base64');
  }
  return null;
}

/** Saves a PNG under the attachments folder; its path, or null. */
function save(png) {
  const data = toBuffer(png);
  if (!data || data.length === 0) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const u = path.join(dir, `screenshot-${stamp()}-${rand3()}.png`);
    fs.writeFileSync(u, data);
    return u;
  } catch { return null; }
}

/** Temporary folders whose files may vanish soon: macOS's /var/folders/ (Swift), and on Linux the temp dir (/tmp, or
 *  $TMPDIR), where screenshot tools and drag sources often leave their files. */
function inTempFolder(p) {
  const tmp = os.tmpdir().replace(/\/+$/, '') + '/';
  return p.includes('/var/folders/') || p.startsWith('/tmp/') || p.startsWith(tmp);
}

/** Images as the CLI takes them: two or more quoted paths ("a b.png" "c d.png") stayed plain text instead of becoming
 *  "[Image #n]", and a screenshot dragged from its thumbnail lives in a temporary folder the system soon empties. Such
 *  images are copied here under a name without spaces; other files are left where they are. */
function staged(paths) {
  const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tiff', 'bmp']);
  return (paths || []).map((p) => {
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!(images.has(ext) && !p.startsWith(dir) && (p.includes(' ') || inTempFolder(p)) && fs.existsSync(p))) return p;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const to = path.join(dir, `image-${stamp()}-${rand3()}.${ext}`);
      fs.copyFileSync(p, to, fs.constants.COPYFILE_EXCL);
      return to;
    } catch { return p; }
  });
}

/** The CLI keeps a pasted image inside its transcript (base64) once it has taken the message, so the copies made
 *  here for that message are no longer needed: removed after a confirmed send (kept when the message came back). */
function discard(text) {
  const root = dir + '/';
  for (const w of String(text).split(/[ \n]/)) {
    if (!w || !w.startsWith(root)) continue;
    if (w.slice(root.length).includes('/')) continue;
    try { fs.rmSync(w, { force: true }); } catch { }
  }
}

/** File paths in a clipboard's text/uri-list or x-special/gnome-copied-files payload ("copy\nfile:///…"). */
function fileURLs(s) {
  const out = [];
  for (const line of String(s || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('file://')) continue;
    try { out.push(decodeURIComponent(new URL(t).pathname)); } catch { }
  }
  return out;
}

/** The <string> entries of an XML property list (NSFilenamesPboardType holds the copied files' paths that way). */
function plistStrings(xml) {
  const ent = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const out = [];
  for (const m of String(xml || '').matchAll(/<string>([\s\S]*?)<\/string>/g)) {
    out.push(m[1].replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e) => (e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ent[e] ?? all))));
  }
  return out;
}
/** macOS: files copied in the Finder (Swift: pb.readObjects(forClasses: [NSURL], .urlReadingFileURLsOnly)). Chromium
 *  lists such a clipboard as "text/uri-list" but read('text/uri-list') comes back empty (checked on macOS 15 with
 *  Electron 33), so the native types are read directly: NSFilenamesPboardType (every copied file's path, in order),
 *  then public.file-url (the first one). Paths in the copy order. */
function macCopiedFiles(clipboard) {
  let paths = [];
  try { paths = plistStrings(clipboard.read('NSFilenamesPboardType')).filter((p) => p.startsWith('/')); } catch { }
  if (paths.length) return paths;
  let u = '';
  try { u = clipboard.read('public.file-url') || clipboard.readBuffer('public.file-url').toString('utf8'); } catch { }
  return fileURLs(u).filter((p) => !p.startsWith('/.file/'));   // a file-reference URL is not a path
}

/** Clipboard image (e.g. a screenshot tool's "copy to clipboard"). A copied file wins (its path); text on the clipboard
 *  then wins over an image, so normal pasting is untouched (the Finder also puts a copied file's name on the clipboard
 *  as text, which is why the files are looked at first). Returns a path, or null. */
function pastedImage() {
  const { clipboard } = require('electron');
  if (process.platform === 'darwin') { const files = macCopiedFiles(clipboard); if (files.length > 0) return files[0]; }
  const formats = clipboard.availableFormats();
  for (const f of ['text/uri-list', 'x-special/gnome-copied-files', 'public.file-url']) {
    if (!formats.includes(f)) continue;
    let s = '';
    try { s = clipboard.read(f) || clipboard.readBuffer(f).toString('utf8'); } catch { }
    const urls = fileURLs(s);
    if (urls.length > 0) return urls[0];
  }
  if (formats.some((f) => f === 'text/plain' || f.startsWith('text/plain;') || f === 'UTF8_STRING' || f === 'STRING') || clipboard.readText() !== '') return null;
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return null;
  return save(img.toPNG());
}

module.exports = { dir, save, staged, discard, pastedImage, fileURLs, plistStrings };
