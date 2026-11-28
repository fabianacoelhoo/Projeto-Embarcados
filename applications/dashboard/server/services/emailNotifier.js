/* Alertas críticos por e-mail.
   Provedores (EMAIL_PROVIDER):
     smtp - qualquer servidor SMTP (Gmail com senha de app, Brevo, Resend, servidor próprio)
     ses  - SMTP do Amazon SES (email-smtp.<AWS_REGION>.amazonaws.com, credenciais SMTP do SES)
     mock - não envia nada: só registra no banco e no terminal (testes e desenvolvimento)
   Dispara para queda confirmada (FALL, que só sai depois do pré-alerta de 5 s), pedido de ajuda
   (CRASH/SOS, botão segurado) e saída de zona segura (GEOFENCE_EXIT). Nunca para "Estou bem"
   (DISMISSED) nem para quase colisões. Cooldown por dispositivo + tipo (padrão 180 s). O envio é
   assíncrono, numa fila com novas tentativas: a falta de internet nunca trava o servidor. */

export const EMAIL_TRIGGERS = {
  FALL: { title: 'Queda detectada', severity: 'crítica' },
  CRASH: { title: 'Pedido de ajuda (botão SOS)', severity: 'crítica' },
  SOS: { title: 'Pedido de ajuda (botão SOS)', severity: 'crítica' },
  GEOFENCE_EXIT: { title: 'Saída da zona segura', severity: 'grave' },
};
export const TIME_ZONE = 'America/Recife';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isEmail = (s) => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s);

export function mapsLink(lat, lon) {
  return `https://maps.google.com/?q=${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
}

export function formatLocalTime(ts, timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ts));
}

/* configuração a partir do ambiente (.env) */
export function emailConfigFromEnv(env = process.env) {
  const provider = String(env.EMAIL_PROVIDER || 'smtp').toLowerCase();
  const to = String(env.ALERT_EMAIL_TO || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const port = Number(env.SMTP_PORT || 587);
  return {
    enabled: /^(1|true|sim|yes|on)$/i.test(String(env.EMAIL_ENABLED || '')),
    provider: ['smtp', 'ses', 'mock'].includes(provider) ? provider : 'smtp',
    host: env.SMTP_HOST || (provider === 'ses' ? `email-smtp.${env.AWS_REGION || 'us-east-1'}.amazonaws.com` : ''),
    port,
    secure: env.SMTP_SECURE ? /^(1|true)$/i.test(env.SMTP_SECURE) : port === 465,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.EMAIL_FROM || env.SMTP_USER || '',
    to: to.filter(isEmail),
    invalidTo: to.filter((s) => !isEmail(s)),
    cooldownMs: Math.max(0, Number(env.EMAIL_COOLDOWN_S ?? 180)) * 1000,
    panelUrl: env.PANEL_URL || '',
  };
}

/* assunto, texto e HTML de uma ocorrência */
export function buildMessage({ event, device = {}, where = null, panelUrl = '' }) {
  const trig = EMAIL_TRIGGERS[event.type] ?? { title: event.type, severity: event.severity ?? '' };
  const when = formatLocalTime(event.ts);
  const name = device.name || event.deviceId;
  const subject = `[EchoMap ALERTA] ${trig.title} — ${when}`;
  const d = event.data ?? {};
  const details = [];
  if (event.type === 'FALL' && d.value != null) details.push(`Pico de ${Number(d.value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} g${d.tilt != null ? `, inclinação de ${Math.round(d.tilt)}°` : ''}`);
  if (event.type === 'GEOFENCE_EXIT' && d.zone) details.push(`Saiu da zona "${d.zone}"`);

  let placeText, placeHtml;
  if (where?.indoorPlace) {
    placeText = `Ambiente interno conhecido pelo Wi-Fi: ${where.indoorPlace}${where.lat != null ? ` (${mapsLink(where.lat, where.lon)})` : ''}`;
    placeHtml = `Ambiente interno conhecido pelo Wi-Fi: <b>${esc(where.indoorPlace)}</b>${where.lat != null ? ` · <a href="${mapsLink(where.lat, where.lon)}">ver no Google Maps</a>` : ''}`;
  } else if (where?.lat != null && where?.lon != null) {
    const link = mapsLink(where.lat, where.lon);
    const age = where.ageS != null && where.ageS > 30 ? ` (posição de ${Math.round(where.ageS / 60) || 1} min atrás)` : '';
    placeText = `${link}${age}`;
    placeHtml = `<a href="${link}" style="color:#1d4ed8;font-weight:600">Abrir no Google Maps</a>${esc(age)}<br><span style="color:#6b7280;font-size:13px">${Number(where.lat).toFixed(6)}, ${Number(where.lon).toFixed(6)}</span>`;
  } else {
    placeText = 'sem posição de GPS no momento';
    placeHtml = 'Sem posição de GPS no momento.';
  }
  const state = [
    device.online === false ? 'desconectado' : 'conectado',
    device.battery != null ? `bateria ${Math.round(device.battery)}%` : null,
    device.source === 'serial' ? 'pelo cabo USB' : device.source === 'mqtt' ? 'pelo Wi-Fi' : null,
  ].filter(Boolean).join(', ');

  const text = [
    `${trig.title} — ${name}`,
    '',
    `Tipo: ${trig.title} (${event.type})`,
    `Gravidade: ${trig.severity}`,
    `Horário: ${when} (horário de Recife)`,
    ...details.map((x) => `Detalhe: ${x}`),
    `Local: ${placeText}`,
    `Dispositivo: ${name} (${state})`,
    panelUrl ? `Painel: ${panelUrl}` : '',
    '',
    'Mensagem automática do EchoMap. Confira a pessoa e marque a ocorrência como ciente no painel.',
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');

  const row = (k, v) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${k}</td><td style="padding:6px 0;color:#111827">${v}</td></tr>`;
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
    <p style="margin:0 0 4px;color:#b91c1c;font-weight:700;font-size:13px">ALERTA ${esc(trig.severity.toUpperCase())}</p>
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827">${esc(trig.title)} — ${esc(name)}</h1>
    <table role="presentation" style="border-collapse:collapse;font-size:15px;width:100%">
      ${row('Horário', `${esc(when)} <span style="color:#6b7280">(Recife)</span>`)}
      ${details.map((x) => row('Detalhe', esc(x))).join('')}
      ${row('Local', placeHtml)}
      ${row('Dispositivo', `${esc(name)} · ${esc(state)}`)}
    </table>
    ${panelUrl ? `<p style="margin:20px 0 0"><a href="${esc(panelUrl)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Abrir o painel</a></p>` : ''}
  </div>
  <p style="color:#6b7280;font-size:12px;margin:12px 4px 0">Mensagem automática do EchoMap. Confira a pessoa e marque a ocorrência como ciente no painel.</p>
</div></body></html>`;
  return { subject, text, html };
}

/* transporte de envio: nodemailer (smtp/ses) ou mock */
async function defaultTransport(cfg) {
  if (cfg.provider === 'mock') return { sendMail: async () => ({ messageId: `mock-${Date.now()}` }) };
  const { default: nodemailer } = await import('nodemailer');
  return nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
  });
}

export function createEmailNotifier({ db, config, whereOf = () => null, deviceOf = () => ({}), transport = null, retryDelaysMs = [5000, 30000], now = () => Date.now(), log = console }) {
  const cfg = config;
  const last = new Map(); /* `${deviceId}:${type}` -> ts do último e-mail */
  const queue = [];
  let busy = false;
  let transportPromise = null;
  const getTransport = () => (transportPromise ??= transport ? Promise.resolve(transport) : defaultTransport(cfg));

  const mode = () => (!cfg.enabled ? 'disabled' : cfg.provider === 'mock' ? 'mock' : 'active');
  const problems = () => {
    const p = [];
    if (!cfg.to.length) p.push('ALERT_EMAIL_TO vazio');
    if (cfg.invalidTo?.length) p.push(`destinatário inválido: ${cfg.invalidTo.join(', ')}`);
    if (cfg.provider !== 'mock') {
      if (!cfg.host) p.push('SMTP_HOST vazio');
      if (!cfg.from) p.push('EMAIL_FROM vazio');
      if (!cfg.user || !cfg.pass) p.push('SMTP_USER/SMTP_PASS vazios');
    }
    return p;
  };

  async function deliver(job) {
    const status = cfg.provider === 'mock' ? 'mock' : 'sent';
    try {
      const t = await getTransport();
      await t.sendMail({ from: cfg.from || 'echomap@localhost', to: job.to.join(', '), subject: job.msg.subject, text: job.msg.text, html: job.msg.html });
      for (const to of job.to) db.insertNotification({ ts: now(), eventId: job.eventId, deviceId: job.deviceId, type: job.type, recipient: to, status, error: null, subject: job.msg.subject });
      log.log?.(`[EMAIL] ${status === 'mock' ? 'Simulado (mock)' : 'Enviado'}: ${job.msg.subject} -> ${job.to.join(', ')}`);
      return true;
    } catch (err) {
      job.attempt += 1;
      const delay = retryDelaysMs[job.attempt - 1];
      if (delay != null) {
        log.warn?.(`[EMAIL] Falhou (${err.message}); nova tentativa em ${Math.round(delay / 1000)} s.`);
        setTimeout(() => { queue.push(job); pump(); }, delay).unref?.();
      } else {
        for (const to of job.to) db.insertNotification({ ts: now(), eventId: job.eventId, deviceId: job.deviceId, type: job.type, recipient: to, status: 'failed', error: String(err.message).slice(0, 300), subject: job.msg.subject });
        log.warn?.(`[EMAIL] Falhou de vez: ${err.message}`);
      }
      return false;
    }
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) await deliver(queue.shift());
    } finally {
      busy = false;
    }
  }

  function enqueue(job) {
    queue.push({ attempt: 0, ...job });
    setImmediate(pump);
  }

  /* chamado a cada ocorrência nova: decide se vira e-mail (sem bloquear quem chamou) */
  function onEvent(event) {
    if (!cfg.enabled || !EMAIL_TRIGGERS[event.type] || !cfg.to.length) return { queued: false, reason: !cfg.enabled ? 'disabled' : !cfg.to.length ? 'no-recipient' : 'not-a-trigger' };
    const key = `${event.deviceId}:${event.type === 'SOS' ? 'CRASH' : event.type}`;
    const t = now();
    if (last.has(key) && t - last.get(key) < cfg.cooldownMs) return { queued: false, reason: 'cooldown' };
    last.set(key, t);
    const msg = buildMessage({ event, device: deviceOf(event.deviceId), where: whereOf(event.deviceId, event), panelUrl: cfg.panelUrl });
    enqueue({ eventId: event.id ?? null, deviceId: event.deviceId, type: event.type, to: cfg.to, msg });
    return { queued: true };
  }

  /* botão "Enviar e-mail de teste": mesmo caminho, sem cooldown; funciona também em modo mock */
  function sendTest(deviceId = 'node1') {
    if (!cfg.to.length) return { error: 'Defina ALERT_EMAIL_TO no .env do painel.' };
    const ev = { id: null, deviceId, ts: now(), type: 'FALL', severity: 'critical', data: { value: 3.2, tilt: 75 } };
    const msg = buildMessage({ event: ev, device: deviceOf(deviceId), where: whereOf(deviceId, ev), panelUrl: cfg.panelUrl });
    msg.subject = msg.subject.replace('[EchoMap ALERTA]', '[EchoMap TESTE]');
    enqueue({ eventId: null, deviceId, type: 'TEST', to: cfg.to, msg });
    return { queued: true, to: cfg.to };
  }

  const mask = (e) => e.replace(/^(.{2}).*(@.*)$/, '$1***$2');
  function status({ local = false } = {}) {
    return {
      mode: mode(),
      provider: cfg.provider,
      recipients: local ? cfg.to : cfg.to.map(mask),
      cooldownS: Math.round(cfg.cooldownMs / 1000),
      triggers: Object.keys(EMAIL_TRIGGERS).filter((k) => k !== 'SOS'),
      problems: cfg.enabled ? problems() : [],
      pending: queue.length,
      recent: db.notifications(10).map((n) => ({ ...n, recipient: local ? n.recipient : mask(n.recipient) })),
    };
  }

  /* espera a fila esvaziar (testes) */
  const idle = async () => { while (busy || queue.length) await new Promise((r) => setTimeout(r, 10)); };
  return { onEvent, sendTest, status, idle, config: cfg };
}
