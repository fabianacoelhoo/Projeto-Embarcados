#!/usr/bin/env node
/* Higiene do repositório (CI e check:all):
   1. nenhum arquivo proibido rastreado pelo git (segredos, bancos locais, arquivos do assistente);
   2. as pastas obrigatórias do modelo da disciplina existem;
   3. nenhuma imagem com caminho relativo quebrado nos README.md. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
const FORBIDDEN = [
  [/(^|\/)CLAUDE\.md$/i, 'arquivo do assistente'],
  [/(^|\/)\.claude\//, 'pasta do assistente'],
  [/(^|\/)Claude outputs\//, 'saídas do assistente'],
  [/(^|\/)secrets\.h$/, 'credenciais do firmware (use secrets.example.h)'],
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, 'variáveis de ambiente (use .env.example)'],
  [/\.(pem|key|p12|pfx)$/i, 'chave/certificado'],
  [/\.(db|db-wal|db-shm|sqlite3?)$/i, 'banco de dados local'],
  [/(^|\/)data\/auth\.json$/, 'senha gerada do painel'],
];
for (const f of tracked) {
  for (const [re, why] of FORBIDDEN) if (re.test(f)) errors.push(`rastreado e proibido (${why}): ${f}`);
}

for (const dir of ['docs', 'applications', 'esp32-esp8266', 'schematics']) {
  if (!fs.existsSync(path.join(ROOT, dir)) || !fs.statSync(path.join(ROOT, dir)).isDirectory()) errors.push(`pasta obrigatória ausente: ${dir}/`);
}
if (!fs.existsSync(path.join(ROOT, 'README.md'))) errors.push('README.md ausente na raiz');

const readmes = tracked.filter((f) => /(^|\/)README\.md$/i.test(f) && !f.includes('node_modules/'));
let checked = 0;
for (const f of readmes) {
  const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const links = [...text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), ...text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const link of links) {
    if (/^(https?:|data:|mailto:|#)/i.test(link)) continue;
    checked += 1;
    const target = path.resolve(ROOT, path.dirname(f), decodeURIComponent(link.split('#')[0].split('?')[0]));
    if (!fs.existsSync(target)) errors.push(`imagem quebrada em ${f}: ${link}`);
  }
}

if (errors.length) {
  console.error(`Higiene do repositório: ${errors.length} problema(s)`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`Higiene do repositório ok: ${tracked.length} arquivos rastreados, ${readmes.length} README, ${checked} imagens relativas conferidas.`);
