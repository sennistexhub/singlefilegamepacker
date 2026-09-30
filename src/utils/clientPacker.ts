import * as fflate from 'fflate';

export interface ClientPackProgress {
  stage: string;
  message: string;
  progress: number;
}

export interface ClientPackResult {
  bundleId: string;
  title: string;
  engineVersion: string;
  totalFiles: number;
  totalBytes: number;
  htmlBytes: number;
  durationMs: number;
  fileNameDownload: string;
  htmlContent: string;
  assets: {
    id: string;
    path: string;
    fileName: string;
    mime: string;
    size: number;
    category: 'unity-core' | 'wasm-emscripten' | 'script' | 'style' | 'deep-scan' | 'media' | 'config';
    inlined: boolean;
    compressed: 'gzip' | 'none';
  }[];
}

const CORS_PROXIES = [
  (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

export async function fetchWithCorsFallback(targetUrl: string): Promise<{ buffer: Uint8Array; contentType: string; finalUrl: string }> {
  // 1. Try local backend proxy if available
  try {
    const localRes = await fetch(`/api/proxy?url=${encodeURIComponent(targetUrl)}`);
    if (localRes.ok) {
      const ct = localRes.headers.get('content-type') || '';
      const ab = await localRes.arrayBuffer();
      return { buffer: new Uint8Array(ab), contentType: ct, finalUrl: targetUrl };
    }
  } catch {}

  // 2. Try direct fetch (if already CORS enabled or same-origin)
  try {
    const directRes = await fetch(targetUrl);
    if (directRes.ok) {
      const ct = directRes.headers.get('content-type') || '';
      const ab = await directRes.arrayBuffer();
      return { buffer: new Uint8Array(ab), contentType: ct, finalUrl: directRes.url || targetUrl };
    }
  } catch {}

  // 3. Try public CORS proxies (for GitHub Pages / Vercel static deployments)
  for (const proxyFn of CORS_PROXIES) {
    try {
      const proxyUrl = proxyFn(targetUrl);
      const res = await fetch(proxyUrl);
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        const ab = await res.arrayBuffer();
        return { buffer: new Uint8Array(ab), contentType: ct, finalUrl: targetUrl };
      }
    } catch {}
  }

  throw new Error(`Failed to fetch ${targetUrl} across all CORS proxies.`);
}
