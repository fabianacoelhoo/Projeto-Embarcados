/* Monta o app HTTP (Express) com o login e todas as rotas da API.
   Separado do index.js para os testes subirem o app sem broker MQTT nem cabo USB. */
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { ROOT } from './config.js';
import { isLocalAddr } from './auth.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerConnectionRoutes } from './routes/connection.js';
import { registerPlaceRoutes } from './routes/places.js';
import { registerHotspotRoutes } from './routes/hotspots.js';
import { registerEmailRoutes } from './routes/email.js';

export const localIps = () => Object.values(os.networkInterfaces()).flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

/* ctx: { config, db, hub, usb, auth, zones, broadcast } */
export function createApp(ctx) {
  const { config, auth, zones, db, usb } = ctx;
  /* pedidos vindos do próprio computador (o navegador do PC) */
  ctx.isLocal = (req) => isLocalAddr(req.socket.remoteAddress);
  ctx.broadcast ??= () => {};

  ctx.publicConfig = (req) => ({
    thresholds: config.thresholds,
    safeZones: zones.list(),
    wifiPlaces: db.places(),
    anchor: { radiusM: config.anchor?.radiusM ?? 100, hours: config.anchor?.hours ?? 4 },
    /* a senha só aparece para quem abriu o painel no próprio computador */
    auth: {
      enabled: auth.enabled,
      remote: !ctx.isLocal(req) || auth.loggedIn(req),
      user: auth.enabled && ctx.isLocal(req) ? auth.user : undefined,
      password: auth.enabled && ctx.isLocal(req) && !auth.fromConfig ? auth.password : undefined,
    },
    offlineAfterMs: config.offlineAfterMs,
    server: {
      host: os.hostname(),
      ips: localIps(),
      mqttPort: config.mqtt.embeddedBroker ? config.mqtt.port : null,
      mqttAuth: Boolean(config.mqtt.username),
      discovery: Boolean(config.discovery?.enabled),
      serial: usb.state.path,
    },
    portalPassword: config.portal?.password ?? 'echomap123',
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  /* quem não está no próprio computador precisa entrar com a senha (cookie de sessão) */
  const OPEN_PATHS = new Set(['/login.html', '/tokens.css', '/api/login', '/api/login-info', '/favicon.ico']);
  app.use((req, res, next) => {
    if (auth.allowed(req) || OPEN_PATHS.has(req.path) || req.path.startsWith('/vendor/fonts/')) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Entre com a senha do painel.', login: true });
    res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
  });
  app.post('/api/login', (req, res) => {
    const out = auth.login(req, req.body?.password, req.body?.user);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.setHeader('Set-Cookie', out.cookie);
    res.json({ ok: true });
  });
  app.get('/api/login-info', (req, res) => res.json({ userRequired: Boolean(auth.user) }));
  app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', auth.logoutCookie()); res.json({ ok: true }); });

  app.use(express.static(path.join(ROOT, 'public')));
  app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist')));
  app.use('/vendor/qrcode', express.static(path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist')));
  /* fontes servidas localmente (o painel funciona sem internet) */
  app.use('/vendor/fonts/sans', express.static(path.join(ROOT, 'node_modules', '@fontsource', 'plus-jakarta-sans', 'files'), { maxAge: '30d' }));
  app.use('/vendor/fonts/mono', express.static(path.join(ROOT, 'node_modules', '@fontsource', 'jetbrains-mono', 'files'), { maxAge: '30d' }));

  registerDeviceRoutes(app, ctx);
  registerConnectionRoutes(app, ctx);
  registerPlaceRoutes(app, ctx);
  if (ctx.hotspots) registerHotspotRoutes(app, ctx);
  if (ctx.email) registerEmailRoutes(app, ctx);
  for (const register of ctx.extraRoutes ?? []) register(app, ctx);
  return app;
}
