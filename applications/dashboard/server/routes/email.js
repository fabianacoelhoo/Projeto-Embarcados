/* Alertas por e-mail: estado (tela Dispositivo) e e-mail de teste. As duas rotas passam pelo login do painel. */
export function registerEmailRoutes(app, ctx) {
  app.get('/api/email/status', (req, res) => res.json(ctx.email.status({ local: ctx.isLocal(req) })));
  app.post('/api/email/test', (req, res) => {
    if (!ctx.email.config.enabled) return res.status(409).json({ error: 'Os alertas por e-mail estão desativados (EMAIL_ENABLED=1 no .env do painel).' });
    const deviceId = typeof req.body?.deviceId === 'string' && req.body.deviceId ? req.body.deviceId : ctx.config.defaultDeviceId;
    const out = ctx.email.sendTest(deviceId);
    res.status(out.error ? 400 : 202).json(out);
  });
}
