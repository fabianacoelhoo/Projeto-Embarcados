/* Contrato único de mensagens (docs/protocol.md): confere, lendo o código-fonte, que firmware,
   servidor e simulador usam os mesmos canais, campos de telemetria, comandos e ocorrências. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_COMMANDS } from '../server/routes/devices.js';
import { SEVERITY } from '../server/hub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FW = path.resolve(ROOT, '..', '..', 'esp32-esp8266', 'no-principal');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const main = read(FW, 'src', 'main.cpp');
const net = read(FW, 'src', 'net.cpp');
const sim = read(ROOT, 'tools', 'simulator.js');
const hub = read(ROOT, 'server', 'hub.js');
const doc = read(ROOT, '..', '..', 'docs', 'protocol.md');

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok ${passed} - ${name}`); };

/* canais publicados pela placa (CH_NAMES em net.cpp) */
const fwChannels = JSON.parse(`[${/CH_NAMES\[CH_COUNT\]\s*=\s*\{([^}]+)\}/.exec(net)[1]}]`);

test('canais: o firmware publica os canais do contrato e o servidor reconhece todos', () => {
  assert.deepEqual(fwChannels, ['telemetry', 'events', 'location', 'imu', 'status', 'pong', 'diag', 'calib', 'wifi']);
  for (const ch of fwChannels.filter((c) => c !== 'telemetry')) {
    assert.ok(hub.includes(`'${ch}'`) || hub.includes(`'${ch.replace(/s$/, '')}'`), `hub.js não trata o canal ${ch}`);
    assert.ok(doc.includes(`\`${ch}\``), `docs/protocol.md não documenta o canal ${ch}`);
  }
  for (const ch of [...sim.matchAll(/pub\('([a-z]+)'/g)].map((m) => m[1])) assert.ok(fwChannels.includes(ch), `simulador publica canal fora do contrato: ${ch}`);
});

test('telemetria: firmware e simulador mandam exatamente os mesmos campos', () => {
  const fmt = /"\{\\"t\\":%lu,\\"mode\\":\\"%s\\","([\s\S]*?)\);/.exec(main)[0];
  const fwKeys = ['t', 'mode', ...[...fmt.matchAll(/\\"(\w+)\\":%/g)].map((m) => m[1]).filter((k) => !['t', 'mode'].includes(k))];
  const block = /pub\('telemetry', \{([\s\S]*?)\}\);/.exec(sim)[1];
  const simKeys = [...block.matchAll(/(?:^|[{,])\s*(\w+)\s*(?=[:,}])/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(simKeys)].sort(), [...new Set(fwKeys)].sort());
  for (const k of fwKeys) assert.ok(doc.includes(`"${k}"`), `docs/protocol.md não mostra o campo ${k}`);
});

test('comandos: tudo que o painel manda é tratado pelo firmware e pelo simulador', () => {
  for (const cmd of PANEL_COMMANDS) {
    assert.ok(new RegExp(`strn?cmp\\(cmd, "${cmd}"`).test(main + net), `firmware não trata "${cmd}"`);
    assert.ok(sim.includes(`cmd.cmd === '${cmd}'`), `simulador não trata "${cmd}"`);
    assert.ok(doc.includes(`\`${cmd}\``), `docs/protocol.md não documenta "${cmd}"`);
  }
});

test('ocorrências: todo evento da placa tem gravidade no servidor e está documentado', () => {
  const fromFw = new Set([...main.matchAll(/\\"event\\":\\"([A-Z_]+)\\"/g)].map((m) => m[1]));
  for (const m of main.matchAll(/return "([A-Z_]+)";/g)) if (/^(FALL|IMPACT|CRASH|NEAR_MISS|DISMISSED)$/.test(m[1])) fromFw.add(m[1]);
  fromFw.add('FALL'); fromFw.add('IMPACT');
  for (const e of fromFw) {
    if (e === 'ANCHOR_TOGGLE') continue; /* pedido: vira ANCHOR_CREATED/REMOVED/FAILED no servidor */
    assert.ok(e in SEVERITY, `servidor sem gravidade para ${e}`);
  }
  for (const e of Object.keys(SEVERITY)) assert.ok(doc.includes(`\`${e}\``), `docs/protocol.md não documenta ${e}`);
});

console.log(`${passed} testes do protocolo passaram`);
