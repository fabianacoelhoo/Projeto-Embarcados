import { EventEmitter } from 'node:events';

/* Cabo USB (Serial) com detecção automática.
   - A cada pollMs lista as portas e reconhece os conversores USB-serial das placas ESP32.
   - Uma placa só: conecta sozinho. Mais de uma: espera o usuário escolher no painel.
   - Desconectou o cabo: volta a procurar (hot-plug).
   - "Liberar a porta": solta a COM por alguns minutos para o PlatformIO gravar o firmware.
   - --serial COM5 (ou serial.path no config.json) vira escolha manual fixa.
   O JSON que a placa imprime vira leitura no hub; as outras linhas ([NET] ...) vão para o painel. */

const CHIPS = {
  '10c4': 'Silicon Labs CP210x',
  '1a86': 'WCH CH340/CH9102',
  '0403': 'FTDI',
  '303a': 'Espressif USB nativo',
  '067b': 'Prolific PL2303',
};

export function describePort(p) {
  const vid = String(p.vendorId ?? '').toLowerCase();
  const text = `${p.manufacturer ?? ''} ${p.friendlyName ?? ''} ${p.pnpId ?? ''}`;
  const bluetooth = /bluetooth|BTHENUM/i.test(text);
  const chip = CHIPS[vid]
    ?? (/cp210|silicon labs/i.test(text) ? CHIPS['10c4']
      : /ch34|ch910|wch/i.test(text) ? CHIPS['1a86']
        : /ftdi/i.test(text) ? CHIPS['0403']
          : /espressif|usb jtag/i.test(text) ? CHIPS['303a'] : null);
  return {
    path: p.path,
    chip,
    compatible: Boolean(chip) && !bluetooth,
    label: chip ? `${p.path} (${chip})` : `${p.path}${p.friendlyName ? ` (${p.friendlyName.replace(/\s*\(COM\d+\)$/i, '')})` : ''}`,
  };
}

/* portas compatíveis primeiro; Bluetooth e afins por último */
export function sortPorts(ports) {
  return [...ports].sort((a, b) => Number(b.compatible) - Number(a.compatible) || a.path.localeCompare(b.path, undefined, { numeric: true }));
}

function friendlyError(err, path) {
  const m = String(err?.message ?? err);
  if (/access denied|acesso negado|busy|resource busy|EBUSY|locked|in use/i.test(m)) {
    return `${path} está em uso por outro programa (Serial Monitor ou upload do PlatformIO?). Feche-o; tentando de novo.`;
  }
  if (/file not found|no such file|cannot find|ENOENT|não pode encontrar/i.test(m)) return `${path} não existe mais (cabo desconectado?).`;
  return `Não foi possível abrir ${path}: ${m}`;
}

export class SerialManager extends EventEmitter {
  constructor(hub, cfg, { lib = null } = {}) {
    super();
    this.hub = hub;
    this.cfg = cfg;
    this.lib = lib;
    this.port = null;
    this.retryAt = new Map(); /* path -> ms: não martela uma porta ocupada */
    this.state = {
      available: true,
      mode: cfg.path ? 'manual' : cfg.auto === false ? 'off' : 'auto',
      status: 'searching', /* searching | choose | connecting | connected | busy | paused | off | unavailable */
      path: cfg.path ?? null,
      ports: [],
      error: null,
      deviceId: null,
      pausedUntil: null,
    };
  }

  publicState() { return { ...this.state }; }

  set(patch) {
    const before = JSON.stringify(this.state);
    Object.assign(this.state, patch);
    if (JSON.stringify(this.state) !== before) this.emit('state', this.publicState());
  }

  async start() {
    if (!this.lib) {
      try {
        const m = await import('serialport');
        this.lib = { SerialPort: m.SerialPort, ReadlineParser: m.ReadlineParser };
      } catch {
        this.set({ available: false, status: 'unavailable', error: 'Pacote "serialport" não instalado: rode npm install.' });
        console.warn('[USB] Pacote "serialport" não instalado: rode npm install para ler a placa pelo cabo.');
        return;
      }
    }
    if (this.state.mode === 'off') { this.set({ status: 'off' }); return; }
    console.log(`[USB] ${this.state.mode === 'manual' ? `Usando a porta ${this.state.path}` : 'Procurando a placa nas portas USB (detecção automática)'}.`);
    await this.poll();
    this.timer = setInterval(() => this.poll().catch(() => {}), this.cfg.pollMs ?? 2000);
  }

  stop() { clearInterval(this.timer); this.close(); }

  async listPorts() {
    const raw = await this.lib.SerialPort.list();
    return sortPorts(raw.map(describePort));
  }

  async poll() {
    if (!this.lib || this.polling) return;
    this.polling = true;
    try {
      let ports = [];
      try {
        ports = await this.listPorts();
      } catch (e) {
        /* sem lista (ex.: Linux sem udev): a detecção automática para, mas a porta escolhida à mão funciona */
        if (!this.listWarned) console.warn(`[USB] Não foi possível listar as portas: ${e.message}`);
        this.listWarned = true;
      }
      const now = Date.now();
      const patch = { ports };
      if (this.state.mode === 'paused' && now >= (this.state.pausedUntil ?? 0)) {
        /* volta exatamente como estava antes de liberar (porta escolhida à mão continua escolhida) */
        const before = this.beforePause ?? { mode: this.cfg.path ? 'manual' : 'auto', path: this.cfg.path ?? null };
        Object.assign(patch, before, { pausedUntil: null, status: 'searching' });
        this.beforePause = null;
      }
      this.set(patch);
      const mode = this.state.mode;
      if (mode === 'paused' || mode === 'off') return;
      if (this.port) {
        /* cabo tirado: em alguns sistemas o "close" demora; a lista já mostra. Portas virtuais podem não aparecer na lista. */
        if (this.state.status === 'connected' && !ports.some((p) => p.path === this.state.path) && this.listedOnce?.has(this.state.path)) this.close(true);
        else return;
      }
      this.listedOnce = new Set(ports.map((p) => p.path));
      if (mode === 'manual') {
        if (this.state.path && now >= (this.retryAt.get(this.state.path) ?? 0)) this.open(this.state.path);
        return;
      }
      const compatible = ports.filter((p) => p.compatible);
      if (compatible.length === 1) {
        const p = compatible[0].path;
        if (now >= (this.retryAt.get(p) ?? 0)) this.open(p);
      } else if (compatible.length > 1) {
        this.set({ status: 'choose', path: null });
      } else if (this.state.status !== 'busy') {
        this.set({ status: 'searching', path: null });
      }
    } finally {
      this.polling = false;
    }
  }

  open(path) {
    const { SerialPort, ReadlineParser } = this.lib;
    this.set({ status: 'connecting', path, error: null });
    const port = new SerialPort({ path, baudRate: this.cfg.baudRate ?? 115200, autoOpen: false });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
    this.port = port;

    port.open((err) => {
      if (this.port !== port) return;
      if (err) {
        this.port = null;
        this.retryAt.set(path, Date.now() + 5000);
        this.set({ status: 'busy', error: friendlyError(err, path) });
        console.warn(`[USB] ${this.state.error}`);
        return;
      }
      /* DTR/RTS em repouso: a placa roda normalmente (sem ficar presa em reset ou em modo de gravação) */
      port.set({ dtr: false, rts: false }, () => {});
      this.set({ status: 'connected', error: null });
      console.log(`[USB] Conectado em ${path}. Para gravar o firmware sem parar o servidor, use "Liberar a porta" no painel.`);
      /* pede o status completo (o firmware responde em JSON) */
      setTimeout(() => this.write('status'), 1500);
    });

    parser.on('data', (line) => this.handleLine(line));
    port.on('close', () => {
      if (this.port !== port) return;
      this.port = null;
      console.warn(`[USB] ${path} desconectada.`);
      this.set({ status: this.state.mode === 'paused' ? 'paused' : 'searching', error: null });
    });
    port.on('error', (e) => console.warn(`[USB] ${path}: ${e.message}`));
  }

  close(unplugged = false) {
    const p = this.port;
    this.port = null;
    if (p?.isOpen) p.close(() => {});
    if (unplugged) this.set({ status: 'searching', error: null });
  }

  handleLine(raw) {
    const text = String(raw).trim();
    if (!text) return;
    if (text.startsWith('{')) {
      let obj;
      try { obj = JSON.parse(text); } catch { return; }
      if (typeof obj.id === 'string' && obj.id && obj.id !== this.state.deviceId) this.set({ deviceId: obj.id });
      this.hub.ingest({ deviceId: this.state.deviceId ?? this.cfg.deviceId, channel: 'telemetry', payload: obj, source: 'serial' });
      return;
    }
    const deviceId = this.state.deviceId ?? this.cfg.deviceId;
    console.log(`[USB:${deviceId}] ${text}`);
    this.hub.emit('log', { deviceId, ts: Date.now(), line: text.slice(0, 300) });
  }

  write(line) {
    if (!this.port?.isOpen) return false;
    this.port.write(`${line}\n`);
    return true;
  }

  /* comando do painel: vai pelo cabo se esta placa estiver nele */
  send(deviceId, command) {
    if (this.state.status !== 'connected') return false;
    if (deviceId !== (this.state.deviceId ?? this.cfg.deviceId)) return false;
    /* troca de servidor vai como texto: o firmware 1.3 ja entende "servidor auto" pela Serial */
    if (command.cmd === 'server') return this.write(`servidor ${command.host}`);
    return this.write(JSON.stringify(command));
  }

  /* escolha manual (seletor do painel ou --serial) */
  async connect(path) {
    this.close();
    this.retryAt.delete(path);
    this.set({ mode: 'manual', path, status: 'connecting', error: null, pausedUntil: null });
    await this.poll();
  }

  /* volta para a detecção automática */
  async auto() {
    this.close();
    this.retryAt.clear();
    this.set({ mode: 'auto', path: null, status: 'searching', error: null, pausedUntil: null });
    await this.poll();
  }

  /* solta a porta para o PlatformIO gravar; volta sozinho depois de alguns minutos */
  release(minutes = 3) {
    if (this.state.mode !== 'paused') this.beforePause = { mode: this.state.mode, path: this.state.mode === 'manual' ? this.state.path : null };
    this.close();
    this.set({ mode: 'paused', status: 'paused', pausedUntil: Date.now() + minutes * 60000, error: null });
    console.log(`[USB] Porta liberada por ${minutes} min para gravar o firmware.`);
  }
}
