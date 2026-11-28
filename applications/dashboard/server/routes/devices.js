/* Dispositivos: estado geral, leituras, calibrações, nome e comandos para a placa. */

/* comandos que o painel pode mandar para a placa (o resto e recusado).
   Vao pelo Wi-Fi (MQTT) e, com a placa no USB e o servidor lendo a Serial, tambem pelo cabo. */
export const PANEL_COMMANDS = new Set(['locate', 'portal', 'wifi', 'diag', 'server', 'haptic', 'calibrate_start', 'calibrate_stop', 'calibrate_reset', 'wifi_scan']);
/* padroes da linguagem haptica (include/haptic_engine.h) */
export const HAPTIC_PATTERNS = ['static', 'proximity', 'approach', 'prealert', 'heartbeat', 'confirm', 'locate'];
const isIpv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((n) => Number(n) <= 255);

export function buildCommand(body) {
  const cmd = body?.cmd;
  if (!PANEL_COMMANDS.has(cmd)) return { error: `comando invalido (aceitos: ${[...PANEL_COMMANDS].join(', ')})` };
  if (cmd === 'server') {
    /* onde a placa procura o servidor MQTT: "auto" (descoberta na rede) ou um IP fixo */
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : 'auto';
    if (host !== 'auto' && !isIpv4(host)) return { error: 'Servidor: use "auto" ou um IP como 192.168.0.10.' };
    return { command: { cmd, host } };
  }
  if (cmd === 'haptic') {
    if (!HAPTIC_PATTERNS.includes(body.pattern)) return { error: `Padrão inválido (aceitos: ${HAPTIC_PATTERNS.join(', ')}).` };
    return { command: { cmd, pattern: body.pattern } };
  }
  if (cmd === 'calibrate_start') {
    /* calibracao assistida: 10 a 120 s andando (padrao 30) */
    const s = body.duration_s == null ? 30 : Number(body.duration_s);
    if (!Number.isInteger(s) || s < 10 || s > 120) return { error: 'Duração da calibração: de 10 a 120 segundos.' };
    return { command: { cmd, duration_s: s } };
  }
  if (cmd !== 'wifi') return { command: { cmd } };
  const ssid = typeof body.ssid === 'string' ? body.ssid.trim() : '';
  const pass = typeof body.pass === 'string' ? body.pass : '';
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  if (!ssid || Buffer.byteLength(ssid) > 32) return { error: 'Digite o nome da rede (até 32 caracteres).' };
  if (pass && (pass.length < 8 || pass.length > 63)) return { error: 'A senha do Wi-Fi tem de 8 a 63 caracteres (deixe vazia para rede aberta).' };
  if (host && host !== 'auto' && !isIpv4(host)) return { error: 'Servidor: use "auto" ou um IP como 192.168.0.10.' };
  return { command: { cmd, ssid, pass, ...(host ? { host } : {}) } };
}

export function registerDeviceRoutes(app, ctx) {
  const { config, db, hub, usb } = ctx;

  app.get('/api/state', (req, res) => {
    res.json({ devices: hub.listDevices(), events: db.events({ limit: 100 }), config: ctx.publicConfig(req), serial: usb.publicState() });
  });

  app.get('/api/devices/:id/readings', (req, res) => {
    const kind = String(req.query.kind ?? 'proximity');
    /* intervalo exato (ex.: leituras em volta de uma ocorrencia): ?from=ms&to=ms, no maximo 1 h */
    if (req.query.from != null && req.query.to != null) {
      const from = Number(req.query.from), to = Math.min(Number(req.query.to), from + 3600000);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return res.status(400).json({ error: 'from/to invalidos' });
      return res.json(db.readingsRange(req.params.id, kind, from, to));
    }
    const minutes = Math.min(Number(req.query.minutes ?? 10), 60 * 24 * 7);
    res.json(db.readings(req.params.id, kind, Date.now() - minutes * 60000));
  });

  /* historico de calibracoes (feitas, que falharam e restauracoes de fabrica), mais recente primeiro */
  app.get('/api/devices/:id/calibrations', (req, res) => {
    res.json(db.calibrations(req.params.id, Math.min(Number(req.query.limit ?? 20), 100)));
  });

  app.patch('/api/devices/:id', (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : null;
    const d = hub.renameDevice(req.params.id, name);
    if (!d) return res.status(404).json({ error: 'dispositivo nao encontrado' });
    res.json(d);
  });

  app.post('/api/devices/:id/command', (req, res) => {
    const { command, error } = buildCommand(req.body);
    if (error) return res.status(400).json({ sent: false, error });
    const d = hub.devices.get(req.params.id);
    const onUsb = usb.state.status === 'connected' && (usb.state.deviceId ?? config.serial.deviceId) === req.params.id;
    if (!d?.online && !onUsb) return res.status(409).json({ sent: false, error: 'O EchoMap está desconectado: ligue o cabo USB ou use o celular (3 cliques no botão).' });
    if (command.cmd === 'wifi') hub.expectReconnect(req.params.id, 45000); /* teste da rede nova + volta */
    if (command.cmd === 'server') hub.expectReconnect(req.params.id, 15000); /* a placa refaz a conexao MQTT */
    const ok = hub.sendCommand(req.params.id, command);
    res.status(ok ? 202 : 503).json({ sent: ok });
  });

  app.get('/api/events', (req, res) => {
    res.json(db.events({ deviceId: req.query.deviceId || undefined, limit: Math.min(Number(req.query.limit ?? 100), 1000) }));
  });

  app.post('/api/events/:id/ack', (req, res) => {
    const evt = hub.ackEvent(Number(req.params.id));
    if (!evt) return res.status(404).json({ error: 'evento nao encontrado' });
    res.json(evt);
  });
}
