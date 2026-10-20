// attach.js on temp files: save, staged (copies images whose path has a space / sits in a temp folder), discard.
// BOARD_HOME points at a throwaway folder, so ~/.agent-boost is never touched. Run: node test/attach.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// outside the temp folder: files there would count as "may vanish soon" and be staged
const home = fs.mkdtempSync(path.join(__dirname, '.abtest-home-'));
process.env.BOARD_HOME = home;
delete process.env.AB_READONLY;
const attach = require('../main/attach');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('PASS ' + name); } catch (e) { failed += 1; console.log('FAIL ' + name + ': ' + e.message); }
}

test('dir is under BOARD_HOME', () => assert.strictEqual(attach.dir, path.join(home, '.agent-boost', 'attachments')));

test('save writes a PNG and returns its path', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const p = attach.save(png);
  assert.ok(p && p.startsWith(attach.dir + '/screenshot-') && p.endsWith('.png'), p);
  assert.ok(fs.readFileSync(p).equals(png));
  const p2 = attach.save('data:image/png;base64,' + png.toString('base64'));
  assert.ok(fs.readFileSync(p2).equals(png));
  assert.strictEqual(attach.save(Buffer.alloc(0)), null);
});

const src = fs.mkdtempSync(path.join(home, 'src-'));
const spaced = path.join(src, 'a b.png'); fs.writeFileSync(spaced, 'img');
const plain = path.join(src, 'plain.png'); fs.writeFileSync(plain, 'img');
const doc = path.join(src, 'my doc.txt'); fs.writeFileSync(doc, 'txt');
const tmpImg = path.join(os.tmpdir(), `abtest-${process.pid}.JPG`); fs.writeFileSync(tmpImg, 'img');

test('staged copies images with a space in the path', () => {
  const [out] = attach.staged([spaced]);
  assert.notStrictEqual(out, spaced);
  assert.ok(out.startsWith(attach.dir + '/image-') && out.endsWith('.png') && !out.includes(' '), out);
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'img');
});
test('staged copies images in the temp folder (lower-cased extension)', () => {
  const [out] = attach.staged([tmpImg]);
  assert.ok(out.startsWith(attach.dir + '/image-') && out.endsWith('.jpg'), out);
});
test('staged leaves other files where they are', () => {
  assert.deepStrictEqual(attach.staged([plain, doc, '/nonexistent/x y.png']), [plain, doc, '/nonexistent/x y.png']);
  const inside = attach.save(Buffer.from('x'));
  assert.deepStrictEqual(attach.staged([inside]), [inside]);
});

test('discard removes only files directly in the attachments folder named in the text', () => {
  const a = attach.save(Buffer.from('a')), b = attach.save(Buffer.from('b'));
  fs.mkdirSync(path.join(attach.dir, 'sub'), { recursive: true });
  const nested = path.join(attach.dir, 'sub', 'n.png'); fs.writeFileSync(nested, 'n');
  attach.discard(`look at ${a}\nand ${nested} and ${plain}`);
  assert.ok(!fs.existsSync(a), 'a removed');
  assert.ok(fs.existsSync(b), 'b kept (not in the text)');
  assert.ok(fs.existsSync(nested), 'nested kept');
  assert.ok(fs.existsSync(plain), 'outside file kept');
});

test('fileURLs parses uri-list and gnome-copied-files', () => {
  assert.deepStrictEqual(attach.fileURLs('copy\nfile:///home/u/a%20b.png\r\nfile:///tmp/c.png'), ['/home/u/a b.png', '/tmp/c.png']);
  assert.deepStrictEqual(attach.fileURLs('hello'), []);
});

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(tmpImg, { force: true });
console.log(failed === 0 ? 'ALL attach tests PASSED' : `${failed} attach tests FAILED`);
process.exit(failed === 0 ? 0 : 1);
