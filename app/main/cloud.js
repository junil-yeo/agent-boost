// Main-process side of NewSessionSheet's cloud form (CreateViews.swift): the GitHub repository list for a cloud
// session on claude.ai/code. The sheet builds the claude.ai/code URL itself and opens it with platform.openExternal.
//
//   loadRepos()        → {rows: [{name, priv}], gh: bool}   NewSessionSheet.loadRepos (gh = the gh CLI is installed)
//   noteOpened(repos)  SendLog line "새 클라우드 세션: <repos> 웹으로 열기"
const fs = require('fs');
const shell = require('./shell');
const tmux = require('./tmux');

function isExecutable(p) { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }

/** The user's repositories through the gh CLI (own, collaborator and organisation ones), most recently pushed first. */
async function loadRepos() {
  const gh = shell.gh;
  const r = await shell.run([gh, 'api', '--paginate', 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member',
    '--jq', '.[] | [.full_name, (.private|tostring)] | @tsv'], { timeout: 25 });
  const rows = r.out.split('\n').map((l) => l.split('\t')).filter((f) => f.length === 2 && f[0]).map((f) => ({ name: f[0], priv: f[1] === 'true' }));
  return { rows, gh: isExecutable(gh) };
}

/** NewSessionSheet.openCloud's log line. */
function noteOpened(repos) { tmux.SendLog.note(`새 클라우드 세션: ${(repos || []).join(',')} 웹으로 열기`); return true; }

module.exports = { loadRepos, noteOpened };
