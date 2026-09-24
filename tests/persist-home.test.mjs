// dt-persist-home: the durable parts of $HOME live on the volume and survive a fresh home directory.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../hq/persist-home.sh', import.meta.url));
const run = (root, home) => execFileSync('sh', [SCRIPT, root, home], { encoding: 'utf8' });

describe('dt-persist-home', () => {
  test('moves baked-in state onto the volume once, links it, and writes the layout marker', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'persist-'));
    const home = path.join(base, 'home');
    const root = path.join(base, 'vol', '.home');
    mkdirSync(path.join(home, '.local/share/code-server/User'), { recursive: true });
    writeFileSync(path.join(home, '.local/share/code-server/User/settings.json'), '{"git.autofetch":true}');
    writeFileSync(path.join(home, '.claude.json'), '{"a":1}');

    run(root, home);
    assert.equal(readFileSync(path.join(root, 'code-server/User/settings.json'), 'utf8'), '{"git.autofetch":true}');
    assert.equal(readlinkSync(path.join(home, '.local/share/code-server')), path.join(root, 'code-server'));
    assert.equal(readlinkSync(path.join(home, '.claude.json')), path.join(root, 'claude.json'));
    assert.equal(readFileSync(path.join(root, 'claude.json'), 'utf8'), '{"a":1}');
    for (const rel of ['.claude', '.codex', '.gemini', '.config', '.ssh', '.gitconfig']) assert.ok(lstatSync(path.join(home, rel)).isSymbolicLink(), rel);
    assert.equal(readFileSync(path.join(root, '.dt-persist-layout'), 'utf8').trim(), '1');
  });

  test('a fresh home (machine replaced) gets the volume’s state back, and running twice is a no-op', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'persist-'));
    const root = path.join(base, 'vol', '.home');
    const home1 = path.join(base, 'home1');
    mkdirSync(path.join(home1, '.claude'), { recursive: true });
    writeFileSync(path.join(home1, '.claude', 'login.json'), 'session-from-first-machine');
    run(root, home1);
    run(root, home1);
    assert.equal(readFileSync(path.join(home1, '.claude', 'login.json'), 'utf8'), 'session-from-first-machine');

    const home2 = path.join(base, 'home2'); // a brand-new machine, same volume
    mkdirSync(path.join(home2, '.claude'), { recursive: true });
    writeFileSync(path.join(home2, '.claude', 'login.json'), 'baked-empty-state');
    run(root, home2);
    // the volume wins; the new machine's baked state is discarded, not merged over the persisted login
    assert.equal(readFileSync(path.join(home2, '.claude', 'login.json'), 'utf8'), 'session-from-first-machine');
    assert.equal(readlinkSync(path.join(home2, '.claude')), path.join(root, 'claude'));
    assert.ok(!existsSync(path.join(base, 'home2', '.claude', 'stray')));
  });

  test('refuses to run without a root', () => {
    assert.throws(() => execFileSync('sh', [SCRIPT], { stdio: 'pipe' }));
  });
});
