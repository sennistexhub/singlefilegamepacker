import zlib from 'zlib';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

let fflateUmdCode = '';
try {
  fflateUmdCode = fs.readFileSync(path.resolve('./node_modules/fflate/umd/index.js'), 'utf8');
} catch {}

export interface PackOptions {
  targetUrl: string;
  spoofOrigin: boolean;
  deepScanIl2Cpp: boolean;
  stripAntiDebug: boolean;
  disableUnityCache: boolean;
  includeOfflineHud: boolean;
  extraAssetUrls?: string[];
}

export interface PackedAssetInfo {
  id: string;
  url: string;
  relPath: string;
  originPath: string;
  fileName: string;
  mime: string;
  size: number;
  category: 'unity-core' | 'wasm-emscripten' | 'script' | 'style' | 'deep-scan' | 'media' | 'config';
  source: string;
  status: number;
  inlined: boolean;
}

export interface InternalArchiveFile {
  name: string;
  offset: number;
  size: number;
}

export interface PackResult {
  bundleId: string;
  targetUrl: string;
  finalUrl: string;
  baseDirUrl: string;
  originUrl: string;
  title: string;
  engineVersion: string;
  companyName: string;
  productName: string;
  totalBytes: number;
  htmlBytes: number;
  durationMs: number;
  assets: PackedAssetInfo[];
  internalDataFiles: InternalArchiveFile[];
  detectedSitelocks: string[];
  il2cppLiteralsFound: string[];
  fileNameDownload: string;
  htmlContent: string;
}

export type ProgressCallback = (event: {
  stage: string;
  message: string;
  progress: number;
  assetUrl?: string;
  bytesLoaded?: number;
}) => void;

const TRANSPARENT_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const BUILTIN_IGNORE_LITERALS = new Set([
  'meta.json',
  'data_editor.json',
  '_editor.json',
  '.json',
  'ary.json',
  'graph.json',
  'data.unity3d',
  'unet.unity3d',
  'Camera_Base.png',
  'Camera_Overlay.png',
  'Camera_PostProcessing.png',
  'RegistryHivevalues.xml',
  'markup.xml',
  'node_link2.bin',
  'arygraph_references.bin',
  '_references.bin',
  '_extra.bin',
  'meta.bin',
  'collation.core.bin',
  'collation.tailoring.bin',
  'collation.cjkKOlv2.bin',
]);

function guessMimeType(urlPath: string, headerMime?: string | null): string {
  const clean = urlPath.split('?')[0].split('#')[0].toLowerCase();
  if (clean.endsWith('.wasm') || clean.endsWith('.wasm.code.unityweb') || clean.endsWith('.wasm.unityweb')) {
    return 'application/wasm';
  }
  if (
    clean.endsWith('.framework.unityweb') ||
    clean.endsWith('.framework.js.unityweb') ||
    clean.endsWith('.js') ||
    clean.endsWith('.mjs')
  ) {
    return 'application/javascript';
  }
  if (
    clean.endsWith('.data.unityweb') ||
    clean.endsWith('.data') ||
    clean.includes('.data.') ||
    clean.endsWith('.pck') ||
    clean.endsWith('.unity3d') ||
    clean.endsWith('.bundle') ||
    clean.endsWith('.bin') ||
    clean.endsWith('.mem')
  ) {
    return 'application/octet-stream';
  }
  if (clean.endsWith('.json') || clean.endsWith('.symbols')) return 'application/json';
  if (clean.endsWith('.css')) return 'text/css';
  if (clean.endsWith('.png') || clean.endsWith('.atlas')) return 'image/png';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.svg')) return 'image/svg+xml';
  if (clean.endsWith('.ico')) return 'image/x-icon';
  if (clean.endsWith('.mp3')) return 'audio/mpeg';
  if (clean.endsWith('.ogg')) return 'audio/ogg';
  if (clean.endsWith('.wav')) return 'audio/wav';
  if (clean.endsWith('.m4a') || clean.endsWith('.aac')) return 'audio/mp4';
  if (clean.endsWith('.woff2')) return 'font/woff2';
  if (clean.endsWith('.woff')) return 'font/woff';
  if (clean.endsWith('.ttf')) return 'font/ttf';
  if (clean.endsWith('.txt') || clean.endsWith('.csv')) return 'text/plain';
  if (clean.endsWith('.xml')) return 'application/xml';
  if (headerMime && headerMime !== 'null' && !headerMime.includes('text/html')) {
    return headerMime.split(';')[0].trim();
  }
  return 'application/octet-stream';
}

function categorizeAsset(url: string, source: string): PackedAssetInfo['category'] {
  const lower = url.toLowerCase();
  if (source.includes('IL2CPP') || source.includes('Deep Scan') || source.includes('Manual')) {
    return 'deep-scan';
  }
  if (
    lower.includes('.unityweb') ||
    lower.includes('unityloader') ||
    lower.includes('.loader.js') ||
    lower.includes('.framework.js')
  ) {
    return 'unity-core';
  }
  if (
    lower.endsWith('.wasm') ||
    lower.endsWith('.data') ||
    lower.includes('.data.') ||
    lower.endsWith('.pck') ||
    lower.endsWith('.mem') ||
    source.includes('Emscripten') ||
    source.includes('WebBlox') ||
    source.includes('WebAssembly') ||
    source.includes('Godot')
  ) {
    return 'wasm-emscripten';
  }
  if (source.includes('Build Config') || lower.endsWith('game.json') || lower.endsWith('build.json') || lower.endsWith('project.json')) {
    return 'config';
  }
  if (lower.endsWith('.js')) return 'script';
  if (lower.endsWith('.css')) return 'style';
  return 'media';
}

function computeBaseDirUrl(finalUrl: string): string {
  const u = new URL(finalUrl);
  if (u.pathname.endsWith('/')) {
    return u.origin + u.pathname;
  }
  const lastSeg = u.pathname.substring(u.pathname.lastIndexOf('/') + 1);
  if (lastSeg.includes('.')) {
    return u.origin + u.pathname.substring(0, u.pathname.lastIndexOf('/') + 1);
  }
  return u.origin + u.pathname + '/';
}

function computeRelPath(assetUrl: string, baseDirUrl: string): string {
  try {
    const asset = new URL(assetUrl);
    const base = new URL(baseDirUrl);
    if (asset.origin !== base.origin) {
      return asset.pathname.replace(/^\/+/, '');
    }
    if (asset.pathname.startsWith(base.pathname)) {
      return asset.pathname.slice(base.pathname.length).replace(/^\/+/, '');
    }
    const baseParts = base.pathname.split('/').filter(Boolean);
    const assetParts = asset.pathname.split('/').filter(Boolean);
    let common = 0;
    while (common < baseParts.length && common < assetParts.length && baseParts[common] === assetParts[common]) {
      common++;
    }
    const upCount = baseParts.length - common;
    const relParts = [...Array(upCount).fill('..'), ...assetParts.slice(common)];
    return relParts.join('/');
  } catch {
    return assetUrl;
  }
}

const cookieJar = new Map<string, string>();

async function fetchBufferWithRedirect(
  url: string,
  referer: string,
  timeoutMs = 60000
): Promise<{ status: number; finalUrl: string; buffer: Buffer; contentType: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const origin = new URL(url).origin;
    const cookieHeader = cookieJar.get(origin) || '';

    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: referer,
        Origin: new URL(referer).origin,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    const rawSetCookie = res.headers.get('set-cookie');
    if (rawSetCookie) {
      const existing = cookieJar.get(origin) || '';
      const newCookies = rawSetCookie.split(/,\s*(?=[a-zA-Z0-9_-]+=)/).map((c) => c.split(';')[0].trim()).filter(Boolean);
      const merged = [...existing.split('; ').filter(Boolean), ...newCookies];
      cookieJar.set(origin, Array.from(new Set(merged)).join('; '));
    }

    const arrayBuffer = await res.arrayBuffer();
    return {
      status: res.status,
      finalUrl: res.url || url,
      buffer: Buffer.from(arrayBuffer),
      contentType: res.headers.get('content-type'),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decompresses Unity / Emscripten data archives and extracts metadata string literals.
 */
function inspectUnityDataArchive(
  rawBuffer: Buffer,
  baseDirUrl: string,
  originUrl: string
): {
  internalFiles: InternalArchiveFile[];
  discoveredUrls: string[];
  sitelockDomains: string[];
  il2cppLiterals: string[];
} {
  const internalFiles: InternalArchiveFile[] = [];
  const discoveredUrls = new Set<string>();
  const sitelockDomains = new Set<string>();
  const il2cppLiterals: string[] = [];

  let data = rawBuffer;
  try {
    if (rawBuffer.length > 2 && rawBuffer[0] === 0x1f && rawBuffer[1] === 0x8b) {
      data = zlib.gunzipSync(rawBuffer);
    } else if (!rawBuffer.subarray(0, 16).toString('utf8').startsWith('UnityWebData')) {
      try {
        data = zlib.brotliDecompressSync(rawBuffer);
      } catch {
        // raw
      }
    }
  } catch {
    // raw
  }

  const magicHeader = data.subarray(0, 16).toString('utf8');
  if (magicHeader.startsWith('UnityWebData1.0')) {
    let o = 16;
    const headerLen = data.readUInt32LE(o);
    o += 4;
    while (o + 12 <= headerLen && o + 12 <= data.length) {
      const offset = data.readUInt32LE(o);
      o += 4;
      const size = data.readUInt32LE(o);
      o += 4;
      const nameLen = data.readUInt32LE(o);
      o += 4;
      if (o + nameLen > data.length) break;
      const name = data.subarray(o, o + nameLen).toString('utf8');
      o += nameLen;
      internalFiles.push({ name, offset, size });

      if (name.includes('global-metadata.dat') && offset + size <= data.length) {
        const meta = data.subarray(offset, offset + size);
        if (meta.length >= 24 && meta.readUInt32LE(0) === 0xfab11baf) {
          const litOffset = meta.readUInt32LE(8);
          const litCount = meta.readUInt32LE(12);
          const dataOffset = meta.readUInt32LE(16);
          const count = Math.floor(litCount / 8);

          for (let i = 0; i < count; i++) {
            const entryPos = litOffset + i * 8;
            if (entryPos + 8 > meta.length) break;
            const len = meta.readUInt32LE(entryPos);
            const idx = meta.readUInt32LE(entryPos + 4);
            if (len === 0 || len > 512 || dataOffset + idx + len > meta.length) continue;
            const s = meta.subarray(dataOffset + idx, dataOffset + idx + len).toString('utf8').trim();
            if (!s) continue;

            if (/^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/?$/.test(s)) {
              if (!s.includes('localhost') && !s.includes('microsoft.com') && !s.includes('w3.org')) {
                sitelockDomains.add(s);
                il2cppLiterals.push(s);
              }
              continue;
            }

            if (s.startsWith('http://') || s.startsWith('https://')) {
              try {
                const u = new URL(s);
                if (
                  u.origin === originUrl &&
                  /\.(json|txt|xml|csv|mp3|ogg|wav|png|jpg|jpeg|webp|bundle|unity3d|bin)$/i.test(u.pathname)
                ) {
                  discoveredUrls.add(u.href);
                  il2cppLiterals.push(s);
                }
              } catch {
                // ignore
              }
              continue;
            }

            if (
              !BUILTIN_IGNORE_LITERALS.has(s) &&
              !s.includes(' ') &&
              !s.includes('{') &&
              !s.startsWith('universal/') &&
              !s.startsWith('Packages/') &&
              /^(?:\/?[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.(json|txt|xml|csv|mp3|ogg|wav|png|jpg|jpeg|webp|bundle|unity3d|bin)$/i.test(
                s
              )
            ) {
              il2cppLiterals.push(s);
              try {
                if (s.startsWith('/')) {
                  discoveredUrls.add(new URL(s, originUrl).href);
                } else {
                  discoveredUrls.add(new URL(s, baseDirUrl).href);
                }
              } catch {
                // ignore
              }
            }
          }
        }
      }
    }
  }

  return {
    internalFiles,
    discoveredUrls: Array.from(discoveredUrls),
    sitelockDomains: Array.from(sitelockDomains),
    il2cppLiterals: Array.from(new Set(il2cppLiterals)),
  };
}

export async function packGameFromUrl(
  options: PackOptions,
  onProgress?: ProgressCallback
): Promise<PackResult> {
  const startTime = Date.now();
  const bundleId = crypto.randomUUID();

  let normalizedInputUrl = options.targetUrl.trim();
  if (!/^https?:\/\//i.test(normalizedInputUrl)) {
    normalizedInputUrl = 'https://' + normalizedInputUrl;
  }

  onProgress?.({
    stage: 'entry',
    message: `Fetching entry document from ${normalizedInputUrl}`,
    progress: 5,
    assetUrl: normalizedInputUrl,
  });

  // Fetch entry HTML
  let entryRes = await fetchBufferWithRedirect(normalizedInputUrl, normalizedInputUrl);
  if (entryRes.status >= 400) {
    throw new Error(`Entry URL returned HTTP ${entryRes.status}: ${normalizedInputUrl}`);
  }

  let finalUrl = entryRes.finalUrl;
  let baseDirUrl = computeBaseDirUrl(finalUrl);
  if (!finalUrl.endsWith('/') && !finalUrl.split('/').pop()?.includes('.')) {
    finalUrl = finalUrl + '/';
    baseDirUrl = finalUrl;
  }
  let originUrl = new URL(finalUrl).origin;
  let htmlText = entryRes.buffer.toString('utf8');

  // Check for game iframes on game portal wrapper pages
  const isDirectGameDocument =
    (/<canvas\b|class=["'][^"']*emscripten|UnityLoader|createUnityInstance|Module\b/i.test(htmlText) &&
      !htmlText.includes('<iframe class="game-iframe"') &&
      !htmlText.includes('id="game-area"'));

  if (!isDirectGameDocument) {
    const iframeMatch =
      htmlText.match(/<iframe[^>]+class=["'][^"']*game-iframe[^"']*["'][^>]+src=["']([^"']+)["']/i) ||
      htmlText.match(/<iframe[^>]+id=["']game-area["'][^>]+src=["']([^"']+)["']/i) ||
      htmlText.match(/<iframe[^>]+class=["'][^"']*game-player[^"']*["'][^>]+src=["']([^"']+)["']/i) ||
      htmlText.match(/<iframe[^>]+src=["']([^"']+(?:\/games\/|\/game\/|\/play\/|unity|webgl|fancade)[^"']*)["']/i);

    if (
      iframeMatch &&
      iframeMatch[1] &&
      !iframeMatch[1].includes('googletagmanager') &&
      !iframeMatch[1].includes('doubleclick') &&
      !iframeMatch[1].includes('googleads') &&
      !iframeMatch[1].includes('aswift')
    ) {
      try {
        const nestedUrl = new URL(iframeMatch[1], baseDirUrl).href;
        onProgress?.({
          stage: 'entry',
          message: `Detected embedded game iframe: ${nestedUrl}`,
          progress: 8,
          assetUrl: nestedUrl,
        });
        const nestedRes = await fetchBufferWithRedirect(nestedUrl, finalUrl);
        if (nestedRes.status === 200) {
          entryRes = nestedRes;
          finalUrl = nestedRes.finalUrl;
          baseDirUrl = computeBaseDirUrl(finalUrl);
          originUrl = new URL(finalUrl).origin;
          htmlText = nestedRes.buffer.toString('utf8');
        }
      } catch {
        // fallback
      }
    }
  }

  // Strip Cloudflare Turnstile / Challenge-platform & ad / cookie check scripts from raw HTML cleanly
  htmlText = htmlText.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?(?:challenge-platform|__CF\$cv\$params)(?:(?!<\/script>)[\s\S])*?<\/script>/gi, '');
  htmlText = htmlText.replace(/<script\b[^>]*src=["'][^"']*(?:challenge-platform|google-analytics|gtag|doubleclick|pagead2|adsbygoogle)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, '');

  const titleMatch = htmlText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let gameTitle = titleMatch ? titleMatch[1].trim() : '';

  interface InternalAssetRecord {
    id: string;
    url: string;
    relPath: string;
    originPath: string;
    fileName: string;
    mime: string;
    buffer: Buffer;
    category: PackedAssetInfo['category'];
    source: string;
    status: number;
    inlined: boolean;
  }

  const assetMap = new Map<string, InternalAssetRecord>();
  let chunkCounter = 0;

  const registerAsset = (
    url: string,
    buffer: Buffer,
    mime: string,
    source: string,
    status: number,
    inlined = false
  ): InternalAssetRecord => {
    const cleanUrl = url.split('#')[0];
    const existing = assetMap.get(cleanUrl);
    if (existing) {
      if (inlined) existing.inlined = true;
      return existing;
    }
    const u = new URL(cleanUrl);
    const relPath = computeRelPath(cleanUrl, baseDirUrl);
    const originPath = u.pathname;
    const fileName = u.pathname.substring(u.pathname.lastIndexOf('/') + 1) || 'index';
    const record: InternalAssetRecord = {
      id: `__vfs_chunk_${chunkCounter++}`,
      url: cleanUrl,
      relPath,
      originPath,
      fileName,
      mime,
      buffer,
      category: categorizeAsset(cleanUrl, source),
      source,
      status,
      inlined,
    };
    assetMap.set(cleanUrl, record);
    return record;
  };

  // 1. Discover HTML Media (images, icons, covers, audio)
  onProgress?.({
    stage: 'media',
    message: 'Extracting HTML images, cover art & media elements...',
    progress: 12,
  });

  const mediaReplacements = new Map<string, string>();
  const mediaRegex = /<(?:img|audio|video|source|input)\b[^>]*(?:src)=["']([^"']+)["'][^>]*>/gi;
  let mediaMatch: RegExpExecArray | null;
  const discoveredMediaUrls = new Set<string>();

  while ((mediaMatch = mediaRegex.exec(htmlText)) !== null) {
    const rawSrc = mediaMatch[1].trim();
    if (rawSrc.startsWith('data:') || rawSrc.startsWith('blob:') || rawSrc.startsWith('#')) continue;
    try {
      discoveredMediaUrls.add(new URL(rawSrc, baseDirUrl).href);
    } catch {}
  }

  const iconRegex = /<link\b[^>]*(?:rel=["'](?:shortcut\s+)?icon["']|href=["']([^"']+\.(?:png|jpg|ico|svg|webp))["'])[^>]*>/gi;
  let iconMatch: RegExpExecArray | null;
  while ((iconMatch = iconRegex.exec(htmlText)) !== null) {
    const tag = iconMatch[0];
    const hrefM = tag.match(/href=["']([^"']+)["']/i);
    if (hrefM && hrefM[1] && !hrefM[1].startsWith('data:')) {
      try {
        discoveredMediaUrls.add(new URL(hrefM[1], baseDirUrl).href);
      } catch {}
    }
  }

  // Fetch all HTML media in parallel
  await Promise.all(
    Array.from(discoveredMediaUrls).map(async (mediaUrl) => {
      try {
        const res = await fetchBufferWithRedirect(mediaUrl, finalUrl, 20000);
        if (res.status === 200 && res.buffer.length > 0) {
          const mime = guessMimeType(mediaUrl, res.contentType);
          registerAsset(mediaUrl, res.buffer, mime, 'HTML media element', 200, true);
          const b64 = res.buffer.toString('base64');
          const dataUri = `data:${mime};base64,${b64}`;
          const rel = computeRelPath(mediaUrl, baseDirUrl);
          mediaReplacements.set(rel, dataUri);
          mediaReplacements.set(mediaUrl, dataUri);
        }
      } catch {}
    })
  );

  // 2. Discover & Fetch Stylesheets and their CSS url(...) sub-resources
  onProgress?.({
    stage: 'styles',
    message: 'Fetching stylesheets and embedding UI graphics...',
    progress: 18,
  });

  const stylesheetLinks: { fullTag: string; href: string; resolvedUrl: string }[] = [];
  const linkRegex = /<link\b[^>]*>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRegex.exec(htmlText)) !== null) {
    const tag = linkMatch[0];
    if (/rel=["']?stylesheet["']?/i.test(tag)) {
      const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
      if (hrefMatch && hrefMatch[1]) {
        try {
          const resolvedUrl = new URL(hrefMatch[1], baseDirUrl).href;
          stylesheetLinks.push({ fullTag: tag, href: hrefMatch[1], resolvedUrl });
        } catch {}
      }
    }
  }

  const inlinedStylesMap = new Map<string, string>();
  for (const cssItem of stylesheetLinks) {
    try {
      const res = await fetchBufferWithRedirect(cssItem.resolvedUrl, finalUrl);
      if (res.status === 200) {
        let cssText = res.buffer.toString('utf8');
        registerAsset(cssItem.resolvedUrl, res.buffer, 'text/css', 'HTML <link rel="stylesheet">', 200, true);

        const cssUrlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
        const cssSubUrls = new Map<string, string>();
        let m: RegExpExecArray | null;
        while ((m = cssUrlRegex.exec(cssText)) !== null) {
          const rawSub = m[2].trim();
          if (rawSub.startsWith('data:') || rawSub.startsWith('blob:') || rawSub.startsWith('#')) continue;
          try {
            const absSub = new URL(rawSub, cssItem.resolvedUrl).href;
            cssSubUrls.set(rawSub, absSub);
          } catch {}
        }

        const subEntries = Array.from(cssSubUrls.entries());
        const subResults = await Promise.all(
          subEntries.map(async ([rawSub, absSub]) => {
            try {
              const subRes = await fetchBufferWithRedirect(absSub, cssItem.resolvedUrl);
              return { rawSub, absSub, subRes };
            } catch {
              return { rawSub, absSub, subRes: null };
            }
          })
        );

        for (const { rawSub, absSub, subRes } of subResults) {
          const mime = guessMimeType(absSub, subRes?.contentType);
          if (subRes && subRes.status === 200 && subRes.buffer.length > 0) {
            registerAsset(absSub, subRes.buffer, mime, 'CSS url() sub-resource', 200, true);
            const b64 = subRes.buffer.toString('base64');
            cssText = cssText.split(rawSub).join(`data:${mime};base64,${b64}`);
          } else {
            const darkCounterpart = subResults.find(
              (r) =>
                r.rawSub === rawSub.replace('.Light.', '.Dark.') &&
                r.subRes &&
                r.subRes.status === 200
            );
            if (darkCounterpart && darkCounterpart.subRes) {
              const darkMime = guessMimeType(darkCounterpart.absSub, darkCounterpart.subRes.contentType);
              const b64 = darkCounterpart.subRes.buffer.toString('base64');
              cssText = cssText.split(rawSub).join(`data:${darkMime};base64,${b64}`);
              registerAsset(absSub, darkCounterpart.subRes.buffer, darkMime, 'CSS url() Dark Fallback', 200, true);
            } else {
              cssText = cssText.split(rawSub).join(`data:image/png;base64,${TRANSPARENT_PNG_B64}`);
            }
          }
        }

        inlinedStylesMap.set(cssItem.fullTag, `<style data-source="${cssItem.href}">\n${cssText}\n</style>`);
      }
    } catch {}
  }

  // Also process inline <style> tags in htmlText for url(...) sub-resources
  const inlineStyleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let inlineStyleMatch: RegExpExecArray | null;
  while ((inlineStyleMatch = inlineStyleRegex.exec(htmlText)) !== null) {
    const rawStyleBody = inlineStyleMatch[1];
    const cssUrlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = cssUrlRegex.exec(rawStyleBody)) !== null) {
      const rawSub = m[2].trim();
      if (rawSub.startsWith('data:') || rawSub.startsWith('blob:') || rawSub.startsWith('#')) continue;
      try {
        const absSub = new URL(rawSub, baseDirUrl).href;
        discoveredMediaUrls.add(absSub);
      } catch {}
    }
  }

  // 3. Discover & Fetch External Scripts & Dynamic Script References
  onProgress?.({
    stage: 'scripts',
    message: 'Fetching game scripts, engine modules & WebAssembly loaders...',
    progress: 26,
  });

  const externalScripts: { fullTag: string; src: string; resolvedUrl: string }[] = [];
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const inlineScripts: string[] = [];
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptRegex.exec(htmlText)) !== null) {
    const attrs = scriptMatch[1] || '';
    const body = scriptMatch[2] || '';
    const srcMatch = attrs.match(/\bsrc=["']([^"']+)["']/i);
    if (srcMatch && srcMatch[1]) {
      const rawSrc = srcMatch[1];
      if (
        rawSrc.includes('google-analytics') ||
        rawSrc.includes('googletagmanager') ||
        rawSrc.includes('pagead2') ||
        rawSrc.includes('doubleclick') ||
        rawSrc.includes('challenge-platform')
      ) {
        continue;
      }
      try {
        const resolvedUrl = new URL(rawSrc, baseDirUrl).href;
        externalScripts.push({ fullTag: scriptMatch[0], src: rawSrc, resolvedUrl });
      } catch {}
    } else if (body.trim()) {
      inlineScripts.push(body);
    }
  }

  const inlinedScriptsMap = new Map<string, string>();
  const allJsTexts: { url: string; code: string }[] = inlineScripts.map((code) => ({
    url: finalUrl,
    code,
  }));

  // Fetch initial external scripts
  await Promise.all(
    externalScripts.map(async (scr) => {
      // If it is a known ad wrapper like Jump_Gamemonetize, replace with clean no-op
      if (scr.src.toLowerCase().includes('gamemonetize') || scr.src.toLowerCase().includes('jump_game')) {
        inlinedScriptsMap.set(
          scr.fullTag,
          `<script data-source="${scr.src}">\n/* Neutralized GameMonetize Ad Wrapper */\nwindow.sdk={showBanner:function(){},init:function(){return Promise.resolve();},showAd:function(){return Promise.resolve();}};\n</script>`
        );
        return;
      }

      try {
        const res = await fetchBufferWithRedirect(scr.resolvedUrl, finalUrl);
        const isHtml404 =
          res.status >= 400 ||
          (res.contentType?.includes('text/html') && res.buffer.subarray(0, 100).toString('utf8').toLowerCase().includes('<html')) ||
          res.buffer.subarray(0, 50).toString('utf8').toLowerCase().includes('<!doctype html');

        if (res.status === 200 && !isHtml404 && res.buffer.length > 0) {
          let jsCode = res.buffer.toString('utf8');
          allJsTexts.push({ url: scr.resolvedUrl, code: jsCode });
          registerAsset(scr.resolvedUrl, res.buffer, 'application/javascript', 'HTML <script src>', 200, true);

          if (jsCode.includes('UnityLoader') || scr.resolvedUrl.toLowerCase().includes('unityloader')) {
            jsCode = jsCode.replace(
              /0\s*==\s*document\.URL\.indexOf\(["']file:["']\)\s*&&\s*alert\([^)]+\)/g,
              'false'
            );
            jsCode = jsCode.replace(
              /window\.location\.href\.match\(\/\^\[a-z\]\+:\/\/\[\^\/\]\+\/\)/g,
              '((window.__VFS_LOCATION__||window.location).href.match(/^[a-z]+:\\/\\/[^\\/]+/)||["https://localhost"])'
            );
          }

          const safeJsCode = jsCode.replace(/<\/script/gi, '<\\/script');
          inlinedScriptsMap.set(
            scr.fullTag,
            `<script data-source="${scr.src}">\n${safeJsCode}\n</script>`
          );
        } else {
          // 404 Guard: don't inline HTML error pages into script tags
          inlinedScriptsMap.set(scr.fullTag, `<!-- Script ${scr.src} not found on server (skipped) -->`);
        }
      } catch {
        inlinedScriptsMap.set(scr.fullTag, `<!-- Script ${scr.src} failed to fetch (skipped) -->`);
      }
    })
  );

  // 4. Universal Engine & WebAssembly Asset Discovery
  onProgress?.({
    stage: 'discovery',
    message: 'Scanning JavaScript bundles for WebAssembly, chunks & data packages...',
    progress: 36,
  });

  let engineVersion = 'HTML5 / WebAssembly';
  let companyName = '';
  let productName = '';

  const unityJsonUrls = new Set<string>();
  const discoveredAssetUrls = new Map<string, string>(); // url -> source description
  const scannedScriptUrls = new Set<string>();

  // Iterative script scanner: recursively discovers dynamically loaded scripts (e.g. rblx.js, workers, chunks)
  let scriptScanIdx = 0;
  while (scriptScanIdx < allJsTexts.length) {
    const currentSlice = allJsTexts.slice(scriptScanIdx);
    scriptScanIdx = allJsTexts.length;

    for (const { url: scriptBaseUrl, code } of currentSlice) {
      const scriptDir = scriptBaseUrl.substring(0, scriptBaseUrl.lastIndexOf('/') + 1);

    // Detect Engine Version
    if (code.includes('UnityLoader') || code.includes('createUnityInstance') || code.includes('.unityweb')) {
      engineVersion = 'Unity WebGL';
    } else if (code.includes('ENVIRONMENT_IS_PTHREAD') || code.includes('PACKAGE_NAME') || code.includes('wasmBinary') || code.includes('fancade') || code.includes('index.data')) {
      engineVersion = 'Emscripten / WebAssembly';
    } else if (code.includes('rblx') || code.includes('WebBlox')) {
      engineVersion = 'WebBlox / WebAssembly';
    } else if (code.includes('Godot') || code.includes('.pck')) {
      engineVersion = 'Godot Engine';
    } else if (code.includes('c2runtime') || code.includes('c3runtime')) {
      engineVersion = 'Construct Engine';
    } else if (code.includes('Phaser')) {
      engineVersion = 'Phaser Engine';
    }

    // A. Dynamic Script and Worker loading: s.src = 'rblx.js', importScripts('worker.js'), register('./coi-serviceworker.js')
    const dynamicScriptRegex = /(?:src|href|register|importScripts|loadScript)\s*(?:=|\()\s*["'`]([^"'`]+\.js(?:\?[^"'`]*)?)["'`]/gi;
    let sm: RegExpExecArray | null;
    const newScriptUrls: string[] = [];
    while ((sm = dynamicScriptRegex.exec(code)) !== null) {
      const candidateScript = sm[1].trim();
      if (candidateScript.includes('google') || candidateScript.includes('doubleclick') || candidateScript.includes('challenge-platform')) continue;
      try {
        const resolved = new URL(candidateScript, scriptDir).href;
        if (!scannedScriptUrls.has(resolved) && !assetMap.has(resolved)) {
          scannedScriptUrls.add(resolved);
          newScriptUrls.push(resolved);
        }
      } catch {}
    }

    // Fetch any newly found dynamic scripts
    if (newScriptUrls.length > 0) {
      await Promise.all(
        newScriptUrls.map(async (dynUrl) => {
          try {
            const res = await fetchBufferWithRedirect(dynUrl, finalUrl);
            if (res.status === 200 && res.buffer.length > 0) {
              const dynCode = res.buffer.toString('utf8');
              allJsTexts.push({ url: dynUrl, code: dynCode });
              registerAsset(dynUrl, res.buffer, 'application/javascript', 'Dynamic Script Loader', 200, false);
            }
          } catch {}
        })
      );
    }

    // B. Chunk Loop Detection (e.g. CHUNK_COUNT = 12 with fetch('rblx.data.' + i))
    const chunkCountMatch = code.match(/(?:CHUNK_COUNT|numChunks|chunksCount|TOTAL_CHUNKS|chunkCount)\s*=\s*(\d+)/i);
    const chunkCount = chunkCountMatch ? parseInt(chunkCountMatch[1], 10) : 0;

    const chunkPatternMatch = code.match(/['"]([^'"]+?\.(?:data|bin|part|chunk)\.)['"]\s*\+\s*[a-zA-Z0-9_]+/i);
    if (chunkPatternMatch && chunkPatternMatch[1]) {
      const prefix = chunkPatternMatch[1];
      const maxChunks = chunkCount > 0 ? chunkCount : 24;
      for (let i = 0; i < maxChunks; i++) {
        try {
          const chunkRel = `${prefix}${i}`;
          const chunkResolved = new URL(chunkRel, scriptDir).href;
          discoveredAssetUrls.set(chunkResolved, `Chunked Data Part ${i}`);
        } catch {}
      }
    }

    // C. Unity Config JSONs
    const instRegex = /UnityLoader\s*\.\s*instantiate(?:Async)?\s*\(\s*[^,]+,\s*["'`]([^"'`]+\.json[^"'`]*)["'`]/g;
    let m: RegExpExecArray | null;
    while ((m = instRegex.exec(code)) !== null) {
      try { unityJsonUrls.add(new URL(m[1], baseDirUrl).href); } catch {}
    }

    const buildJsonRegex = /["'`]((?:[^"'`]*\/)?Build\/[^"'`]+\.json)["'`]/g;
    while ((m = buildJsonRegex.exec(code)) !== null) {
      try { unityJsonUrls.add(new URL(m[1], baseDirUrl).href); } catch {}
    }

    // D. Unity 2020+ buildUrl
    const buildUrlVarMatch = code.match(/(?:var|let|const)\s+buildUrl\s*=\s*["'`]([^"'`]+)["'`]/);
    const buildUrlPrefix = buildUrlVarMatch ? buildUrlVarMatch[1] : 'Build';
    const concatRegex = /buildUrl\s*\+\s*["'`]\/([^"'`]+)["'`]/g;
    while ((m = concatRegex.exec(code)) !== null) {
      try {
        const resolved = new URL(`${buildUrlPrefix}/${m[1]}`, baseDirUrl).href;
        discoveredAssetUrls.set(resolved, 'Unity 2020+ Config');
      } catch {}
    }

    // E. Emscripten PACKAGE_NAME & wasmBinaryFile / locateFile
    const pkgMatch = code.match(/PACKAGE_NAME\s*=\s*["'`]([^"'`]+)["'`]/);
    if (pkgMatch && pkgMatch[1]) {
      try {
        discoveredAssetUrls.set(new URL(pkgMatch[1], scriptDir).href, 'Emscripten Data Package');
        discoveredAssetUrls.set(new URL(pkgMatch[1], baseDirUrl).href, 'Emscripten Data Package');
      } catch {}
    }

    // F. Universal Regex: matches all .data, .wasm, .pck, .unityweb, .mem, .symbols, .json, .atlas, .skel, audio/video, fonts, images in string literals
    const universalAssetRegex =
      /["'`]((?:(?:\.\/|\/)?(?:[a-zA-Z0-9_.-]+\/)*)[a-zA-Z0-9_.-]+\.(?:data\.unityweb|wasm\.code\.unityweb|wasm\.framework\.unityweb|wasm\.unityweb|wasm|data(?:\.\d+)?|pck|mem|symbols|atlas|skel|json|bin|dat|xml|csv|tsv|txt|mp3|ogg|wav|m4a|aac|flac|woff2|woff|ttf|png|jpg|jpeg|webp|gif|svg|ico|css))(?:\?[^"'`]*)?["'`]/gi;
    while ((m = universalAssetRegex.exec(code)) !== null) {
      let candidate = m[1].replace(/^\.?\/+/, '');
      if (candidate.startsWith('http://') || candidate.startsWith('https://')) {
        try {
          const u = new URL(candidate);
          if (u.origin === originUrl) {
            discoveredAssetUrls.set(u.href, 'Discovered Script Asset');
          }
        } catch {}
      } else if (!BUILTIN_IGNORE_LITERALS.has(candidate) && !candidate.startsWith('universal/')) {
        try {
          discoveredAssetUrls.set(new URL(candidate, scriptDir).href, 'Script Referenced Asset');
          discoveredAssetUrls.set(new URL(candidate, baseDirUrl).href, 'Script Referenced Asset');
          discoveredAssetUrls.set(new URL(candidate, originUrl).href, 'Script Referenced Asset');
        } catch {}
      }
    }
  }
  }

  // 5. Fetch Unity JSON Config(s) and extract their build artifact URLs
  for (const jsonUrl of unityJsonUrls) {
    onProgress?.({
      stage: 'config',
      message: `Parsing build config: ${computeRelPath(jsonUrl, baseDirUrl)}`,
      progress: 42,
      assetUrl: jsonUrl,
    });

    const jsonRes = await fetchBufferWithRedirect(jsonUrl, finalUrl);
    if (jsonRes.status === 200) {
      try {
        const jsonObj = JSON.parse(jsonRes.buffer.toString('utf8'));
        if (jsonObj.companyName) companyName = jsonObj.companyName;
        if (jsonObj.productName) productName = jsonObj.productName;
        if (jsonObj.unityVersion) engineVersion = `Unity ${jsonObj.unityVersion}`;

        if (options.disableUnityCache) {
          jsonObj.cacheControl = { default: 'no-cache' };
        }

        const patchedJsonBuffer = Buffer.from(JSON.stringify(jsonObj), 'utf8');
        registerAsset(jsonUrl, patchedJsonBuffer, 'application/json', 'Build Config JSON', 200, false);

        const jsonDirUrl = jsonUrl.substring(0, jsonUrl.lastIndexOf('/') + 1);
        const urlKeys = [
          'dataUrl',
          'wasmCodeUrl',
          'wasmFrameworkUrl',
          'wasmMemoryUrl',
          'wasmSymbolsUrl',
          'asmCodeUrl',
          'asmMemoryUrl',
          'asmFrameworkUrl',
          'backgroundUrl',
          'progressLogoUrl',
          'progressEmptyUrl',
          'progressFullUrl',
        ];
        for (const k of urlKeys) {
          if (typeof jsonObj[k] === 'string' && jsonObj[k].trim()) {
            try {
              const artifactUrl = new URL(jsonObj[k], jsonDirUrl).href;
              discoveredAssetUrls.set(artifactUrl, `Build Config (${k})`);
            } catch {}
          }
        }
      } catch {
        registerAsset(jsonUrl, jsonRes.buffer, 'application/json', 'Build Config JSON', 200, false);
      }
    }
  }

  // 6. Download all discovered binary & data artifacts (.wasm, .data, .pck, .unityweb, etc.)
  const candidateEntries = Array.from(discoveredAssetUrls.entries()).filter(([u]) => !assetMap.has(u));
  let dataArchiveBuffers: { url: string; buffer: Buffer }[] = [];

  if (candidateEntries.length > 0) {
    let completedArtifacts = 0;
    onProgress?.({
      stage: 'binary',
      message: `Downloading ${candidateEntries.length} game engine binaries & data packages...`,
      progress: 48,
    });

    await Promise.all(
      candidateEntries.map(async ([artifactUrl, source]) => {
        const rel = computeRelPath(artifactUrl, baseDirUrl);
        try {
          const res = await fetchBufferWithRedirect(artifactUrl, finalUrl, 90000);
          completedArtifacts++;

          const isHtmlFallback =
            res.status >= 400 ||
            (res.contentType?.includes('text/html') &&
              !artifactUrl.endsWith('.html') &&
              res.buffer.subarray(0, 100).toString('utf8').toLowerCase().includes('<html'));

          if (res.status === 200 && !isHtmlFallback && res.buffer.length > 0) {
            const mime = guessMimeType(artifactUrl, res.contentType);
            registerAsset(artifactUrl, res.buffer, mime, source, 200, false);

            if (
              artifactUrl.includes('.data') ||
              artifactUrl.includes('.pck') ||
              source.includes('dataUrl') ||
              source.includes('Data Package')
            ) {
              dataArchiveBuffers.push({ url: artifactUrl, buffer: res.buffer });
            }

            onProgress?.({
              stage: 'binary',
              message: `Downloaded ${rel} (${(res.buffer.length / (1024 * 1024)).toFixed(2)} MB)`,
              progress: 50 + Math.round((completedArtifacts / candidateEntries.length) * 30),
              assetUrl: artifactUrl,
              bytesLoaded: res.buffer.length,
            });
          }
        } catch {}
      })
    );
  }

  // 7. Deep Scan UnityWebData1.0 / IL2CPP metadata
  const internalDataFiles: InternalArchiveFile[] = [];
  const detectedSitelocks = new Set<string>();
  const il2cppLiteralsFound = new Set<string>();
  const deepDiscoveredUrls = new Map<string, string>();

  if (options.deepScanIl2Cpp && dataArchiveBuffers.length > 0) {
    onProgress?.({
      stage: 'deep-scan',
      message: 'Deep-scanning data archives for internal files & runtime URLs...',
      progress: 82,
    });

    for (const { buffer } of dataArchiveBuffers) {
      const scanResult = inspectUnityDataArchive(buffer, baseDirUrl, originUrl);
      for (const f of scanResult.internalFiles) internalDataFiles.push(f);
      for (const d of scanResult.sitelockDomains) detectedSitelocks.add(d);
      for (const lit of scanResult.il2cppLiterals) il2cppLiteralsFound.add(lit);
      for (const u of scanResult.discoveredUrls) {
        if (!assetMap.has(u)) {
          deepDiscoveredUrls.set(u, 'IL2CPP Metadata Deep Scan');
        }
      }
    }
  }

  // Extra manual assets
  if (options.extraAssetUrls && options.extraAssetUrls.length > 0) {
    for (const rawExtra of options.extraAssetUrls) {
      const trimmed = rawExtra.trim();
      if (!trimmed) continue;
      try {
        const resolved = new URL(trimmed, baseDirUrl).href;
        if (!assetMap.has(resolved)) {
          deepDiscoveredUrls.set(resolved, 'Manual VFS Injection');
        }
      } catch {}
    }
  }

  if (deepDiscoveredUrls.size > 0) {
    onProgress?.({
      stage: 'deep-scan-fetch',
      message: `Fetching ${deepDiscoveredUrls.size} runtime assets found via deep scan...`,
      progress: 88,
    });

    await Promise.all(
      Array.from(deepDiscoveredUrls.entries()).map(async ([u, source]) => {
        try {
          const res = await fetchBufferWithRedirect(u, finalUrl, 30000);
          const isHtmlFallback =
            res.contentType?.includes('text/html') &&
            !u.endsWith('.html') &&
            res.buffer.subarray(0, 100).toString('utf8').toLowerCase().includes('<html');

          if (res.status === 200 && !isHtmlFallback && res.buffer.length > 0) {
            const mime = guessMimeType(u, res.contentType);
            registerAsset(u, res.buffer, mime, source, 200, false);
          }
        } catch {}
      })
    );
  }

  const finalTitle =
    productName || gameTitle || new URL(finalUrl).pathname.split('/').filter(Boolean).pop() || 'Offline Web Game';

  onProgress?.({
    stage: 'compile',
    message: `Compiling single-file offline HTML with Virtual File System (${assetMap.size} assets)...`,
    progress: 94,
  });

  // 8. Build Single-File Offline HTML with Universal VFS Runtime
  const isWebBlox =
    options.targetUrl.toLowerCase().includes('webblox') ||
    finalUrl.toLowerCase().includes('webblox') ||
    engineVersion.includes('WebBlox') ||
    Array.from(assetMap.values()).some((a) => a.url.includes('rblx'));

  const vfsRecords = Array.from(assetMap.values()).filter((a) => !a.inlined);

  // Compress WebBlox data chunks only (keeps others uncompressed)
  const processedVfsRecords = vfsRecords.map((rec) => {
    if (isWebBlox && (rec.url.includes('rblx.data') || rec.fileName.includes('.data') || rec.fileName.includes('rblx.'))) {
      const compressedBuffer = zlib.gzipSync(rec.buffer);
      return {
        ...rec,
        buffer: compressedBuffer,
        compressed: 'gzip',
        uncompressedSize: rec.buffer.length,
      };
    }
    return {
      ...rec,
      compressed: 'none',
      uncompressedSize: rec.buffer.length,
    };
  });

  const vfsChunksHtml = processedVfsRecords
    .map((rec) => {
      const b64 = rec.buffer.toString('base64');
      return `<script type="text/plain" id="${rec.id}" data-size="${rec.uncompressedSize}" data-mime="${rec.mime}" data-compressed="${rec.compressed}">${b64}</script>`;
    })
    .join('\n');

  const vfsManifestJson = JSON.stringify(
    processedVfsRecords.map((rec) => ({
      id: rec.id,
      url: rec.url,
      relPath: rec.relPath,
      originPath: rec.originPath,
      fileName: rec.fileName,
      mime: rec.mime,
      size: rec.uncompressedSize,
      compressed: rec.compressed,
    }))
  );

  const decompressorScript = isWebBlox && fflateUmdCode
    ? `<script data-vfs-decompressor="fflate">\n${fflateUmdCode}\n</script>\n`
    : '';

  const vfsBootstrapScript = `<script data-vfs-runtime="unitypack-v1">
(function() {
  var VFS_PAGE_URL = ${JSON.stringify(finalUrl)};
  var VFS_BASE_URL = ${JSON.stringify(baseDirUrl)};
  var VFS_ORIGIN = ${JSON.stringify(originUrl)};
  var SPOOF_ORIGIN = ${JSON.stringify(options.spoofOrigin)};
  var STRIP_ANTI_DEBUG = ${JSON.stringify(options.stripAntiDebug)};
  var VFS_MANIFEST = ${vfsManifestJson};

  // 1. Universal Ad & Game SDK Shims (Poki, GameMonetize, CrazyGames, GameDistribution, Ads)
  window.PokiSDK = window.PokiSDK || {
    init: function() { return Promise.resolve(); },
    commercialBreak: function() { return Promise.resolve(); },
    rewardedBreak: function() { return Promise.resolve(true); },
    gameplayStart: function() {},
    gameplayStop: function() {},
    happyTime: function() {},
    gameLoadingStart: function() {},
    gameLoadingProgress: function() {},
    gameLoadingFinished: function() {},
    setDebug: function() {},
    measure: function() {},
    destroyAd: function() {},
    getLeaderboard: function() { return Promise.resolve([]); },
    shareableURL: function() { return Promise.resolve(window.location.href); },
    getPayload: function() { return Promise.resolve(''); },
    isAdBlocked: function() { return false; }
  };

  window.sdk = window.sdk || {
    showBanner: function() {},
    init: function() { return Promise.resolve(); },
    showAd: function() { return Promise.resolve(); }
  };
  window.cpmstarAPI = function(options) {
    if (options && options.kind === 'game.displayInterstitial') {
      window.postMessage({ type: 'commercialBreak' }, '*');
    }
  };
  window.invokeApplixirVideoUnit = function(options) {
    if (options && typeof options.adStatusCb === 'function') options.adStatusCb('');
  };
  window.gdsdk = window.gdsdk || { showAd: function() { return Promise.resolve(); }, showBanner: function() {} };
  window.CrazyGames = window.CrazyGames || { SDK: { init: function() { return Promise.resolve(); }, ad: { requestAd: function() { return Promise.resolve(); }, hasAdblock: function() { return Promise.resolve(false); } } } };
  window.CrazySDK = window.CrazySDK || window.CrazyGames.SDK;
  window.famobi = window.famobi || { hasFeature: function() { return false; }, log: function() {}, getLanguage: function() { return 'en'; } };
  window.famobi_analytics = window.famobi_analytics || { trackEvent: function() {} };
  window.adsbygoogle = window.adsbygoogle || [];
  window.gamemonetize = window.gamemonetize || { init: function() { return Promise.resolve(); } };

  // 2. Service Worker & crossOriginIsolated Guard (prevents infinite reload loops on file:// and sandboxes)
  try {
    if (typeof window.crossOriginIsolated === 'undefined') {
      Object.defineProperty(window, 'crossOriginIsolated', {
        get: function() { return true; },
        configurable: true
      });
    }
  } catch (e) {}

  if (navigator.serviceWorker) {
    var dummyReg = {
      scope: '/',
      active: { state: 'activated' },
      installing: null,
      waiting: null,
      update: function() { return Promise.resolve(); },
      unregister: function() { return Promise.resolve(true); },
      addEventListener: function() {},
      removeEventListener: function() {}
    };
    navigator.serviceWorker.register = function() {
      return Promise.resolve(dummyReg);
    };
  }

  // 3. Anti-DevTools Debugger Trap Neutralizer
  if (STRIP_ANTI_DEBUG) {
    try {
      var OrigFunction = window.Function;
      var SafeFunction = function() {
        var args = Array.prototype.slice.call(arguments);
        for (var i = 0; i < args.length; i++) {
          if (typeof args[i] === 'string' && args[i].indexOf('debugger') !== -1) {
            args[i] = args[i].replace(/\\bdebugger\\b/g, '/*debugger*/');
          }
        }
        return OrigFunction.apply(this, args);
      };
      SafeFunction.prototype = OrigFunction.prototype;
      OrigFunction.prototype.constructor = SafeFunction;
      window.Function = SafeFunction;
    } catch (e) {}
  }

  // 4. Spoof document.URL / documentURI / baseURI / Location
  var parsedOriginUrl = new URL(VFS_PAGE_URL);
  window.__VFS_LOCATION__ = {
    href: parsedOriginUrl.href,
    origin: parsedOriginUrl.origin,
    protocol: parsedOriginUrl.protocol,
    host: parsedOriginUrl.host,
    hostname: parsedOriginUrl.hostname,
    port: parsedOriginUrl.port,
    pathname: parsedOriginUrl.pathname,
    search: parsedOriginUrl.search,
    hash: parsedOriginUrl.hash,
    assign: function() {},
    replace: function() {},
    reload: function() { window.location.reload(); },
    toString: function() { return parsedOriginUrl.href; }
  };

  if (SPOOF_ORIGIN) {
    try {
      Object.defineProperty(document, 'URL', { get: function() { return VFS_PAGE_URL; }, configurable: true });
      Object.defineProperty(document, 'documentURI', { get: function() { return VFS_PAGE_URL; }, configurable: true });
      Object.defineProperty(document, 'baseURI', { get: function() { return VFS_BASE_URL; }, configurable: true });
      Object.defineProperty(document, 'referrer', { get: function() { return VFS_ORIGIN + '/'; }, configurable: true });
    } catch (e) {}
  }

  // 5. In-Memory & LocalStorage-backed Cookie & Storage Shim
  try {
    var _vfsCookies = {};
    try {
      var stored = localStorage.getItem('__vfs_cookies__');
      if (stored) _vfsCookies = JSON.parse(stored);
    } catch (e) {}

    Object.defineProperty(document, 'cookie', {
      get: function() {
        var pairs = [];
        for (var k in _vfsCookies) {
          if (Object.prototype.hasOwnProperty.call(_vfsCookies, k)) {
            pairs.push(k + '=' + _vfsCookies[k]);
          }
        }
        return pairs.join('; ');
      },
      set: function(val) {
        if (typeof val !== 'string') return;
        var parts = val.split(';');
        var first = (parts[0] || '').trim();
        var eqIdx = first.indexOf('=');
        if (eqIdx !== -1) {
          var key = first.substring(0, eqIdx).trim();
          var valStr = first.substring(eqIdx + 1).trim();
          if (val.indexOf('max-age=0') !== -1 || val.indexOf('expires=Thu, 01 Jan 1970') !== -1) {
            delete _vfsCookies[key];
          } else {
            _vfsCookies[key] = valStr;
          }
          try {
            localStorage.setItem('__vfs_cookies__', JSON.stringify(_vfsCookies));
          } catch (e) {}
        }
      },
      configurable: true
    });

    try {
      Object.defineProperty(navigator, 'cookieEnabled', {
        get: function() { return true; },
        configurable: true
      });
    } catch (e) {}
  } catch (e) {}

  // Suppress Unity's and Emscripten's file:// and cookie warning popups
  var origAlert = window.alert;
  window.alert = function(msg) {
    if (typeof msg === 'string' && (msg.indexOf('file://') !== -1 || msg.indexOf('cookie') !== -1)) {
      console.log('[UnityPack VFS] Suppressed warning alert:', msg);
      return;
    }
    if (origAlert) return origAlert.apply(window, arguments);
  };

  // 6. Multi-Key VFS Index
  var byExactUrl = Object.create(null);
  var byRelPath = Object.create(null);
  var byOriginPath = Object.create(null);
  var byFileName = Object.create(null);

  for (var i = 0; i < VFS_MANIFEST.length; i++) {
    var entry = VFS_MANIFEST[i];
    byExactUrl[entry.url] = entry;
    byExactUrl[entry.url.toLowerCase()] = entry;
    byRelPath[entry.relPath] = entry;
    byRelPath[entry.relPath.toLowerCase()] = entry;
    byOriginPath[entry.originPath] = entry;
    byOriginPath[entry.originPath.toLowerCase()] = entry;
    byFileName[entry.fileName] = entry;
    byFileName[entry.fileName.toLowerCase()] = entry;
  }

  var realDocHref = window.location.href.split('?')[0].split('#')[0];
  var realDocDir = realDocHref.substring(0, realDocHref.lastIndexOf('/') + 1);

  function resolveVfsAsset(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    if (rawUrl.indexOf('blob:') === 0 || rawUrl.indexOf('data:') === 0) return null;

    var clean = rawUrl.split('?')[0].split('#')[0].trim();
    if (!clean) return null;

    var hit = byExactUrl[clean] || byExactUrl[clean.toLowerCase()] ||
              byRelPath[clean] || byRelPath[clean.toLowerCase()] ||
              byOriginPath[clean] || byOriginPath[clean.toLowerCase()];
    if (hit) return hit;

    if (realDocDir && clean.indexOf(realDocDir) === 0) {
      var stripped = clean.substring(realDocDir.length).replace(/^\\/+/, '');
      hit = byRelPath[stripped] || byRelPath[stripped.toLowerCase()];
      if (hit) return hit;
    }

    try {
      var resolvedHref = new URL(clean, VFS_BASE_URL).href;
      hit = byExactUrl[resolvedHref] || byExactUrl[resolvedHref.toLowerCase()];
      if (hit) return hit;
    } catch (e) {}

    var lowerClean = clean.toLowerCase();
    for (var j = 0; j < VFS_MANIFEST.length; j++) {
      var candidate = VFS_MANIFEST[j];
      if (
        lowerClean.endsWith('/' + candidate.relPath.toLowerCase()) ||
        lowerClean.endsWith(candidate.originPath.toLowerCase())
      ) {
        return candidate;
      }
    }

    var lastSlash = clean.lastIndexOf('/');
    var fname = lastSlash !== -1 ? clean.substring(lastSlash + 1) : clean;
    if (fname && (byFileName[fname] || byFileName[fname.toLowerCase()])) {
      return byFileName[fname] || byFileName[fname.toLowerCase()];
    }

    return null;
  }

  function getAssetBytes(entry) {
    if (entry.bytes) return entry.bytes;
    var el = document.getElementById(entry.id);
    if (!el) return new Uint8Array(0);
    var b64 = el.textContent || '';
    var binStr = atob(b64);
    var len = binStr.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      bytes[i] = binStr.charCodeAt(i);
    }
    var comp = (entry && entry.compressed) || (el && el.getAttribute('data-compressed'));
    if (comp === 'gzip' || (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      if (typeof fflate !== 'undefined' && fflate.gunzipSync) {
        try {
          bytes = fflate.gunzipSync(bytes);
        } catch (err) {
          console.error('[UnityPack VFS] gunzip failed:', err);
        }
      }
    }
    entry.bytes = bytes;
    el.textContent = '';
    if (el.parentNode) el.parentNode.removeChild(el);
    return bytes;
  }

  function getAssetBlobUrl(entry) {
    if (entry.blobUrl) return entry.blobUrl;
    var bytes = getAssetBytes(entry);
    var blob = new Blob([bytes], { type: entry.mime || 'application/octet-stream' });
    entry.blobUrl = URL.createObjectURL(blob);
    return entry.blobUrl;
  }

  // Safe IndexedDB Shim for file://
  try {
    var idb = window.indexedDB;
    if (idb) {
      var origOpen = idb.open.bind(idb);
      idb.open = function(name, version) {
        try {
          return origOpen(name, version);
        } catch (err) {
          var fakeReq = { result: null, error: err, onerror: null, onsuccess: null, onupgradeneeded: null };
          setTimeout(function() {
            if (typeof fakeReq.onerror === 'function') {
              fakeReq.onerror({ target: fakeReq, preventDefault: function() {} });
            }
          }, 0);
          return fakeReq;
        }
      };
    }
  } catch (e) {}

  // Spec-Compliant XMLHttpRequest Interceptor
  var NativeXHR = window.XMLHttpRequest;

  function VfsXMLHttpRequest() {
    this._native = new NativeXHR();
    this._listeners = Object.create(null);
    this._vfsEntry = null;
    this._method = 'GET';
    this._requestUrl = '';
    this._async = true;
    this._aborted = false;

    this.readyState = 0;
    this.status = 0;
    this.statusText = '';
    this.responseType = '';
    this.response = null;
    this.responseText = '';
    this.responseURL = '';
    this.timeout = 0;
    this.withCredentials = false;
    this.upload = {};

    this.onreadystatechange = null;
    this.onloadstart = null;
    this.onprogress = null;
    this.onload = null;
    this.onerror = null;
    this.onabort = null;
    this.ontimeout = null;
    this.onloadend = null;
  }

  VfsXMLHttpRequest.UNSENT = 0;
  VfsXMLHttpRequest.OPENED = 1;
  VfsXMLHttpRequest.HEADERS_RECEIVED = 2;
  VfsXMLHttpRequest.LOADING = 3;
  VfsXMLHttpRequest.DONE = 4;

  VfsXMLHttpRequest.prototype.UNSENT = 0;
  VfsXMLHttpRequest.prototype.OPENED = 1;
  VfsXMLHttpRequest.prototype.HEADERS_RECEIVED = 2;
  VfsXMLHttpRequest.prototype.LOADING = 3;
  VfsXMLHttpRequest.prototype.DONE = 4;

  VfsXMLHttpRequest.prototype.addEventListener = function(type, listener) {
    if (!listener) return;
    if (!this._listeners[type]) this._listeners[type] = [];
    if (this._listeners[type].indexOf(listener) === -1) {
      this._listeners[type].push(listener);
    }
  };

  VfsXMLHttpRequest.prototype.removeEventListener = function(type, listener) {
    if (!this._listeners[type]) return;
    var idx = this._listeners[type].indexOf(listener);
    if (idx !== -1) this._listeners[type].splice(idx, 1);
  };

  VfsXMLHttpRequest.prototype.dispatchEvent = function(evt) {
    var type = evt.type;
    try {
      Object.defineProperty(evt, 'target', { value: this, configurable: true });
      Object.defineProperty(evt, 'currentTarget', { value: this, configurable: true });
    } catch (e) {}

    var propHandler = this['on' + type];
    if (typeof propHandler === 'function') {
      try {
        propHandler.call(this, evt);
      } catch (err) {
        console.error('[UnityPack VFS] XHR on' + type + ' error:', err);
      }
    }
    var list = this._listeners[type];
    if (list && list.length) {
      var copy = list.slice();
      for (var i = 0; i < copy.length; i++) {
        try {
          if (typeof copy[i] === 'function') {
            copy[i].call(this, evt);
          } else if (copy[i] && typeof copy[i].handleEvent === 'function') {
            copy[i].handleEvent(evt);
          }
        } catch (err) {
          console.error('[UnityPack VFS] XHR listener ' + type + ' error:', err);
        }
      }
    }
    return true;
  };

  VfsXMLHttpRequest.prototype.open = function(method, url, async) {
    this._method = (method || 'GET').toUpperCase();
    this._requestUrl = String(url || '');
    this._async = async !== false;
    this._aborted = false;
    this._vfsEntry = resolveVfsAsset(this._requestUrl);
    this.readyState = 1;
    this.dispatchEvent(new Event('readystatechange'));
  };

  VfsXMLHttpRequest.prototype.setRequestHeader = function() {};
  VfsXMLHttpRequest.prototype.overrideMimeType = function(mime) { this._overrideMime = mime; };

  VfsXMLHttpRequest.prototype.getResponseHeader = function(name) {
    if (!name) return null;
    var lower = name.toLowerCase();
    var mime = (this._vfsEntry && this._vfsEntry.mime) || 'application/octet-stream';
    var size = (this._vfsEntry && this._vfsEntry.size) || 0;
    if (lower === 'content-type') return mime;
    if (lower === 'content-length') return String(size);
    if (lower === 'last-modified') return 'Mon, 02 Mar 2026 05:17:33 GMT';
    if (lower === 'etag') return '"vfs-' + (this._vfsEntry ? this._vfsEntry.id : '0') + '"';
    if (lower === 'access-control-allow-origin') return '*';
    return null;
  };

  VfsXMLHttpRequest.prototype.getAllResponseHeaders = function() {
    var mime = (this._vfsEntry && this._vfsEntry.mime) || 'application/octet-stream';
    var size = (this._vfsEntry && this._vfsEntry.size) || 0;
    return 'content-type: ' + mime + '\\r\\ncontent-length: ' + size + '\\r\\naccess-control-allow-origin: *\\r\\n';
  };

  VfsXMLHttpRequest.prototype.abort = function() {
    this._aborted = true;
    this.readyState = 0;
    this.dispatchEvent(new ProgressEvent('abort'));
  };

  VfsXMLHttpRequest.prototype.send = function(body) {
    var self = this;

    if (this._vfsEntry) {
      var entry = this._vfsEntry;
      var deliver = function() {
        if (self._aborted) return;
        var bytes = getAssetBytes(entry);
        var total = bytes.byteLength;

        self.status = 200;
        self.statusText = 'OK';
        self.responseURL = entry.url;

        self.readyState = 2;
        self.dispatchEvent(new Event('readystatechange'));

        self.readyState = 3;
        self.dispatchEvent(new Event('readystatechange'));
        self.dispatchEvent(new ProgressEvent('progress', { lengthComputable: true, loaded: total, total: total }));

        var rType = (self.responseType || '').toLowerCase();
        if (self._method === 'HEAD') {
          self.response = null;
          self.responseText = '';
        } else if (rType === 'arraybuffer') {
          self.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        } else if (rType === 'blob') {
          self.response = new Blob([bytes], { type: entry.mime || 'application/octet-stream' });
        } else if (rType === 'json') {
          try {
            self.response = JSON.parse(new TextDecoder('utf-8').decode(bytes));
          } catch (e) {
            self.response = null;
          }
        } else {
          var text = new TextDecoder('utf-8').decode(bytes);
          self.response = text;
          self.responseText = text;
        }

        self.readyState = 4;
        self.dispatchEvent(new Event('readystatechange'));
        self.dispatchEvent(new ProgressEvent('load', { lengthComputable: true, loaded: total, total: total }));
        self.dispatchEvent(new ProgressEvent('loadend', { lengthComputable: true, loaded: total, total: total }));
      };

      if (this._async) {
        setTimeout(deliver, 0);
      } else {
        deliver();
      }
      return;
    }

    if (window.location.protocol === 'file:' && !/^https?:\\/\\//i.test(this._requestUrl)) {
      setTimeout(function() {
        if (self._aborted) return;
        self.status = 404;
        self.statusText = 'Not Found in VFS';
        self.readyState = 4;
        self.dispatchEvent(new Event('readystatechange'));
        self.dispatchEvent(new ProgressEvent('error'));
        self.dispatchEvent(new ProgressEvent('loadend'));
      }, 0);
      return;
    }

    // External live request handling with automatic transparent CORS proxy fallback
    var CORS_PROXIES = [
      function(u) { return 'https://corsproxy.io/?' + encodeURIComponent(u); },
      function(u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); }
    ];

    try {
      var nat = this._native;
      nat.open(this._method, this._requestUrl, this._async);
      if (this.responseType) nat.responseType = this.responseType;
      nat.onload = function() {
        self.status = nat.status || 200;
        self.statusText = nat.statusText || 'OK';
        self.response = nat.response;
        if (!self.responseType || self.responseType === 'text') {
          try { self.responseText = nat.responseText; } catch (e) {}
        }
        self.readyState = 4;
        self.dispatchEvent(new Event('readystatechange'));
        self.dispatchEvent(new ProgressEvent('load'));
        self.dispatchEvent(new ProgressEvent('loadend'));
      };
      nat.onerror = function() {
        if (/^https?:\/\//i.test(self._requestUrl)) {
          try {
            var proxyNat = new NativeXHR();
            var pUrl = CORS_PROXIES[0](self._requestUrl);
            proxyNat.open(self._method, pUrl, self._async);
            if (self.responseType) proxyNat.responseType = self.responseType;
            proxyNat.onload = function() {
              self.status = proxyNat.status || 200;
              self.statusText = proxyNat.statusText || 'OK';
              self.response = proxyNat.response;
              if (!self.responseType || self.responseType === 'text') {
                try { self.responseText = proxyNat.responseText; } catch (e) {}
              }
              self.readyState = 4;
              self.dispatchEvent(new Event('readystatechange'));
              self.dispatchEvent(new ProgressEvent('load'));
              self.dispatchEvent(new ProgressEvent('loadend'));
            };
            proxyNat.onerror = function() {
              self.status = 0;
              self.readyState = 4;
              self.dispatchEvent(new Event('readystatechange'));
              self.dispatchEvent(new ProgressEvent('error'));
              self.dispatchEvent(new ProgressEvent('loadend'));
            };
            proxyNat.send(body);
            return;
          } catch (pe) {}
        }
        self.status = 0;
        self.readyState = 4;
        self.dispatchEvent(new Event('readystatechange'));
        self.dispatchEvent(new ProgressEvent('error'));
        self.dispatchEvent(new ProgressEvent('loadend'));
      };
      nat.send(body);
    } catch (err) {
      if (/^https?:\/\//i.test(this._requestUrl)) {
        try {
          var proxyNat2 = new NativeXHR();
          var pUrl2 = CORS_PROXIES[0](this._requestUrl);
          proxyNat2.open(this._method, pUrl2, this._async);
          if (this.responseType) proxyNat2.responseType = this.responseType;
          proxyNat2.onload = function() {
            self.status = proxyNat2.status || 200;
            self.statusText = proxyNat2.statusText || 'OK';
            self.response = proxyNat2.response;
            if (!self.responseType || self.responseType === 'text') {
              try { self.responseText = proxyNat2.responseText; } catch (e) {}
            }
            self.readyState = 4;
            self.dispatchEvent(new Event('readystatechange'));
            self.dispatchEvent(new ProgressEvent('load'));
            self.dispatchEvent(new ProgressEvent('loadend'));
          };
          proxyNat2.onerror = function() {
            self.status = 0;
            self.readyState = 4;
            self.dispatchEvent(new Event('readystatechange'));
            self.dispatchEvent(new ProgressEvent('error'));
          };
          proxyNat2.send(body);
          return;
        } catch (e2) {}
      }
      setTimeout(function() {
        self.status = 0;
        self.readyState = 4;
        self.dispatchEvent(new Event('readystatechange'));
        self.dispatchEvent(new ProgressEvent('error'));
      }, 0);
    }
  };

  window.XMLHttpRequest = VfsXMLHttpRequest;

  // Window.fetch Interceptor with live transparent CORS proxy fallback
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function(input, init) {
    var rawUrl = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input);
    var entry = resolveVfsAsset(rawUrl);
    if (entry) {
      var bytes = getAssetBytes(entry);
      var slice = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      var resp = new Response(slice, {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': entry.mime || 'application/octet-stream',
          'Content-Length': String(bytes.byteLength),
          'Access-Control-Allow-Origin': '*'
        }
      });
      try {
        Object.defineProperty(resp, 'url', { value: entry.url });
      } catch (e) {}
      return Promise.resolve(resp);
    }
    if (origFetch) {
      return origFetch(input, init).catch(function(err) {
        if (/^https?:\/\//i.test(rawUrl)) {
          var proxiedUrl = 'https://corsproxy.io/?' + encodeURIComponent(rawUrl);
          return origFetch(proxiedUrl, init);
        }
        throw err;
      });
    }
    return Promise.reject(new Error('VFS asset not found: ' + rawUrl));
  };

  // WebAssembly streaming interceptor
  if (typeof WebAssembly !== 'undefined') {
    WebAssembly.instantiateStreaming = async function(source, importObject) {
      var resp = await source;
      var buf = await resp.arrayBuffer();
      return WebAssembly.instantiate(buf, importObject);
    };
    WebAssembly.compileStreaming = async function(source) {
      var resp = await source;
      var buf = await resp.arrayBuffer();
      return WebAssembly.compile(buf);
    };
  }

  // Dynamic Element .src and Audio/Worker Interceptors
  function patchElementSrcProp(Proto, propName) {
    if (!Proto) return;
    var desc = Object.getOwnPropertyDescriptor(Proto, propName);
    if (!desc || !desc.set) return;
    Object.defineProperty(Proto, propName, {
      get: function() { return desc.get.call(this); },
      set: function(val) {
        var entry = resolveVfsAsset(String(val));
        if (entry) return desc.set.call(this, getAssetBlobUrl(entry));
        return desc.set.call(this, val);
      },
      configurable: true,
      enumerable: true
    });
  }

  patchElementSrcProp(window.HTMLScriptElement && HTMLScriptElement.prototype, 'src');
  patchElementSrcProp(window.HTMLImageElement && HTMLImageElement.prototype, 'src');
  patchElementSrcProp(window.HTMLMediaElement && HTMLMediaElement.prototype, 'src');
  patchElementSrcProp(window.HTMLSourceElement && HTMLSourceElement.prototype, 'src');

  if (window.Audio) {
    var OrigAudio = window.Audio;
    window.Audio = function(src) {
      if (src) {
        var entry = resolveVfsAsset(String(src));
        if (entry) return new OrigAudio(getAssetBlobUrl(entry));
      }
      return new OrigAudio(src);
    };
    window.Audio.prototype = OrigAudio.prototype;
  }

  // Phaser & Web Audio Unlocker on first user gesture
  var AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (AudioCtx) {
    var unlockAudio = function() {
      var ctx = new AudioCtx();
      if (ctx.state === 'suspended') {
        ctx.resume().catch(function() {});
      }
      window.removeEventListener('click', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
    window.addEventListener('click', unlockAudio, { once: true, passive: true });
    window.addEventListener('keydown', unlockAudio, { once: true, passive: true });
    window.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
  }

  // Worker Hook for Construct 3 & WebAssembly Threads
  if (window.Worker) {
    var OrigWorker = window.Worker;
    window.Worker = function(scriptURL, options) {
      var entry = resolveVfsAsset(String(scriptURL));
      if (entry) return new OrigWorker(getAssetBlobUrl(entry), options);
      return new OrigWorker(scriptURL, options);
    };
    window.Worker.prototype = OrigWorker.prototype;
  }
})();
</script>`;

  // Replace stylesheets and scripts with inlined versions
  let packedHtml = htmlText;
  for (const [fullTag, replacement] of inlinedStylesMap.entries()) {
    packedHtml = packedHtml.replace(fullTag, () => replacement);
  }
  for (const [fullTag, replacement] of inlinedScriptsMap.entries()) {
    packedHtml = packedHtml.replace(fullTag, () => replacement);
  }

  // Replace HTML images & media with inline data URIs
  for (const [mediaPath, dataUri] of mediaReplacements.entries()) {
    packedHtml = packedHtml.split(`src="${mediaPath}"`).join(`src="${dataUri}"`);
    packedHtml = packedHtml.split(`src='${mediaPath}'`).join(`src='${dataUri}'`);
    packedHtml = packedHtml.split(`href="${mediaPath}"`).join(`href="${dataUri}"`);
  }

  if (/<title>\s*<\/title>/i.test(packedHtml)) {
    packedHtml = packedHtml.replace(/<title>\s*<\/title>/i, `<title>${finalTitle}</title>`);
  }

  const offlineHudHtml = options.includeOfflineHud
    ? `<style>
#__upack_hud { position: fixed; top: 10px; right: 10px; z-index: 2147483647; display: flex; gap: 6px; font-family: system-ui, sans-serif; opacity: 0.25; transition: opacity 0.15s ease; }
#__upack_hud:hover { opacity: 1; }
#__upack_hud button { background: rgba(15, 23, 42, 0.85); color: #f8fafc; border: 1px solid rgba(255,255,255,0.18); border-radius: 6px; padding: 5px 10px; font-size: 11px; font-weight: 600; cursor: pointer; backdrop-filter: blur(6px); }
#__upack_hud button:hover { background: rgba(14, 165, 233, 0.9); border-color: rgba(56, 189, 248, 0.6); }
</style>
<div id="__upack_hud">
  <button onclick="if(!document.fullscreenElement){document.documentElement.requestFullscreen().catch(function(){});}else{document.exitFullscreen().catch(function(){});}">Fullscreen</button>
</div>`
    : '';

  const headInjection = `\n<!-- UnityPack Studio Offline VFS Bundle -->\n${vfsChunksHtml}\n${decompressorScript}${vfsBootstrapScript}\n`;
  if (/<head\b[^>]*>/i.test(packedHtml)) {
    packedHtml = packedHtml.replace(/<head\b[^>]*>/i, (match) => `${match}${headInjection}`);
  } else {
    packedHtml = `${headInjection}\n${packedHtml}`;
  }

  if (offlineHudHtml) {
    if (/<\/body>/i.test(packedHtml)) {
      packedHtml = packedHtml.replace(/<\/body>/i, `${offlineHudHtml}\n</body>`);
    } else {
      packedHtml += `\n${offlineHudHtml}`;
    }
  }

  const assetsList: PackedAssetInfo[] = Array.from(assetMap.values()).map((a) => ({
    id: a.id,
    url: a.url,
    relPath: a.relPath,
    originPath: a.originPath,
    fileName: a.fileName,
    mime: a.mime,
    size: a.buffer.length,
    category: a.category,
    source: a.source,
    status: a.status,
    inlined: a.inlined,
  }));

  const totalBytes = assetsList.reduce((acc, item) => acc + item.size, 0);
  const htmlBytes = Buffer.byteLength(packedHtml, 'utf8');
  const durationMs = Date.now() - startTime;

  const safeSlug = finalTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'web-game';

  onProgress?.({
    stage: 'done',
    message: `Packed ${assetsList.length} assets (${(totalBytes / (1024 * 1024)).toFixed(2)} MB) into single offline HTML in ${(durationMs / 1000).toFixed(1)}s`,
    progress: 100,
  });

  return {
    bundleId,
    targetUrl: options.targetUrl,
    finalUrl,
    baseDirUrl,
    originUrl,
    title: finalTitle,
    engineVersion,
    companyName,
    productName,
    totalBytes,
    htmlBytes,
    durationMs,
    assets: assetsList,
    internalDataFiles,
    detectedSitelocks: Array.from(detectedSitelocks),
    il2cppLiteralsFound: Array.from(il2cppLiteralsFound),
    fileNameDownload: `${safeSlug}-offline.html`,
    htmlContent: packedHtml,
  };
}
