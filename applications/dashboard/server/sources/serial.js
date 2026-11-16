/* Le o JSON que o firmware imprime na Serial (uma linha por mensagem).
   Util na bancada, com a ESP32 ligada no USB e sem Wi-Fi. Linhas que nao sao JSON
   (ex.: "[WiFi] Conectado") aparecem no console do servidor. */
export async function startSerial(hub, cfg) {
  let SerialPort, ReadlineParser;
  try {
    ({ SerialPort, ReadlineParser } = await import('serialport'));
  } catch {
    console.error('[Serial] Pacote "serialport" nao instalado. Rode: npm install serialport');
    return;
  }

  let retryTimer = null;
  const open = () => {
    const port = new SerialPort({ path: cfg.path, baudRate: cfg.baudRate, autoOpen: false });
    const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

    port.open((err) => {
      if (err) {
        console.error(`[Serial] Nao foi possivel abrir ${cfg.path}: ${err.message}. Tentando de novo em 3 s...`);
        retryTimer = setTimeout(open, 3000);
        return;
      }
      console.log(`[Serial] Lendo ${cfg.path} @ ${cfg.baudRate}`);
    });

    parser.on('data', (line) => {
      const text = line.trim();
      if (!text) return;
      if (text.startsWith('{')) {
        hub.ingest({ deviceId: cfg.deviceId, channel: 'telemetry', payload: text, source: 'serial' });
      } else {
        console.log(`[Serial:${cfg.deviceId}] ${text}`);
      }
    });

    port.on('close', () => {
      console.warn(`[Serial] ${cfg.path} fechada. Reconectando em 3 s...`);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(open, 3000);
    });
  };
  open();
}
