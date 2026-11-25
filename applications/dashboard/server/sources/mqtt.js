import net from 'node:net';
import * as aedesModule from 'aedes';
import mqtt from 'mqtt';

/* Topicos aceitos:
     <prefixo>/<deviceId>/<canal>   ex.: echomap/node1/telemetry, echomap/node1/events, echomap/node1/location
     <prefixo>/<canal>              ex.: echomap/telemetry (usa o defaultDeviceId)
   Canais: telemetry | events | location | imu | status (outros sao aceitos e guardados como 'other'). */
function parseTopic(topic, prefix) {
  const parts = topic.split('/').filter(Boolean);
  if (parts[0] === prefix) parts.shift();
  if (parts.length >= 2) return { deviceId: parts[0], channel: parts.slice(1).join('/') };
  return { deviceId: null, channel: parts[0] ?? 'telemetry' };
}

/* aedes 1.x: `await Aedes.createBroker()`; aedes 0.x: a exportacao padrao era a fabrica */
async function createBroker() {
  if (aedesModule.Aedes?.createBroker) return aedesModule.Aedes.createBroker();
  return aedesModule.default();
}

export async function startMqtt(hub, cfg) {
  const prefix = cfg.topicPrefix;

  if (cfg.embeddedBroker) {
    const broker = await createBroker();
    /* so o servidor manda comandos para a placa: um cliente qualquer da rede nao pode publicar em .../cmd
       (o servidor publica direto no broker, sem passar por aqui) */
    broker.authorizePublish = (client, packet, done) => {
      if (client && packet.topic.endsWith('/cmd')) {
        console.warn(`[MQTT] Recusado: ${client.id} tentou publicar em ${packet.topic}`);
        return done(new Error('somente o servidor envia comandos'));
      }
      done(null);
    };
    const server = net.createServer((socket) => {
      /* sem Nagle: comandos e pings para a placa saem na hora, sem esperar juntar bytes */
      socket.setNoDelay(true);
      broker.handle(socket);
    });
    server.listen(cfg.port, '0.0.0.0', () => {
      console.log(`[MQTT] Broker embutido ouvindo em 0.0.0.0:${cfg.port}`);
    });
    server.on('error', (err) => console.error(`[MQTT] Erro no broker: ${err.message}`));

    /* o firmware usa clientId "echomap-<id>-XXXXXX": quando a ultima conexao de uma placa cai,
       ela fica offline na hora, sem esperar o tempo limite (a contagem cobre reconexao rapida) */
    const deviceOf = (c) => /^echomap-(.+)-[0-9A-F]{6}$/i.exec(c?.id ?? '')?.[1];
    const links = new Map();
    broker.on('client', (c) => {
      console.log(`[MQTT] Cliente conectado: ${c.id}`);
      const id = deviceOf(c);
      if (id) links.set(id, (links.get(id) ?? 0) + 1);
    });
    broker.on('clientDisconnect', (c) => {
      console.log(`[MQTT] Cliente desconectado: ${c.id}`);
      const id = deviceOf(c);
      if (!id) return;
      const left = Math.max(0, (links.get(id) ?? 1) - 1);
      links.set(id, left);
      if (left === 0) hub.linkDown(id);
    });
    broker.on('publish', (packet, client) => {
      if (!client || packet.topic.startsWith('$SYS') || packet.topic.endsWith('/cmd')) return;
      const { deviceId, channel } = parseTopic(packet.topic, prefix);
      hub.ingest({ deviceId, channel, payload: packet.payload, source: 'mqtt' });
    });

    hub.commandSenders.push((deviceId, command) => {
      broker.publish({ topic: `${prefix}/${deviceId}/cmd`, payload: Buffer.from(JSON.stringify(command)), qos: 0, retain: false }, () => {});
      return (links.get(deviceId) ?? 0) > 0; /* a placa estava conectada ao broker? */
    });
    return;
  }

  if (cfg.externalUrl) {
    const client = mqtt.connect(cfg.externalUrl, { clientId: `echomap-dashboard-${Math.random().toString(16).slice(2, 8)}` });
    client.on('connect', () => {
      console.log(`[MQTT] Conectado ao broker externo ${cfg.externalUrl}`);
      client.subscribe(`${prefix}/#`);
    });
    client.on('error', (err) => console.error(`[MQTT] ${err.message}`));
    client.on('message', (topic, payload) => {
      if (topic.endsWith('/cmd')) return;
      const { deviceId, channel } = parseTopic(topic, prefix);
      hub.ingest({ deviceId, channel, payload, source: 'mqtt' });
    });
    hub.commandSenders.push((deviceId, command) => client.publish(`${prefix}/${deviceId}/cmd`, JSON.stringify(command)));
  }
}
