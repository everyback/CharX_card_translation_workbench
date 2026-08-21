import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env.MOCK_PROVIDER_PORT || 18787);
const responseDelay = Number(process.env.MOCK_DELAY_MS || 0);
let activeRequests = 0;
let maxActiveRequests = 0;
let totalRequests = 0;

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/stats') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ activeRequests, maxActiveRequests, totalRequests }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end();
    return;
  }

  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', async () => {
    activeRequests += 1;
    totalRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    try {
      if (responseDelay > 0) await delay(responseDelay);
      const body = JSON.parse(raw);
      const userMessage = body.messages.find((message) => message.role === 'user')?.content ?? '';
      const systemMessage = body.messages.find((message) => message.role === 'system')?.content ?? '';
      const matches = [...userMessage.matchAll(/<<<ID:(S\d+)>>>\s*([\s\S]*?)\s*<<<END>>>/g)];
      const content = matches
        .map((match) => {
          const source = match[2].trim();
          const translated = systemMessage.includes('Old City Library') && systemMessage.includes('旧城图书馆')
            ? source.replaceAll('Old City Library', '旧城图书馆')
            : source;
          return `<<<ID:${match[1]}>>>\n已翻译：${translated}\n<<<END>>>`;
        })
        .join('\n\n');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: String(error) }));
    } finally {
      activeRequests -= 1;
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock provider listening at http://127.0.0.1:${port}/v1`);
});
