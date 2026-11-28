import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* Login do painel.
   - Quem abre de OUTRO aparelho (celular, outro PC da rede) precisa entrar. No próprio computador
     (localhost) o painel abre direto, a não ser que DASHBOARD_TRUST_LOCALHOST=0.
   - Credenciais: DASHBOARD_USER/DASHBOARD_PASS (.env) > config.json (auth.user/auth.password) >
     senha gerada na primeira vez e guardada em data/auth.json. Sem usuário configurado, só a senha.
   - A senha nunca fica em texto nas comparações: guarda-se o hash scrypt (crypto nativo, com sal) e a
     comparação é em tempo constante.
   - Sessão: cookie HttpOnly assinado (HMAC-SHA256 com SESSION_SECRET ou um segredo aleatório salvo em
     data/auth.json); trocar a senha derruba as sessões antigas. */

const LOCAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLocalAddr = (addr) => LOCAL.has(addr);

const COOKIE = 'echomap_sess';
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; /* sem 0/o, 1/l/i: fácil de digitar no celular */

function generatePassword() {
  let s = '';
  for (let i = 0; i < 8; i += 1) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export const hashPassword = (pass, salt) => crypto.scryptSync(String(pass), salt, 32);

export function createAuth({ dataDir, password = null, user = null, secret = null, enabled = true, trustLocalhost = true, sessionDays = 30, secure = false }) {
  const file = path.join(dataDir, 'auth.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* primeira vez */ }
  let changed = false;
  if (!secret && !saved.secret) { saved.secret = crypto.randomBytes(32).toString('hex'); changed = true; }
  if (!password && !saved.password) { saved.password = generatePassword(); changed = true; }
  if (changed) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  }
  const generated = !password;
  const pass = String(password || saved.password);
  const key = String(secret || saved.secret);
  /* senha gerada: maiúsculas/minúsculas não importam (digitada no celular); a configurada vale como está */
  const norm = (s) => (generated ? String(s ?? '').trim().toLowerCase() : String(s ?? ''));
  const salt = crypto.randomBytes(16);
  const passHash = hashPassword(norm(pass), salt);
  const wantUser = user ? String(user) : null;
  const maxAgeS = Math.round(sessionDays * 86400);
  const fingerprint = crypto.createHash('sha256').update(`${wantUser ?? ''}:${pass}`).digest('hex').slice(0, 16);

  const sign = (exp) => crypto.createHmac('sha256', key).update(`${exp}.${fingerprint}`).digest('base64url');
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

  /* depois de 5 tentativas erradas seguidas, o aparelho espera 30 s */
  const fails = new Map();
  const blockedFor = (ip) => {
    const f = fails.get(ip);
    return f && f.count >= 5 && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  };
  const cookieFlags = `HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;

  return {
    enabled,
    trustLocalhost,
    password: pass,
    user: wantUser,
    fromConfig: !generated,
    file,
    source: generated
      ? `(gerada e guardada em ${path.relative(process.cwd(), file) || file}; defina DASHBOARD_PASS no .env para escolher outra)`
      : '(definida em DASHBOARD_PASS no .env ou em "auth.password" no config.json)',
    isLocal: (req) => isLocalAddr(req.socket.remoteAddress),
    /* está logado (cookie válido)? */
    loggedIn: (req) => validToken(tokenOf(req)),
    /* pode ver o painel e usar a API? (HTTP e WebSocket) */
    allowed(req) {
      if (!enabled) return true;
      if (trustLocalhost && isLocalAddr(req.socket.remoteAddress)) return true;
      return validToken(tokenOf(req));
    },
    /* POST /api/login: devolve { ok, cookie } ou { error, status } */
    login(req, givenPass, givenUser) {
      const ip = req.socket.remoteAddress;
      const wait = blockedFor(ip);
      if (wait) return { status: 429, error: `Muitas tentativas. Espere ${wait} s e tente de novo.` };
      const userOk = !wantUser || same(String(givenUser ?? '').trim(), wantUser);
      const passOk = crypto.timingSafeEqual(hashPassword(norm(givenPass), salt), passHash);
      if (!userOk || !passOk) {
        const f = fails.get(ip) ?? { count: 0, until: 0 };
        f.count += 1;
        if (f.count >= 5) f.until = Date.now() + 30000;
        fails.set(ip, f);
        return { status: 401, error: wantUser ? 'Usuário ou senha errados.' : 'Senha errada. Ela aparece no terminal do servidor e na aba Dispositivo do painel aberto no computador.' };
      }
      fails.delete(ip);
      const exp = Date.now() + maxAgeS * 1000;
      return { ok: true, cookie: `${COOKIE}=${exp}.${sign(exp)}; ${cookieFlags}; Max-Age=${maxAgeS}` };
    },
    logoutCookie: () => `${COOKIE}=; ${cookieFlags}; Max-Age=0`,
  };
}
