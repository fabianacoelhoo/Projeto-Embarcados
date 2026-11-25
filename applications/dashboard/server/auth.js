import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* Senha do painel para quem abre de OUTRO aparelho (celular, outro PC da rede).
   No próprio computador (localhost) o painel abre direto, sem senha.
   A senha vem de config.json (auth.password) ou é gerada na primeira vez e guardada em data/auth.json.
   A sessão é um cookie assinado (HMAC) que vale sessionDays; trocar a senha derruba as sessões antigas. */

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLocalAddr = (addr) => LOCAL.has(addr);

const COOKIE = 'echomap_sess';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; /* sem 0/o, 1/l/i: fácil de digitar no celular */

function generatePassword() {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function createAuth({ dataDir, password = null, enabled = true, sessionDays = 30 }) {
  const file = path.join(dataDir, 'auth.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* primeira vez */ }
  let changed = false;
  if (!saved.secret) { saved.secret = crypto.randomBytes(32).toString('hex'); changed = true; }
  if (!password && !saved.password) { saved.password = generatePassword(); changed = true; }
  if (changed) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  }
  const pass = String(password || saved.password);
  const maxAgeS = Math.round(sessionDays * 86400);

  const sign = (exp) => crypto.createHmac('sha256', saved.secret).update(`${exp}.${pass}`).digest('base64url');
  const same = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const tokenOf = (req) => (req.headers.cookie ?? '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const validToken = (tok) => {
    const [e, sig] = String(tok ?? '').split('.');
    const exp = Number(e);
    return Boolean(exp && sig && exp > Date.now() && same(sig, sign(exp)));
  };

  /* depois de 5 senhas erradas seguidas, o aparelho espera 30 s */
  const fails = new Map();
  const blockedFor = (ip) => {
    const f = fails.get(ip);
    return f && f.count >= 5 && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  };

  return {
    enabled,
    password: pass,
    fromConfig: Boolean(password),
    file,
    isLocal: (req) => isLocalAddr(req.socket.remoteAddress),
    /* pode ver o painel? (HTTP e WebSocket) */
    allowed(req) {
      return !enabled || isLocalAddr(req.socket.remoteAddress) || validToken(tokenOf(req));
    },
    /* POST /api/login: devolve { ok, cookie } ou { error, status } */
    login(req, given) {
      const ip = req.socket.remoteAddress;
      const wait = blockedFor(ip);
      if (wait) return { status: 429, error: `Muitas tentativas. Espere ${wait} s e tente de novo.` };
      if (!same(String(given ?? '').trim().toLowerCase(), pass.toLowerCase())) {
        const f = fails.get(ip) ?? { count: 0, until: 0 };
        f.count += 1;
        if (f.count >= 5) f.until = Date.now() + 30000;
        fails.set(ip, f);
        return { status: 401, error: 'Senha errada. Ela aparece no terminal do servidor e na aba Dispositivo do painel aberto no computador.' };
      }
      fails.delete(ip);
      const exp = Date.now() + maxAgeS * 1000;
      return { ok: true, cookie: `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeS}` };
    },
    logoutCookie: () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  };
}
