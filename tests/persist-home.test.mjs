// dt-persist-home, layout 2: the WHOLE home of the workspace user lives on the volume (measured: a Fly
// machine's own filesystem is rebuilt on every stop/start), and a layout-1 volume is migrated once.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../hq/persist-home.sh', import.meta.url));
const run = (root) => execFileSync('sh', [SCRIPT, root], { encoding: 'utf8' });
const fresh = () => path.join(mkdtempSync(path.join(tmpdir(), 'persist-')), 'vol', '.home');

describe('dt-persist-home (layout 2: the home IS the volume directory)', () => {
  test('a fresh volume becomes a usable home: editor dir, skeleton dotfiles when the system has them, marker 2', () => {
    const root = fresh();
    run(root);
    assert.ok(lstatSync(path.join(root, '.local/share/code-server/User')).isDirectory());
    assert.equal(readFileSync(path.join(root, '.dt-persist-layout'), 'utf8').trim(), '2');
    if (existsSync('/etc/skel/.bashrc')) assert.ok(existsSync(path.join(root, '.bashrc')));
  });

  test('anything written anywhere in the home stays, including what layout 1 lost (git credentials, history, npmrc)', () => {
    const root = fresh();
    run(root);
    for (const f of ['.git-credentials', '.bash_history', '.npmrc', '.local/bin/tool']) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), f);
    }
    run(root); // the next boot
    for (const f of ['.git-credentials', '.bash_history', '.npmrc', '.local/bin/tool']) assert.equal(readFileSync(path.join(root, f), 'utf8'), f);
  });

  test("a layout-1 volume is migrated once: short names move to their real paths, a person's .bashrc is never replaced", () => {
    const root = fresh();
    mkdirSync(path.join(root, 'claude'), { recursive: true });
    writeFileSync(path.join(root, 'claude', '.credentials.json'), 'login');
    mkdirSync(path.join(root, 'code-server', 'User'), { recursive: true });
    writeFileSync(path.join(root, 'code-server', 'User', 'settings.json'), '{"a":1}');
    mkdirSync(path.join(root, 'config', 'gh'), { recursive: true });
    writeFileSync(path.join(root, 'config', 'gh', 'hosts.yml'), 'gh');
    writeFileSync(path.join(root, 'gitconfig'), '[user]\n\tname = x\n');
    writeFileSync(path.join(root, 'claude.json'), '{"b":2}');
    mkdirSync(path.join(root, 'ssh'), { recursive: true });
    writeFileSync(path.join(root, '.bashrc'), 'mine');
    writeFileSync(path.join(root, '.dt-persist-layout'), '1\n');

    const out = run(root);
    assert.match(out, /layout 1→2/);
    assert.equal(readFileSync(path.join(root, '.claude', '.credentials.json'), 'utf8'), 'login');
    assert.equal(readFileSync(path.join(root, '.local/share/code-server/User/settings.json'), 'utf8'), '{"a":1}');
    assert.equal(readFileSync(path.join(root, '.config/gh/hosts.yml'), 'utf8'), 'gh');
    assert.equal(readFileSync(path.join(root, '.gitconfig'), 'utf8'), '[user]\n\tname = x\n');
    assert.equal(readFileSync(path.join(root, '.claude.json'), 'utf8'), '{"b":2}');
    assert.ok(lstatSync(path.join(root, '.ssh')).isDirectory());
    for (const old of ['claude', 'code-server', 'config', 'gitconfig', 'claude.json', 'ssh']) assert.ok(!existsSync(path.join(root, old)), old);
    assert.equal(readFileSync(path.join(root, '.bashrc'), 'utf8'), 'mine');
    assert.equal(readFileSync(path.join(root, '.dt-persist-layout'), 'utf8').trim(), '2');

    // the next boot changes nothing and says nothing about a migration
    assert.doesNotMatch(run(root), /layout 1→2/);
    assert.equal(readFileSync(path.join(root, '.claude', '.credentials.json'), 'utf8'), 'login');
  });

  test('a migration never overwrites a real path that already exists', () => {
    const root = fresh();
    mkdirSync(path.join(root, 'claude'), { recursive: true });
    writeFileSync(path.join(root, 'claude', 'x'), 'old');
    mkdirSync(path.join(root, '.claude'), { recursive: true });
    writeFileSync(path.join(root, '.claude', 'x'), 'new');
    writeFileSync(path.join(root, '.dt-persist-layout'), '1\n');
    assert.match(run(root), /already exists/);
    assert.equal(readFileSync(path.join(root, '.claude', 'x'), 'utf8'), 'new');
    assert.equal(readFileSync(path.join(root, 'claude', 'x'), 'utf8'), 'old');
  });

  test('refuses to run without a root', () => {
    assert.throws(() => execFileSync('sh', [SCRIPT], { stdio: 'pipe' }));
  });
});
