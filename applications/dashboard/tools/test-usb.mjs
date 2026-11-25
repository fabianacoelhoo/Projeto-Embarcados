/* Testes do cabo USB e da rede do computador, sem placa: npm test
   - detecção automática, hot-plug, várias placas, porta ocupada e "liberar a porta" (SerialPort falso);
   - leitura da rede Wi-Fi do PC (saídas reais do netsh em português/inglês e do nmcli). */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SerialManager } from '../server/sources/serial.js';
import { parseNetshInterfaces, parseNetshKey, parseNmcli } from '../server/hostwifi.js';

let ReadlineParser;
try { ({ ReadlineParser } = await import('@serialport/parser-readline')); } catch {
  console.log('Pacote serialport não instalado (npm install): pulando os testes do cabo USB.');
  process.exit(0);
}

let listed = [];
const busy = new Set();
const opened = [];
class FakePort extends EventEmitter {
  constructor({ path }) { super(); this.path = path; this.isOpen = false; this.out = new PassThrough(); this.writes = []; }
  pipe(p) { return this.out.pipe(p); }
  open(cb) { if (busy.has(this.path)) return cb(new Error('Opening COM5: Access denied')); this.isOpen = true; opened.push(this); cb(null); }
  set(_o, cb) { cb?.(); }
  write(s) { this.writes.push(s); }
  close(cb) { this.isOpen = false; this.emit('close'); cb?.(); }
}
const lib = { SerialPort: Object.assign(FakePort, { list: async () => listed }), ReadlineParser };

const ingested = [];
const hub = new EventEmitter();
hub.ingest = (m) => ingested.push(m);
const bt = { path: 'COM3', friendlyName: 'Serial Padrão por link Bluetooth (COM3)', pnpId: 'BTHENUM\\x' };
const cp = { path: 'COM5', vendorId: '10C4', manufacturer: 'Silicon Labs' };
const ch = { path: 'COM7', vendorId: '1A86' };
const m = new SerialManager(hub, { auto: true, path: null, deviceId: 'node1', pollMs: 999999 }, { lib });
const ok = (c, t) => { console.log(`${c ? '[OK]   ' : '[FALHA]'} ${t}`); if (!c) process.exitCode = 1; };
console.log = ((log) => (...a) => { if (!String(a[0]).startsWith('[USB')) log(...a); })(console.log);
console.warn = () => {};
const tick = () => new Promise((r) => setTimeout(r, 20));

listed = [bt]; await m.start(); ok(m.state.status === 'searching', 'só Bluetooth: continua procurando');
listed = [bt, cp]; await m.poll(); await tick(); ok(m.state.status === 'connected' && m.state.path === 'COM5', 'cabo conectado (CP210x): conecta sozinho em COM5');
opened.at(-1).out.write('{"fw":"1.3.0","id":"ana","wstate":"connecting","t":1}\n[NET] Conectando em "x"...\n'); await tick();
ok(m.state.deviceId === 'ana' && ingested.at(-1).deviceId === 'ana', 'aprende o ID da placa pelo status');
ok(m.send('ana', { cmd: 'wifi', ssid: 'Casa' }) && opened.at(-1).writes.at(-1).includes('"ssid":"Casa"'), 'comando do painel sai pelo cabo');
ok(!m.send('outra', { cmd: 'locate' }), 'comando de outra placa não vai por este cabo');
listed = [bt]; await m.poll(); await tick(); ok(m.state.status === 'searching' && !m.port, 'cabo tirado: volta a procurar');
listed = [bt, cp, ch]; await m.poll(); ok(m.state.status === 'choose', 'duas placas: pede para escolher');
await m.connect('COM7'); await tick(); ok(m.state.status === 'connected' && m.state.path === 'COM7' && m.state.mode === 'manual', 'escolha manual conecta em COM7');
m.release(3); ok(m.state.status === 'paused' && !m.port, 'liberar porta: solta a COM para o PlatformIO');
await m.poll(); ok(m.state.status === 'paused', 'continua liberada até o tempo acabar');
m.state.pausedUntil = Date.now() - 1; await m.poll(); await tick(); ok(m.state.status === 'connected' && m.state.path === 'COM7', 'tempo acabou: volta para a porta escolhida (COM7)');
await m.auto(); busy.add('COM5'); listed = [bt, cp]; await m.poll(); await tick();
ok(m.state.status === 'busy' && /em uso/.test(m.state.error), 'porta ocupada (Serial Monitor): mensagem clara');
busy.clear(); await m.poll(); ok(m.state.status === 'busy', 'não martela a porta (espera 5 s)');
m.retryAt.clear(); await m.poll(); await tick(); ok(m.state.status === 'connected', 'porta liberada pelo outro programa: conecta');
m.stop();

/* rede Wi-Fi do computador */
const ptbr = '\n    Nome                   : Wi-Fi\n    Estado                 : conectado\n    SSID                   : uaifai-tiradentes\n    AP BSSID               : 6c:3b:6b:00:00:00\n    Banda                  : 5 GHz\n    Canal                  : 36\n';
const r1 = parseNetshInterfaces(ptbr);
ok(r1?.ssid === 'uaifai-tiradentes' && r1.channel === 36 && r1.band === '5', 'netsh em português: rede e 5 GHz');
const r2 = parseNetshInterfaces('\n    Name                   : Wi-Fi\n    SSID                   : Casa 2.4\n    BSSID                  : aa\n    Channel                : 6\n');
ok(r2?.ssid === 'Casa 2.4' && r2.band === '2.4', 'netsh em inglês: rede com espaço, 2,4 GHz pelo canal');
ok(parseNetshInterfaces('\n    Nome : Wi-Fi\n    Estado : desconectado\n') === null, 'Wi-Fi do PC desconectado: sem sugestão');
ok(parseNetshKey(Buffer.from('    Conteúdo da Chave      : minhaSenha123\n', 'utf8').toString('latin1')) === 'minhaSenha123', 'senha salva do Windows (pt-BR)');
ok(parseNetshKey('    Key Content            : abc12345\n') === 'abc12345', 'senha salva do Windows (inglês)');
const r3 = parseNmcli('no:Vizinho:1:2412 MHz\nyes:Rede\\:Casa:44:5220 MHz\n');
ok(r3?.ssid === 'Rede:Casa' && r3.band === '5', 'nmcli (Linux): rede ativa e 5 GHz');
