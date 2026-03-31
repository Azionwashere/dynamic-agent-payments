import express from 'express';
import { createReadStream, watchFile, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENT_FILE = process.env.AGENT_PAY_EVENT_FILE || '/tmp/agent-pay-events.jsonl';
const PORT = parseInt(process.env.DASHBOARD_PORT || '3456');

// Ensure event file exists
if (!existsSync(EVENT_FILE)) {
  writeFileSync(EVENT_FILE, '');
}

const app = express();

app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send existing events
  const rl = createInterface({ input: createReadStream(EVENT_FILE) });
  rl.on('line', (line) => {
    if (line.trim()) {
      res.write(`data: ${line}\n\n`);
    }
  });

  // Watch for new events
  let lastSize = 0;
  const watcher = watchFile(EVENT_FILE, { interval: 500 }, (curr) => {
    if (curr.size > lastSize) {
      const stream = createReadStream(EVENT_FILE, { start: lastSize });
      const newRl = createInterface({ input: stream });
      newRl.on('line', (line) => {
        if (line.trim()) {
          res.write(`data: ${line}\n\n`);
        }
      });
      lastSize = curr.size;
    }
  });

  req.on('close', () => {
    watcher.removeAllListeners();
  });
});

app.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Tailing: ${EVENT_FILE}`);
});
