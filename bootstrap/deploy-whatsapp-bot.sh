#!/data/data/com.termux/files/usr/bin/bash
# Deploy whatsapp-bot service to this device. Run once from Termux.
set -euo pipefail

SVC_SRC="$HOME/nova3i/bootstrap/services/whatsapp-bot"
SVDIR="${PREFIX}/var/service"
AGENT_DIR="/home/agent/whatsapp-bot"

echo "=== 1/5  writing service files ==="
mkdir -p "$SVC_SRC"

cat > "$SVC_SRC/run" << 'RUNEOF'
#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
exec proot-distro login debian -u 0 -- /usr/bin/su - agent -c 'cd /home/agent/whatsapp-bot && node index.js'
RUNEOF
chmod +x "$SVC_SRC/run"

cat > "$SVC_SRC/package.json" << 'PKGEOF'
{
  "name": "whatsapp-bot",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.0",
    "@hapi/boom": "^10.0.1",
    "qrcode-terminal": "^0.12.0"
  }
}
PKGEOF

cat > "$SVC_SRC/index.js" << 'JSEOF'
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
const HISTORY_MAX = 20;
const OC_TIMEOUT  = 120_000;

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
      if (!jid.endsWith('@g.us')) continue;

      const text =
        msg.message?.conversation ??
        msg.message?.extendedTextMessage?.text ??
        msg.message?.ephemeralMessage?.message?.extendedTextMessage?.text ??
        '';
      if (!text) continue;

      const senderNum = (msg.key.participant ?? '').replace(/@.+$/, '');
      console.log(`[${jid}] ${senderNum}: ${text.slice(0, 100)}`);

      pushHistory(jid, senderNum, text);

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
JSEOF

echo "=== 2/5  creating runit symlink ==="
ln -sfn "$SVC_SRC" "$SVDIR/whatsapp-bot"

echo "=== 3/5  copying files into proot-distro ==="
proot-distro login debian -u 0 -- /usr/bin/su - agent -c "mkdir -p $AGENT_DIR"
proot-distro login debian -u 0 -- /usr/bin/su - agent -c "cp $SVC_SRC/index.js $SVC_SRC/package.json $AGENT_DIR/"

echo "=== 4/5  npm install (this may take a minute) ==="
proot-distro login debian -u 0 -- /usr/bin/su - agent -c "cd $AGENT_DIR && npm install"

echo "=== 5/5  starting service ==="
sv up whatsapp-bot
sleep 2
sv status whatsapp-bot

echo ""
echo "=== done — watch logs with: ==="
echo "  sv status whatsapp-bot"
echo "  tail -f $HOME/nova3i/logs/whatsapp-bot.log 2>/dev/null || true"
echo ""
echo "First run: a QR code will appear — scan it with WhatsApp on your second number."
echo "After pairing, runit keeps it alive automatically."
