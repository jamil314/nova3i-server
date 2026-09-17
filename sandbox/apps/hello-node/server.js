const express = require('express');

const app = express();
const PORT = 3000;

app.get('/', (req, res) => res.json({ app: 'hello-node', status: 'ok' }));
app.get('/hello', (req, res) => res.json({ message: 'hello from node' }));
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '127.0.0.1', () => console.log(`hello-node listening on ${PORT}`));
