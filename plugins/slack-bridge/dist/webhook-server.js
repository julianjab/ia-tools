/**
 * WebhookServer — receives forwarded Slack messages from the daemon.
 *
 * Binds to a random port (0) on start. Handles:
 *   GET  /health  → 200 {"status":"ok"}
 *   POST /message → parse MessagePayload, invoke onMessage callback
 *   *             → 404
 */
import { createServer } from 'node:http';
export class WebhookServer {
    onMessage;
    port_;
    server_;
    constructor(onMessage) {
        this.onMessage = onMessage;
    }
    get port() {
        return this.port_;
    }
    start() {
        return new Promise((resolve, reject) => {
            const srv = createServer((req, res) => void this.handleRequest(req, res));
            srv.on('error', reject);
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address();
                const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
                this.port_ = port;
                this.server_ = srv;
                resolve(port);
            });
        });
    }
    stop() {
        return new Promise((resolve, reject) => {
            if (!this.server_) {
                resolve();
                return;
            }
            this.server_.close((err) => {
                if (err) {
                    reject(err);
                }
                else {
                    this.port_ = undefined;
                    this.server_ = undefined;
                    resolve();
                }
            });
        });
    }
    async handleRequest(req, res) {
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
            return;
        }
        if (req.method === 'POST' && req.url === '/message') {
            const MAX_BODY_BYTES = 1_048_576;
            const chunks = [];
            let bytesReceived = 0;
            let destroyed = false;
            req.on('data', (chunk) => {
                bytesReceived += chunk.length;
                if (bytesReceived > MAX_BODY_BYTES) {
                    destroyed = true;
                    req.destroy();
                    res.writeHead(413);
                    res.end('payload too large');
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', async () => {
                if (destroyed)
                    return;
                let payload;
                try {
                    payload = JSON.parse(Buffer.concat(chunks).toString());
                }
                catch (err) {
                    process.stderr.write(`[WebhookServer] JSON parse error: ${String(err)}\n`);
                    res.writeHead(400);
                    res.end('internal error');
                    return;
                }
                try {
                    await this.onMessage(payload);
                    res.writeHead(200);
                    res.end('ok');
                }
                catch (err) {
                    process.stderr.write(`[WebhookServer] onMessage error: ${String(err)}\n`);
                    res.writeHead(500);
                    res.end('internal error');
                }
            });
            return;
        }
        res.writeHead(404);
        res.end('not found');
    }
}
//# sourceMappingURL=webhook-server.js.map