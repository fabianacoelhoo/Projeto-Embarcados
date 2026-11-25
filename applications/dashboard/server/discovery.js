import dgram from 'node:dgram';
import os from 'node:os';

/* Anuncio de descoberta: a cada poucos segundos o servidor manda um broadcast UDP
   {"echomap":1,"mqtt":1883,"http":3000,"name":"<pc>"} em cada rede local.
   O EchoMap configurado com servidor "auto" ouve esse anuncio e usa o IP de quem mandou,
   entao ninguem precisa digitar (nem atualizar) o IP do computador.
   So envia (nao recebe), por isso nao depende de liberar porta de entrada no firewall. */

function broadcastAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      out.add(ip.map((b, k) => (b | (~mask[k] & 255))).join('.'));
    }
  }
  /* no Windows, 255.255.255.255 sai so pela interface principal; o endereco de cada rede cobre as demais */
  out.add('255.255.255.255');
  return [...out];
}

export function startDiscovery(cfg, { mqttPort, httpPort }) {
  if (!cfg?.enabled) return () => {};
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const payload = Buffer.from(JSON.stringify({ echomap: 1, mqtt: mqttPort, http: httpPort, name: os.hostname() }));
  let timer = null;
  let warned = false;

  const announce = () => {
    for (const addr of broadcastAddresses()) {
      sock.send(payload, cfg.port, addr, (err) => {
        if (err && !warned) {
          warned = true;
          console.warn(`[DESCOBERTA] Falha ao anunciar em ${addr}: ${err.message}`);
        }
      });
    }
  };

  sock.on('error', (err) => console.warn(`[DESCOBERTA] ${err.message}`));
  sock.bind(() => {
    sock.setBroadcast(true);
    announce();
    timer = setInterval(announce, cfg.intervalMs);
    console.log(`[DESCOBERTA] Anunciando o servidor na rede (UDP ${cfg.port}); EchoMaps com servidor "auto" acham este PC sozinhos.`);
  });

  return () => { clearInterval(timer); sock.close(); };
}
