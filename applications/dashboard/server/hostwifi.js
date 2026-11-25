import { execFile } from 'node:child_process';
import os from 'node:os';

/* Rede Wi-Fi em que ESTE computador está conectado, para preencher o EchoMap com 1 clique.
   Windows: netsh · Linux: nmcli · macOS: networksetup. Sem shell (sem risco de injeção).
   A saída do netsh vem no código de página do console; lida como latin1, os rótulos com acento
   são casados por padrão flexível e um nome de rede com acento é marcado como "confira". */

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true, encoding: 'latin1', maxBuffer: 1 << 20, ...opts },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

export function bandOf(channel, ghz) {
  if (ghz) return ghz >= 5.9 ? '6' : ghz >= 4.9 ? '5' : '2.4';
  if (channel == null) return null;
  return channel <= 14 ? '2.4' : '5';
}

/* --- Windows: "netsh wlan show interfaces" (pt-BR ou inglês) --- */
export function parseNetshInterfaces(out) {
  if (!out) return null;
  const blocks = out.split(/\r?\n\s*\r?\n(?=\s*(?:Name|Nome)\s*:)/);
  for (const b of blocks) {
    const ssid = /^\s*SSID\s*:\s*(.+?)\s*$/m.exec(b)?.[1];
    if (!ssid) continue; /* interface desconectada não tem SSID */
    const channel = Number(/^\s*(?:Channel|Canal)\s*:\s*(\d+)/mi.exec(b)?.[1]) || null;
    const ghz = Number((/^\s*(?:Band|Banda)\s*:\s*([\d.,]+)\s*GHz/mi.exec(b)?.[1] ?? '').replace(',', '.')) || null;
    return { ssid, channel, band: bandOf(channel, ghz), uncertain: /[\x80-\xff]/.test(ssid) };
  }
  return null;
}

/* --- Linux: "nmcli -t -f ACTIVE,SSID,CHAN,FREQ dev wifi" (":" escapado como "\:") --- */
export function parseNmcli(out) {
  if (!out) return null;
  for (const line of out.split('\n')) {
    const f = line.split(/(?<!\\):/).map((x) => x.replace(/\\:/g, ':').replace(/\\\\/g, '\\'));
    if (f.length < 4 || !/^(yes|sim|sí|ja|oui)$/i.test(f[0])) continue;
    const channel = Number(f[2]) || null;
    const mhz = Number(String(f[3]).replace(/[^\d]/g, '')) || null;
    return { ssid: f[1], channel, band: bandOf(channel, mhz ? mhz / 1000 : null), uncertain: false };
  }
  return null;
}

export async function hostWifi() {
  const platform = os.platform();
  let info = null;
  if (platform === 'win32') {
    info = parseNetshInterfaces(await run('netsh', ['wlan', 'show', 'interfaces']));
  } else if (platform === 'linux') {
    info = parseNmcli(await run('nmcli', ['-t', '-f', 'ACTIVE,SSID,CHAN,FREQ', 'dev', 'wifi'], { encoding: 'utf8' }));
  } else if (platform === 'darwin') {
    for (const dev of ['en0', 'en1']) {
      const out = await run('networksetup', ['-getairportnetwork', dev], { encoding: 'utf8' });
      const ssid = /Current Wi-Fi Network:\s*(.+)$/m.exec(out ?? '')?.[1]?.trim();
      if (ssid) { info = { ssid, channel: null, band: null, uncertain: false }; break; }
    }
  }
  return { platform, ...(info ?? { ssid: null, channel: null, band: null, uncertain: false }), canReadPassword: platform === 'win32' };
}

/* --- Windows: senha salva no perfil (só com pedido explícito e só para quem está no próprio PC) --- */
export function parseNetshKey(out) {
  return /^\s*(?:Key Content|Conte\S{1,2}do da [Cc]have)\s*:\s*(.+?)\s*$/m.exec(out ?? '')?.[1] ?? null;
}

export async function savedPassword(ssid) {
  if (os.platform() !== 'win32') return { error: 'Recuperar a senha salva só funciona no Windows.' };
  if (typeof ssid !== 'string' || !ssid || ssid.length > 32 || /["\r\n\0]/.test(ssid)) return { error: 'Nome de rede inválido.' };
  /* argumentos montados à mão (sem shell): name="..." com aspas, que o netsh exige para nomes com espaço */
  const out = await run('netsh', [`wlan show profile name="${ssid}" key=clear`], { windowsVerbatimArguments: true });
  if (out == null) return { error: `O Windows não tem um perfil salvo para "${ssid}".` };
  const password = parseNetshKey(out);
  if (!password) return { error: 'O Windows não mostrou a senha (rede aberta, perfil de empresa ou sem permissão). Digite a senha.' };
  return { password };
}
