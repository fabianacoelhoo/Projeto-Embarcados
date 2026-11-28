/* Alertas por e-mail (EMAIL_PROVIDER=mock): gatilhos, "Estou bem" suprimido, cooldown, fila com nova
   tentativa, histórico no SQLite e link do Google Maps. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { buildMessage, createEmailNotifier, emailConfigFromEnv, mapsLink } from '../server/services/emailNotifier.js';

const results = [];
const test = async (name, fn) => { await fn(); results.push(name); console.log(`ok ${results.length} - ${name}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echomap-email-'));
const quiet = { log() {}, warn() {} };

const env = { EMAIL_ENABLED: '1', EMAIL_PROVIDER: 'mock', ALERT_EMAIL_TO: 'mae@exemplo.com, pai@exemplo.com', EMAIL_FROM: 'echomap@exemplo.com', EMAIL_COOLDOWN_S: '180' };
const ev = (type, extra = {}) => ({ id: Math.floor(Math.random() * 1e6), deviceId: 'node1', ts: Date.UTC(2026, 10, 28, 14, 40, 5), type, severity: 'critical', data: {}, ...extra });

function setup(over = {}, opts = {}) {
  const db = openDb(path.join(dir, `${Math.random().toString(16).slice(2)}.db`));
  const sent = [];
  let clock = Date.UTC(2026, 10, 28, 14, 40, 5);
  const transport = opts.transport ?? { sendMail: async (m) => { sent.push(m); return { messageId: 'x' }; } };
  const n = createEmailNotifier({
    db, config: emailConfigFromEnv({ ...env, ...over }), transport, log: quiet, retryDelaysMs: opts.retryDelaysMs ?? [20, 20],
    now: () => clock, deviceOf: () => ({ name: 'Ana', online: true, source: 'mqtt', battery: 76 }),
    whereOf: () => opts.where ?? { lat: -8.063350, lon: -34.871120, ageS: 2 },
  });
  return { db, n, sent, tick: (ms) => { clock += ms; } };
}

await test('configuração pelo .env: provedor, destinatários, cooldown e SES pelo SMTP da AWS', () => {
  const c = emailConfigFromEnv(env);
  assert.deepEqual([c.enabled, c.provider, c.to, c.cooldownMs], [true, 'mock', ['mae@exemplo.com', 'pai@exemplo.com'], 180000]);
  const ses = emailConfigFromEnv({ EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'ses', AWS_REGION: 'sa-east-1', SMTP_PORT: '465' });
  assert.equal(ses.host, 'email-smtp.sa-east-1.amazonaws.com');
  assert.equal(ses.secure, true);
  assert.equal(emailConfigFromEnv({}).enabled, false);
  assert.deepEqual(emailConfigFromEnv({ ALERT_EMAIL_TO: 'ok@x.com, nao-e-email' }).invalidTo, ['nao-e-email']);
});

await test('gatilhos: queda, SOS e saída de zona viram e-mail; "Estou bem", quase colisão e impacto não', async () => {
  const { n, sent, db } = setup();
  assert.equal(n.onEvent(ev('FALL', { data: { value: 3.5, tilt: 80 } })).queued, true);
  assert.equal(n.onEvent(ev('CRASH')).queued, true);
  assert.equal(n.onEvent(ev('GEOFENCE_EXIT', { data: { zone: 'Casa', lat: -8.1, lon: -34.9 } })).queued, true);
  for (const t of ['DISMISSED', 'NEAR_MISS', 'IMPACT', 'GEOFENCE_ENTER', 'LOW_BATTERY']) assert.equal(n.onEvent(ev(t)).queued, false, t);
  await n.idle();
  assert.equal(sent.length, 3);
  assert.equal(sent[0].to, 'mae@exemplo.com, pai@exemplo.com');
  const hist = db.notifications(20);
  assert.equal(hist.length, 6, 'uma linha por destinatário');
  assert.ok(hist.every((h) => h.status === 'mock'));
});

await test('cooldown de 180 s por dispositivo e tipo; SOS e CRASH contam como o mesmo', async () => {
  const { n, sent, tick } = setup();
  assert.equal(n.onEvent(ev('FALL')).queued, true);
  tick(60000);
  assert.deepEqual(n.onEvent(ev('FALL')), { queued: false, reason: 'cooldown' });
  assert.equal(n.onEvent(ev('FALL', { deviceId: 'node2' })).queued, true, 'outro dispositivo não espera');
  assert.equal(n.onEvent(ev('CRASH')).queued, true);
  assert.equal(n.onEvent(ev('SOS')).queued, false);
  tick(121000);
  assert.equal(n.onEvent(ev('FALL')).queued, true, 'passou o cooldown');
  await n.idle();
  assert.equal(sent.length, 4);
});

await test('desativado ou sem destinatário: nada sai', () => {
  assert.equal(setup({ EMAIL_ENABLED: '0' }).n.onEvent(ev('FALL')).reason, 'disabled');
  assert.equal(setup({ ALERT_EMAIL_TO: '' }).n.onEvent(ev('FALL')).reason, 'no-recipient');
});

await test('falha de envio: onEvent não espera, tenta de novo e grava "failed" no fim', async () => {
  let calls = 0;
  const failing = { sendMail: async () => { calls += 1; throw new Error('sem internet'); } };
  const { n, db } = setup({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.exemplo.com', SMTP_USER: 'u', SMTP_PASS: 'p' }, { transport: failing });
  const t0 = performance.now();
  n.onEvent(ev('FALL'));
  assert.ok(performance.now() - t0 < 50, 'não bloqueia quem chamou');
  await new Promise((r) => setTimeout(r, 150));
  await n.idle();
  assert.equal(calls, 3, '1 tentativa + 2 novas');
  const h = db.notifications(5);
  assert.equal(h[0].status, 'failed');
  assert.equal(h[0].error, 'sem internet');
});

await test('uma falha passageira e depois sucesso grava "sent"', async () => {
  let calls = 0;
  const flaky = { sendMail: async () => { calls += 1; if (calls === 1) throw new Error('timeout'); return {}; } };
  const { n, db } = setup({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }, { transport: flaky });
  n.onEvent(ev('FALL'));
  await new Promise((r) => setTimeout(r, 100));
  await n.idle();
  assert.deepEqual(db.notifications(5).map((x) => x.status), ['sent', 'sent']);
});

await test('conteúdo: assunto, horário de Recife, link do Google Maps e ambiente interno', () => {
  assert.equal(mapsLink(-8.06335, -34.87112), 'https://maps.google.com/?q=-8.063350,-34.871120');
  const m = buildMessage({ event: ev('FALL', { data: { value: 3.5, tilt: 80 } }), device: { name: 'Ana', online: true, battery: 76, source: 'mqtt' }, where: { lat: -8.06335, lon: -34.87112, ageS: 2 } });
  assert.match(m.subject, /^\[EchoMap ALERTA\] Queda detectada — 28\/11\/2026,? 11:40:05$/);
  assert.match(m.text, /Horário: 28\/11\/2026,? 11:40:05 \(horário de Recife\)/);
  assert.match(m.text, /https:\/\/maps\.google\.com\/\?q=-8\.063350,-34\.871120/);
  assert.match(m.html, /<a href="https:\/\/maps\.google\.com\/\?q=-8\.063350,-34\.871120"/);
  assert.match(m.text, /bateria 76%/);
  const indoor = buildMessage({ event: ev('GEOFENCE_EXIT', { data: { zone: 'Casa' } }), where: { indoorPlace: 'CESAR <School>' } });
  assert.match(indoor.text, /Ambiente interno conhecido pelo Wi-Fi: CESAR <School>/);
  assert.match(indoor.html, /CESAR &lt;School&gt;/, 'HTML escapado');
  assert.match(buildMessage({ event: ev('CRASH'), where: null }).text, /sem posição de GPS/);
});

await test('e-mail de teste e estado da tela Dispositivo (destinatário mascarado fora do PC)', async () => {
  const { n, sent } = setup();
  assert.equal(n.sendTest('node1').queued, true);
  await n.idle();
  assert.match(sent[0].subject, /^\[EchoMap TESTE\]/);
  const remote = n.status();
  assert.equal(remote.mode, 'mock');
  assert.deepEqual(remote.recipients, ['ma***@exemplo.com', 'pa***@exemplo.com']);
  assert.equal(remote.recent[0].type, 'TEST');
  assert.deepEqual(n.status({ local: true }).recipients, ['mae@exemplo.com', 'pai@exemplo.com']);
  assert.deepEqual(setup({ EMAIL_PROVIDER: 'smtp' }).n.status().problems, ['SMTP_HOST vazio', 'SMTP_USER/SMTP_PASS vazios']);
});

console.log(`${results.length} testes de e-mail passaram`);
