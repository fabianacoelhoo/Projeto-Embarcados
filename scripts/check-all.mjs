#!/usr/bin/env node
/* Todas as validações antes de commitar (Windows, Linux e macOS):
     cd applications/dashboard && npm run check:all
   Roda: higiene do repositório, sintaxe dos .js, npm test, testes C++ do firmware (se houver g++)
   e o build do PlatformIO (se o comando pio existir). O que não estiver instalado é pulado com aviso. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASH = path.join(ROOT, 'applications', 'dashboard');
const FW = path.join(ROOT, 'esp32-esp8266', 'no-principal');
const results = [];

const run = (name, cmd, args, opts = {}) => {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(cmd, args, { stdio: opts.capture ? 'pipe' : 'inherit', encoding: 'utf8', shell: process.platform === 'win32', ...opts });
  const ok = r.status === 0;
  results.push([name, ok ? 'ok' : 'FALHOU']);
  return { ok, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
const skip = (name, why) => { console.log(`\n=== ${name} ===\n(pulado: ${why})`); results.push([name, `pulado (${why})`]); };

run('Higiene do repositório', process.execPath, [path.join(ROOT, 'scripts', 'check-repo.mjs')]);

/* sintaxe de todos os .js/.mjs do servidor, do painel e das ferramentas */
const jsFiles = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name);
  if (e.isDirectory() && !['node_modules', 'vendor', 'data'].includes(e.name)) walk(p);
  else if (/\.(m?js)$/.test(e.name)) jsFiles.push(p);
} };
for (const d of ['server', 'public', 'tools']) walk(path.join(DASH, d));
console.log(`\n=== Sintaxe (node --check, ${jsFiles.length} arquivos) ===`);
const bad = jsFiles.filter((f) => spawnSync(process.execPath, ['--check', f], { stdio: 'inherit' }).status !== 0);
results.push(['Sintaxe JS', bad.length ? `FALHOU (${bad.length})` : 'ok']);

run('npm test (painel e servidor)', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { cwd: DASH });

if (has('g++')) {
  const dir = path.join(FW, 'host_test');
  const out = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || process.env.TEMP || '/tmp'), 'echomap-')), 't');
  let ok = true;
  console.log('\n=== Testes C++ do firmware (g++ -Wall -Wextra -Werror) ===');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.cpp'))) {
    const exe = `${out}_${path.basename(f, '.cpp')}${process.platform === 'win32' ? '.exe' : ''}`;
    const c = spawnSync('g++', ['-std=c++11', '-Wall', '-Wextra', '-Werror', '-I../include', f, '-o', exe], { cwd: dir, stdio: 'inherit' });
    const r = c.status === 0 ? spawnSync(exe, [], { encoding: 'utf8' }) : { status: 1, stdout: '' };
    console.log(`${f}: ${r.status === 0 ? (r.stdout.trim().split('\n').pop() || 'ok') : 'FALHOU'}`);
    ok &&= r.status === 0;
  }
  results.push(['Testes C++ do firmware', ok ? 'ok' : 'FALHOU']);
} else skip('Testes C++ do firmware', 'g++ não encontrado');

const pio = has('pio') ? 'pio' : has('platformio') ? 'platformio' : null;
if (pio) {
  const r = run('Build do firmware (PlatformIO)', pio, ['run', '-d', FW], { capture: true });
  console.log(r.out.split('\n').filter((l) => /RAM:|Flash:|SUCCESS|FAILED|error|warning/.test(l)).join('\n'));
} else skip('Build do firmware (PlatformIO)', 'comando pio não encontrado; use Build no VS Code');

console.log('\n=== Resumo ===');
for (const [n, s] of results) console.log(`${s.startsWith('ok') ? '✔' : s.startsWith('pulado') ? '•' : '✘'} ${n}: ${s}`);
process.exit(results.some(([, s]) => s.startsWith('FALHOU')) ? 1 : 0);
