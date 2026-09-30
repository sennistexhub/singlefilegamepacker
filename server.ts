import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { packGameFromUrl, PackOptions, PackResult } from './server/packer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bundlesStore = new Map<string, PackResult>();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Streamed NDJSON Packing Endpoint
  app.post('/api/pack', async (req, res) => {
    const body = req.body as Partial<PackOptions>;
    if (!body || !body.targetUrl || typeof body.targetUrl !== 'string') {
      res.status(400).json({ error: 'Please provide a valid targetUrl.' });
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const sendEvent = (payload: Record<string, unknown>) => {
      try {
        res.write(JSON.stringify(payload) + '\n');
      } catch {
        // ignore write after close
      }
    };

    try {
      const options: PackOptions = {
        targetUrl: body.targetUrl,
        spoofOrigin: body.spoofOrigin !== false,
        deepScanIl2Cpp: body.deepScanIl2Cpp !== false,
        stripAntiDebug: body.stripAntiDebug !== false,
        disableUnityCache: body.disableUnityCache !== false,
        includeOfflineHud: body.includeOfflineHud !== false,
        extraAssetUrls: Array.isArray(body.extraAssetUrls) ? body.extraAssetUrls : [],
      };

      const result = await packGameFromUrl(options, (progressEvt) => {
        sendEvent({
          type: 'progress',
          ...progressEvt,
        });
      });

      // Keep up to 5 bundles in memory to bound RAM
      if (bundlesStore.size >= 5) {
        const oldestKey = bundlesStore.keys().next().value;
        if (oldestKey) bundlesStore.delete(oldestKey);
      }
      bundlesStore.set(result.bundleId, result);

      const { htmlContent, ...metadataOnly } = result;
      // Extract the VFS runtime script snippet for inspection in the UI
      const runtimeMatch = htmlContent.match(/<script data-vfs-runtime="unitypack-v1">[\s\S]*?<\/script>/);
      const vfsRuntimeCode = runtimeMatch ? runtimeMatch[0] : '';

      sendEvent({
        type: 'result',
        bundle: {
          ...metadataOnly,
          vfsRuntimeCode,
        },
      });
      res.end();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to fetch and pack target URL';
      sendEvent({
        type: 'error',
        error: message,
      });
      res.end();
    }
  });

  // Download packed single-file HTML
  app.get('/api/bundle/:id/download', (req, res) => {
    const bundle = bundlesStore.get(req.params.id);
    if (!bundle) {
      res.status(404).send('Bundle expired or not found. Please pack the URL again.');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${bundle.fileNameDownload.replace(/[^a-zA-Z0-9._-]/g, '_')}"`
    );
    res.setHeader('Content-Length', String(Buffer.byteLength(bundle.htmlContent, 'utf8')));
    res.send(bundle.htmlContent);
  });

  // Live sandbox preview of the exact packed single-file HTML
  app.get('/api/bundle/:id/preview', (req, res) => {
    const bundle = bundlesStore.get(req.params.id);
    if (!bundle) {
      res.status(404).send('Bundle expired or not found. Please pack the URL again.');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(bundle.htmlContent);
  });

  // List active bundles in memory
  app.get('/api/bundles', (_req, res) => {
    const list = Array.from(bundlesStore.values()).map(({ htmlContent: _h, ...meta }) => meta);
    res.json({ bundles: list.reverse() });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`UnityPack Studio server running on http://localhost:${PORT}`);
  });
}

startServer();
