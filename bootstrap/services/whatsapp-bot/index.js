const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);

const AUTH_DIR    = path.join(__dirname, 'auth');
const OPENCODE    = '/home/agent/.opencode/bin/opencode';
const HISTORY_MAX = 20;   // messages kept per group for context
const OC_TIMEOUT  = 120_000;

// Per-group rolling message buffer  {jid -> [{sender, text}]}
const history = new Map();

function pushHistory(jid, sender, text) {
  if (!history.has(jid)) history.set(jid, []);
  const buf = history.get(jid);
  buf.push({ sender, text });
  if (buf.length > HISTORY_MAX) buf.shift();
}

function getContext(jid) {
  return (history.get(jid) || []).map(m => `${m.sender}: ${m.text}`).join('\n');
}

async function callOpencode(prompt) {
  const { stdout } = await execFileAsync(
    OPENCODE,
    ['run', prompt, '--auto', '--format', 'json'],
    { timeout: OC_TIMEOUT, env: process.env }
  );

  // Parse newline-delimited JSON event stream, collect text parts
  return stdout
    .split('\n')
    .filter(Boolean)
    .reduce((acc, line) => {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'text') acc += ev.part.text;
      } catch {}
      return acc;
    }, '')
    .trim();
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({ version, auth: state });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n=== SCAN THIS QR CODE IN WHATSAPP > LINKED DEVICES ===\n');
      qrcode.generate(qr, { small: true });
      console.log('\n=======================================================\n');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : undefined;
      if (code !== DisconnectReason.loggedOut) {
        console.log('reconnecting…');
        connect();
      } else {
        console.error('logged out — delete auth/ and restart to re-pair');
      }
    } else if (connection === 'open') {
      console.log('connected, bot JID:', sock.user?.id);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid ?? '';
      if (!jid.endsWith('@g.us')) continue;   // groups only

      const text =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ??
        '';
      if (!text) continue;

      const senderNum = (msg.key.participant ?? '').replace(/@.+$/, '');

      // Log group JIDs — helps the user identify the target group on first run
      console.log(`[${jid}] ${senderNum}: ${text.slice(0, 100)}`);

      pushHistory(jid, senderNum, text);

      // Detect @mention of the bot
      const mentioned =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
      const botNum = (sock.user?.id ?? '').replace(/[^0-9]/g, '').slice(0, 15);

      const isMentioned =
        mentioned.some(m => m.replace(/@.+$/, '') === botNum) ||
        text.includes(`@${botNum}`);

      if (!isMentioned) continue;

      console.log(`[${jid}] @mentioned — calling opencode`);

      try {
        const prompt = [
          'You are a helpful assistant in a WhatsApp group chat.',
          'Recent conversation for context:',
          '',
          getContext(jid),
          '',
          'The group member just tagged you:',
          text,
          '',
          'Reply concisely in the same language as the conversation.',
        ].join('\n');

        const reply = await callOpencode(prompt);

        if (reply) {
          await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        }
      } catch (err) {
        console.error('opencode error:', err.message);
        await sock.sendMessage(
          jid,
          { text: '(error generating reply — check server logs)' },
          { quoted: msg }
        );
      }
    }
  });
}

connect().catch(err => { console.error(err); process.exit(1); });
