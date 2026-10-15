const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const AUTH_DIR    = path.join(__dirname, 'auth');
const OPENCODE    = '/home/agent/.opencode/bin/opencode';
const HISTORY_MAX = 20;
const OC_TIMEOUT  = 120_000;
const DM_ALLOWED  = process.env.BOT_DM_NUMBER ?? null;
const LOG_FILE    = path.join(__dirname, 'bot.log');

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

const history = new Map();

function pushHistory(jid, sender, text) {
  if (!history.has(jid)) history.set(jid, []);
  const buf = history.get(jid);
  buf.push({ sender, text });
  if (buf.length > HISTORY_MAX) buf.shift();
}

const OC_DB_DIR = '/home/agent/.local/share/opencode';

async function callOpencode(prompt) {
  for (const f of [`${OC_DB_DIR}/opencode.db-shm`, `${OC_DB_DIR}/opencode.db-wal`]) {
    try { fs.unlinkSync(f); } catch {}
  }

  return new Promise((resolve, reject) => {
    // detached=true puts opencode in its own process group so we can kill the
    // entire group (including child LLM runners) with process.kill(-pid, SIGKILL)
    const proc = spawn(OPENCODE, ['run', prompt, '--format', 'json'], {
      env: process.env,
      cwd: '/home/agent',
      detached: true,
      // opencode reads piped stdin until EOF; an open pipe makes it hang forever
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
      reject(Object.assign(new Error('opencode timed out'), { killed: true, signal: 'SIGKILL', code: null, stderr }));
    }, OC_TIMEOUT);

    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });

    // Once the parent exits, reap any lingering children so they release the
    // stdout pipe; otherwise 'close' would wait until the timeout fires.
    proc.on('exit', () => {
      try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
    });

    proc.on('close', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        return reject(Object.assign(
          new Error(`opencode exited code=${code} signal=${signal}`),
          { killed: !!signal, signal, code, stderr }
        ));
      }
      resolve(
        stdout
          .split('\n')
          .filter(Boolean)
          .reduce((acc, line) => {
            try {
              const ev = JSON.parse(line);
              if (ev.type === 'text') acc += ev.part.text;
            } catch {}
            return acc;
          }, '')
          .trim()
      );
    });

    proc.on('error', err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      log('QR code ready — scan in WhatsApp > Linked Devices');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : undefined;
      log('connection closed, code:', code);
      if (code !== DisconnectReason.loggedOut) {
        log('reconnecting…');
        connect();
      } else {
        log('logged out — delete auth/ and restart to re-pair');
      }
    } else if (connection === 'open') {
      log('connected, bot JID:', sock.user?.id, '| DM_ALLOWED:', DM_ALLOWED);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    log(`messages.upsert type=${type} count=${messages.length}`);
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid ?? '';
      log(`msg from=${jid} fromMe=${msg.key.fromMe} msgTypes=${Object.keys(msg.message ?? {}).join(',')}`);

      if (msg.key.fromMe) continue;

      const isGroup = jid.endsWith('@g.us');
      const isDM    = jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');

      if (!isGroup && !isDM) { log(`skip: unknown jid type ${jid}`); continue; }

      const text =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ??
        '';

      if (!text) { log(`skip: no text in message`); continue; }

      const senderNum = isGroup
        ? (msg.key.participant ?? '').replace(/@.+$/, '')
        : jid.replace(/@.+$/, '');

      log(`[${jid}] sender=${senderNum} text="${text.slice(0, 80)}"`);

      if (isDM) {
        log(`DM check: senderNum=${senderNum} DM_ALLOWED=${DM_ALLOWED} isLid=${jid.endsWith('@lid')}`);
        const lidDM = jid.endsWith('@lid');
        if (!DM_ALLOWED) { log('skip: DMs disabled'); continue; }
        if (!lidDM && senderNum !== DM_ALLOWED) { log('skip: DM not from allowed number'); continue; }
      } else {
        const mentioned =
          msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
        const botNum = (sock.user?.id ?? '').replace(/[^0-9]/g, '').slice(0, 15);
        log(`mention check: botNum=${botNum} mentioned=[${mentioned.join(',')}]`);

        const isMentioned =
          mentioned.some(m => m.replace(/@.+$/, '') === botNum) ||
          text.includes(`@${botNum}`);

        if (!isMentioned) { log('skip: bot not mentioned'); continue; }
      }

      log(`[${jid}] triggered — calling opencode`);
      pushHistory(jid, senderNum, text);

      try {
        const reply = await callOpencode(text);
        log(`opencode reply length=${reply.length}`);

        if (reply) {
          await sock.sendMessage(jid, { text: reply }, { quoted: msg });
          log(`reply sent to ${jid}`);
        }
      } catch (err) {
        log('opencode error:', err.message, `| killed=${err.killed} signal=${err.signal} code=${err.code}`);
        if (err.stderr) log('opencode stderr:', String(err.stderr).slice(0, 500));
        await sock.sendMessage(
          jid,
          { text: '(error generating reply — check server logs)' },
          { quoted: msg }
        );
      }
    }
  });
}

log('bot starting, DM_ALLOWED:', DM_ALLOWED, '| log file:', LOG_FILE);
connect().catch(err => { log('fatal:', err.message); process.exit(1); });
