// Which sessions the org chart shows ("pinned"). The board sees every conversation the CLI can resume; on a machine
// with a long history that is hundreds of cards, so the org chart, the 개별 세션 tab and the team tabs show only the
// pinned ones, and the 세션 목록 tab lists everything. Two views of the same sessions: unpinning hides a card from the
// org chart, nothing else (archiving stays a separate action).
//
// ~/.agent-boost/pinned.json: {version, installedAt (ms), initialized (bool), pinned: [sid], unpinned: [sid]}
//   pinned(sid) = sid in `pinned`, or (sid not in `unpinned` and the conversation was created after installedAt).
//   A team is shown when its lead is pinned, or (no lead card left) when any member is.
// The first launch of this version (no file) sets installedAt = now and initialized = false: everything that existed
// before is unpinned until the person picks (the renderer's picker sheet), so nothing they had is pinned by surprise
// and nothing new is ever missing from the chart.
// Under AB_READONLY / AB_ONLY the file lives in a temp folder (the real one is only read, as a starting point);
// AB_PINNED_FILE points it anywhere (tests, first-launch snapshots).
const fs = require('fs');
const os = require('os');
const path = require('path');
const Shell = require('./shell');
const Only = require('./only');

const VERSION = 1;

/** Where pinned.json is read and written in this run. */
function filePath() {
  if (process.env.AB_PINNED_FILE) return process.env.AB_PINNED_FILE;
  if (Only.active()) return path.join(Only.dataDir(), 'pinned.json');
  if (process.env.AB_READONLY) return path.join(os.tmpdir(), 'agent-boost-readonly', 'pinned.json');
  return realPath();
}
function realPath() { return path.join(Shell.home, '.agent-boost', 'pinned.json'); }

/** A fresh record: the first launch of the pinning version. */
function fresh(now = Date.now()) { return { version: VERSION, installedAt: now, initialized: false, pinned: [], unpinned: [] }; }

/** A parsed file made safe (unknown shape → null). */
function normalize(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.installedAt !== 'number') return null;
  const ids = (x) => (Array.isArray(x) ? [...new Set(x.filter((s) => typeof s === 'string' && s))] : []);
  return { version: VERSION, installedAt: j.installedAt, initialized: j.initialized === true, pinned: ids(j.pinned), unpinned: ids(j.unpinned) };
}

/** Reads the record. `created` = true when there was none (first launch): the caller saves it. Under the read-only
 *  modes a missing temp file starts from the real one (read only), so a dev copy shows the person's own pins. */
function load(now = Date.now()) {
  const p = filePath();
  const read = (f) => { try { return normalize(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { return null; } };
  let d = read(p);
  if (!d && !process.env.AB_PINNED_FILE && p !== realPath()) d = read(realPath());
  if (d) return { data: d, created: false };
  return { data: fresh(now), created: true };
}
/** Writes the record (atomically: temp file + rename). */
function save(data) {
  const p = filePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) { console.error('[pins] save', e.message); return false; }
}

// ── the rules (pure: data in, answer out) ───────────────────────────────────────────────────────────────────────────
/** pinned(sid) = in `pinned`, or (not in `unpinned` and created after installedAt). `created`: epoch ms or null. */
function isPinned(data, sid, created) {
  if (data.pinned.includes(sid)) return true;
  if (data.unpinned.includes(sid)) return false;
  return created != null && created > data.installedAt;
}
/** A team is shown when its lead is pinned; with no lead card left (deleted, or an ended lead the board no longer
 *  has), when any member is. `members`: [{sessionId, isLead}], `createdOf(sid)` → ms | null. */
function teamPinned(data, members, createdOf) {
  const lead = members.find((m) => m.isLead);
  if (lead) return isPinned(data, lead.sessionId, createdOf(lead.sessionId));
  return members.some((m) => isPinned(data, m.sessionId, createdOf(m.sessionId)));
}
/** Explicit pin: moves the ids to `pinned`. Returns true when something changed. */
function pin(data, sids) {
  let changed = false;
  for (const s of sids) {
    if (!data.pinned.includes(s)) { data.pinned.push(s); changed = true; }
    const i = data.unpinned.indexOf(s); if (i >= 0) { data.unpinned.splice(i, 1); changed = true; }
  }
  return changed;
}
/** Explicit unpin: moves the ids to `unpinned` (the rule's "created after installedAt" no longer pins them). */
function unpin(data, sids) {
  let changed = false;
  for (const s of sids) {
    if (!data.unpinned.includes(s)) { data.unpinned.push(s); changed = true; }
    const i = data.pinned.indexOf(s); if (i >= 0) { data.pinned.splice(i, 1); changed = true; }
  }
  return changed;
}
/** A conversation that goes on under a new id (a CLI job resumed it, a parked viewer's job, a copy the CLI made) keeps
 *  the old id's pin: `fromPinned` is the old id's answer now (explicit or by the rule). Recorded explicitly for the new
 *  id, once (an id with a choice of its own keeps it), so a copy the CLI makes today of an old unpinned conversation
 *  does not appear on the chart just because its file is new. Returns true when something changed. */
function inherit(data, fromSid, toSid, fromPinned) {
  if (!fromSid || !toSid || fromSid === toSid) return false;
  if (data.pinned.includes(toSid) || data.unpinned.includes(toSid)) return false;
  (fromPinned ? data.pinned : data.unpinned).push(toSid);
  return true;
}

module.exports = { VERSION, filePath, realPath, fresh, normalize, load, save, isPinned, teamPinned, pin, unpin, inherit };
