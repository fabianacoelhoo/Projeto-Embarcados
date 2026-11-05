import net from 'node:net';
import Aedes from 'aedes';
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

export function startMqtt(hub, cfg) {
  const prefix = cfg.topicPrefix;

  if (cfg.embeddedBroker) {
    const broker = Aedes();
    const server = net.createServer(broker.handle);
    server.listen(cfg.port, '0.0.0.0', () => {
      console.log(`[MQTT] Broker embutido ouvindo em 0.0.0.0:${cfg.port}`);
    });
    server.on('error', (err) => console.error(`[MQTT] Erro no broker: ${err.message}`));

    broker.on('client', (c) => console.log(`[MQTT] Cliente conectado: ${c.id}`));
    broker.on('clientDisconnect', (c) => console.log(`[MQTT] Cliente desconectado: ${c.id}`));
    broker.on('publish', (packet, client) => {
      if (!client || packet.topic.startsWith('$SYS') || packet.topic.endsWith('/cmd')) return;
      const { deviceId, channel } = parseTopic(packet.topic, prefix);
      hub.ingest({ deviceId, channel, payload: packet.payload, source: 'mqtt' });
    });

    hub.commandSenders.push((deviceId, command) => {
      broker.publish({ topic: `${prefix}/${deviceId}/cmd`, payload: Buffer.from(JSON.stringify(command)), qos: 0, retain: false }, () => {});
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
