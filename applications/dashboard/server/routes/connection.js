/* Cabo USB (Serial) e Wi-Fi deste computador. */
import { hostWifi, savedPassword } from '../hostwifi.js';

export function registerConnectionRoutes(app, ctx) {
  const { usb } = ctx;

  app.get('/api/serial', (req, res) => res.json(usb.publicState()));
  app.post('/api/serial/connect', async (req, res) => {
    const path = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
    if (!path) return res.status(400).json({ error: 'Escolha uma porta.' });
    await usb.connect(path);
    res.json(usb.publicState());
  });
  app.post('/api/serial/auto', async (req, res) => { await usb.auto(); res.json(usb.publicState()); });
  app.post('/api/serial/release', (req, res) => {
    const minutes = Math.min(Math.max(Number(req.body?.minutes ?? 3), 1), 15);
    usb.release(minutes);
    res.json(usb.publicState());
  });

  /* a senha do Wi-Fi do PC nunca sai para a rede: so o navegador do proprio computador pode le-la */
  app.get('/api/host-wifi', async (req, res) => {
    const info = await hostWifi();
    res.json({ ...info, canReadPassword: info.canReadPassword && ctx.isLocal(req) });
  });
  app.post('/api/host-wifi/password', async (req, res) => {
    if (!ctx.isLocal(req)) return res.status(403).json({ error: 'Por segurança, a senha salva só pode ser lida abrindo o painel no próprio computador (localhost).' });
    const out = await savedPassword(req.body?.ssid);
    res.status(out.error ? 422 : 200).json(out);
  });
}
