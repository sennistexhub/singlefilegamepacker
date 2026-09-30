import * as fflate from 'fflate';

export interface LocalFolderFile {
  path: string; // e.g. "Build/game.wasm.unityweb" or "index.html"
  name: string;
  size: number;
  type: string;
  data: Uint8Array;
}

export function extractZipFiles(zipBuffer: Uint8Array): LocalFolderFile[] {
  const unzipped = fflate.unzipSync(zipBuffer);
  const results: LocalFolderFile[] = [];
  for (const [relativePath, data] of Object.entries(unzipped)) {
    if (relativePath.endsWith('/') || (data && data.length === 0)) continue;
    const name = relativePath.split('/').pop() || relativePath;
    results.push({
      path: relativePath,
      name,
      size: data.length,
      type: guessMimeType(relativePath),
      data,
    });
  }
  return results;
}

export interface FolderPackProgress {
  stage: string;
  message: string;
  progress: number;
  fileName?: string;
  bytesLoaded?: number;
}

export interface FolderPackResult {
  bundleId: string;
  title: string;
  engineVersion: string;
  entryHtmlPath: string;
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

function guessMimeType(filePath: string, defaultType?: string): string {
  const clean = filePath.split('?')[0].split('#')[0].toLowerCase();
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
  if (clean.endsWith('.html') || clean.endsWith('.htm')) return 'text/html';
  if (clean.endsWith('.txt') || clean.endsWith('.csv')) return 'text/plain';
  if (clean.endsWith('.xml')) return 'application/xml';
  return defaultType || 'application/octet-stream';
}

function categorizeAsset(path: string): 'unity-core' | 'wasm-emscripten' | 'script' | 'style' | 'deep-scan' | 'media' | 'config' {
  const lower = path.toLowerCase();
  if (lower.includes('.unityweb') || lower.includes('unityloader') || lower.includes('.loader.js') || lower.includes('.framework.js')) {
    return 'unity-core';
  }
  if (lower.endsWith('.wasm') || lower.endsWith('.data') || lower.includes('.data.') || lower.endsWith('.pck') || lower.endsWith('.mem') || lower.includes('emscripten')) {
    return 'wasm-emscripten';
  }
  if (lower.endsWith('.json') || lower.endsWith('.xml')) return 'config';
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'script';
  if (lower.endsWith('.css')) return 'style';
  return 'media';
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, len));
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(binary);
}

function resolveRelative(baseFile: string, relativePath: string): string {
  const baseParts = baseFile.split('/').slice(0, -1);
  const relParts = relativePath.split('/');
  for (const part of relParts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      baseParts.pop();
    } else {
      baseParts.push(part);
    }
  }
  return baseParts.join('/');
}

export async function packLocalFolder(
  files: LocalFolderFile[],
  entryPath = 'index.html',
  options: {
    spoofOrigin?: boolean;
    stripAntiDebug?: boolean;
    disableUnityCache?: boolean;
    includeOfflineHud?: boolean;
    compressLargeChunks?: boolean;
  } = {},
  onProgress?: (p: FolderPackProgress) => void
): Promise<FolderPackResult> {
  const startTime = Date.now();
  const bundleId = crypto.randomUUID ? crypto.randomUUID() : 'bundle-' + Date.now();

  onProgress?.({ stage: 'indexing', message: `Analyzing ${files.length} folder assets...`, progress: 10 });

  // Map files by normalized relative path (no leading slashes)
  const fileMap = new Map<string, LocalFolderFile>();
  for (const f of files) {
    const norm = f.path.replace(/^\.?\/+/, '').replace(/\\/g, '/');
    fileMap.set(norm, { ...f, path: norm });
  }

  // Determine entry HTML file
  let entryFile = fileMap.get(entryPath.replace(/^\.?\/+/, '').replace(/\\/g, '/'));
  if (!entryFile) {
    const htmlKey = Array.from(fileMap.keys()).find((k) => k.toLowerCase().endsWith('index.html')) ||
                    Array.from(fileMap.keys()).find((k) => k.toLowerCase().endsWith('.html'));
    if (htmlKey) {
      entryFile = fileMap.get(htmlKey);
    }
  }

  if (!entryFile) {
    throw new Error('Could not find an entry HTML file (index.html) in the selected folder.');
  }

  const decoder = new TextDecoder('utf-8');
  let htmlText = decoder.decode(entryFile.data);

  // Extract Game/Site Title
  const titleMatch = htmlText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const gameTitle = titleMatch ? titleMatch[1].trim() : entryFile.path.split('/')[0] || 'Offline Web Game';

  // Detect Engine
  let engineVersion = 'HTML5 / WebAssembly';
  if (htmlText.includes('UnityLoader') || htmlText.includes('createUnityInstance') || Array.from(fileMap.keys()).some(k => k.includes('.unityweb'))) {
    engineVersion = 'Unity WebGL';
  } else if (htmlText.includes('ENVIRONMENT_IS_PTHREAD') || htmlText.includes('wasmBinary') || htmlText.includes('rblx') || Array.from(fileMap.keys()).some(k => k.endsWith('.wasm'))) {
    engineVersion = 'Emscripten / WebAssembly';
  } else if (Array.from(fileMap.keys()).some(k => k.endsWith('.pck'))) {
    engineVersion = 'Godot Engine';
  }

  onProgress?.({ stage: 'stylesheets', message: 'Inlining CSS styles and embedding font glyphs...', progress: 30 });

  // 1. Process Stylesheets and inline url(...) assets
  const inlinedStylesMap = new Map<string, string>();
  const linkRegex = /<link\b[^>]*>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRegex.exec(htmlText)) !== null) {
    const tag = linkMatch[0];
    if (/rel=["']?stylesheet["']?/i.test(tag)) {
      const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
      if (hrefMatch && hrefMatch[1]) {
        const rawHref = hrefMatch[1].trim();
        const normHref = resolveRelative(entryFile.path, rawHref);
        const cssFile = fileMap.get(normHref);
        if (cssFile) {
          let cssText = decoder.decode(cssFile.data);
          const cssUrlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
          let m: RegExpExecArray | null;
          while ((m = cssUrlRegex.exec(cssText)) !== null) {
            const rawSub = m[2].trim();
            if (rawSub.startsWith('data:') || rawSub.startsWith('blob:') || rawSub.startsWith('#')) continue;
            const subNorm = resolveRelative(normHref, rawSub);
            const subFile = fileMap.get(subNorm);
            if (subFile) {
              const mime = guessMimeType(subNorm, subFile.type);
              const b64 = uint8ToBase64(subFile.data);
              cssText = cssText.split(rawSub).join(`data:${mime};base64,${b64}`);
            }
          }
          inlinedStylesMap.set(tag, `<style data-source="${rawHref}">\n${cssText}\n</style>`);
        }
      }
    }
  }

  onProgress?.({ stage: 'media', message: 'Embedding media elements and images into data URIs...', progress: 50 });

  // 2. Replace HTML images & media with inline data URIs
  const mediaRegex = /<(?:img|audio|video|source|input|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  let mediaMatch: RegExpExecArray | null;
  const mediaReplacements = new Map<string, string>();
  while ((mediaMatch = mediaRegex.exec(htmlText)) !== null) {
    const rawSrc = mediaMatch[1].trim();
    if (rawSrc.startsWith('data:') || rawSrc.startsWith('blob:') || rawSrc.startsWith('#') || rawSrc.startsWith('http://') || rawSrc.startsWith('https://')) continue;
    const normMedia = resolveRelative(entryFile.path, rawSrc);
    const mFile = fileMap.get(normMedia);
    if (mFile && (normMedia.match(/\.(png|jpg|jpeg|webp|gif|svg|ico|mp3|ogg|wav)$/i) || mFile.type.startsWith('image/') || mFile.type.startsWith('audio/'))) {
      const mime = guessMimeType(normMedia, mFile.type);
      const b64 = uint8ToBase64(mFile.data);
      const dataUri = `data:${mime};base64,${b64}`;
      mediaReplacements.set(rawSrc, dataUri);
    }
  }

  // 3. Prepare VFS Records for all remaining files
  onProgress?.({ stage: 'vfs', message: 'Packing game binaries & data packages into Virtual File System...', progress: 70 });

  interface VfsEntry {
    id: string;
    path: string;
    fileName: string;
    mime: string;
    size: number;
    buffer: Uint8Array;
    category: 'unity-core' | 'wasm-emscripten' | 'script' | 'style' | 'deep-scan' | 'media' | 'config';
    compressed: 'gzip' | 'none';
  }

  const vfsEntries: VfsEntry[] = [];
  let chunkCounter = 0;

  for (const [normPath, file] of fileMap.entries()) {
    if (normPath === entryFile.path) continue; // Skip entry HTML itself

    const fileName = normPath.split('/').pop() || normPath;
    const mime = guessMimeType(normPath, file.type);
    const category = categorizeAsset(normPath);

    let compressed: 'gzip' | 'none' = 'none';
    let finalBuffer = file.data;

    // Compress large WebBlox or data chunks if requested
    const shouldCompress = options.compressLargeChunks && (normPath.includes('.data') || normPath.includes('rblx') || normPath.endsWith('.wasm')) && file.data.length > 5 * 1024 * 1024;
    if (shouldCompress) {
      try {
        finalBuffer = fflate.gzipSync(file.data);
        compressed = 'gzip';
      } catch {
        finalBuffer = file.data;
        compressed = 'none';
      }
    }

    vfsEntries.push({
      id: `__vfs_chunk_${chunkCounter++}`,
      path: normPath,
      fileName,
      mime,
      size: file.data.length,
      buffer: finalBuffer,
      category,
      compressed,
    });
  }

  // 4. Render VFS chunks and JSON manifest
  onProgress?.({ stage: 'compiling', message: 'Constructing standalone single-file offline HTML...', progress: 88 });

  const vfsChunksHtml = vfsEntries
    .map((rec) => {
      const b64 = uint8ToBase64(rec.buffer);
      return `<script type="text/plain" id="${rec.id}" data-size="${rec.size}" data-mime="${rec.mime}" data-compressed="${rec.compressed}">${b64}</script>`;
    })
    .join('\n');

  const vfsManifestJson = JSON.stringify(
    vfsEntries.map((rec) => ({
      id: rec.id,
      url: 'https://localhost/' + rec.path,
      relPath: rec.path,
      originPath: '/' + rec.path,
      fileName: rec.fileName,
      mime: rec.mime,
      size: rec.size,
      compressed: rec.compressed,
    }))
  );

  const hasCompressedChunks = vfsEntries.some((e) => e.compressed === 'gzip');

  const vfsBootstrapScript = `<script data-vfs-runtime="unitypack-folder-v1">
(function() {
  var VFS_PAGE_URL = "https://localhost/" + ${JSON.stringify(entryFile.path)};
  var VFS_BASE_URL = "https://localhost/";
  var VFS_ORIGIN = "https://localhost";
  var SPOOF_ORIGIN = ${JSON.stringify(options.spoofOrigin ?? true)};
  var STRIP_ANTI_DEBUG = ${JSON.stringify(options.stripAntiDebug ?? true)};
  var VFS_MANIFEST = ${vfsManifestJson};

  // Ad SDK Shims
  window.PokiSDK = window.PokiSDK || { init: function() { return Promise.resolve(); }, commercialBreak: function() { return Promise.resolve(); }, rewardedBreak: function() { return Promise.resolve(true); }, gameplayStart: function() {}, gameplayStop: function() {}, happyTime: function() {}, gameLoadingStart: function() {}, gameLoadingProgress: function() {}, gameLoadingFinished: function() {}, setDebug: function() {}, measure: function() {}, destroyAd: function() {}, getLeaderboard: function() { return Promise.resolve([]); }, shareableURL: function() { return Promise.resolve(window.location.href); }, getPayload: function() { return Promise.resolve(''); }, isAdBlocked: function() { return false; } };
  window.sdk = window.sdk || { showBanner: function() {}, init: function() { return Promise.resolve(); }, showAd: function() { return Promise.resolve(); } };
  window.CrazyGames = window.CrazyGames || { SDK: { init: function() { return Promise.resolve(); }, ad: { requestAd: function() { return Promise.resolve(); }, hasAdblock: function() { return Promise.resolve(false); } } } };
  window.CrazySDK = window.CrazySDK || window.CrazyGames.SDK;
  window.adsbygoogle = window.adsbygoogle || [];
  window.gamemonetize = window.gamemonetize || { init: function() { return Promise.resolve(); } };

  // Service Worker & crossOriginIsolated Guard
  try {
    if (typeof window.crossOriginIsolated === 'undefined') {
      Object.defineProperty(window, 'crossOriginIsolated', { get: function() { return true; }, configurable: true });
    }
  } catch (e) {}

  if (navigator.serviceWorker) {
    var dummyReg = { scope: '/', active: { state: 'activated' }, installing: null, waiting: null, update: function() { return Promise.resolve(); }, unregister: function() { return Promise.resolve(true); }, addEventListener: function() {}, removeEventListener: function() {} };
    navigator.serviceWorker.register = function() { return Promise.resolve(dummyReg); };
  }

  // Origin & URL Spoofing
  if (SPOOF_ORIGIN) {
    try {
      Object.defineProperty(document, 'URL', { get: function() { return VFS_PAGE_URL; }, configurable: true });
      Object.defineProperty(document, 'documentURI', { get: function() { return VFS_PAGE_URL; }, configurable: true });
      Object.defineProperty(document, 'baseURI', { get: function() { return VFS_BASE_URL; }, configurable: true });
      Object.defineProperty(document, 'referrer', { get: function() { return VFS_ORIGIN + '/'; }, configurable: true });
    } catch (e) {}
  }

  // Multi-key VFS Index
  var byRelPath = Object.create(null);
  var byExactUrl = Object.create(null);
  var byFileName = Object.create(null);

  for (var i = 0; i < VFS_MANIFEST.length; i++) {
    var entry = VFS_MANIFEST[i];
    byRelPath[entry.relPath] = entry;
    byRelPath[entry.relPath.toLowerCase()] = entry;
    byExactUrl[entry.url] = entry;
    byExactUrl[entry.url.toLowerCase()] = entry;
    byFileName[entry.fileName] = entry;
    byFileName[entry.fileName.toLowerCase()] = entry;
  }

  function resolveVfsAsset(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    if (rawUrl.indexOf('blob:') === 0 || rawUrl.indexOf('data:') === 0) return null;

    var clean = rawUrl.split('?')[0].split('#')[0].replace(/^\\/+/, '').trim();
    if (!clean) return null;

    var hit = byRelPath[clean] || byRelPath[clean.toLowerCase()] ||
              byExactUrl[clean] || byExactUrl[clean.toLowerCase()];
    if (hit) return hit;

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
          console.error('[VFS Folder] gunzip failed:', err);
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

  // Intercept XHR
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
  }
  VfsXMLHttpRequest.prototype.open = function(method, url, async) {
    this._method = (method || 'GET').toUpperCase();
    this._requestUrl = String(url || '');
    this._async = async !== false;
    this._vfsEntry = resolveVfsAsset(this._requestUrl);
    this.readyState = 1;
    if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
  };
  VfsXMLHttpRequest.prototype.setRequestHeader = function() {};
  VfsXMLHttpRequest.prototype.overrideMimeType = function(m) { this._overrideMime = m; };
  VfsXMLHttpRequest.prototype.getResponseHeader = function(name) {
    var lower = (name || '').toLowerCase();
    if (lower === 'content-type') return (this._vfsEntry && this._vfsEntry.mime) || 'application/octet-stream';
    if (lower === 'content-length') return String((this._vfsEntry && this._vfsEntry.size) || 0);
    return null;
  };
  VfsXMLHttpRequest.prototype.getAllResponseHeaders = function() {
    return 'content-type: ' + ((this._vfsEntry && this._vfsEntry.mime) || 'application/octet-stream') + '\\r\\n';
  };
  VfsXMLHttpRequest.prototype.send = function() {
    var self = this;
    if (this._vfsEntry) {
      var entry = this._vfsEntry;
      var deliver = function() {
        if (self._aborted) return;
        var bytes = getAssetBytes(entry);
        self.status = 200;
        self.statusText = 'OK';
        self.responseURL = entry.url;
        self.readyState = 4;
        var rType = (self.responseType || '').toLowerCase();
        if (rType === 'arraybuffer') {
          self.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        } else if (rType === 'blob') {
          self.response = new Blob([bytes], { type: entry.mime || 'application/octet-stream' });
        } else if (rType === 'json') {
          try { self.response = JSON.parse(new TextDecoder('utf-8').decode(bytes)); } catch(e) { self.response = null; }
        } else {
          var t = new TextDecoder('utf-8').decode(bytes);
          self.response = t;
          self.responseText = t;
        }
        if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
        if (typeof self.onload === 'function') self.onload();
        if (typeof self.onloadend === 'function') self.onloadend();
      };
      if (this._async) setTimeout(deliver, 0); else deliver();
      return;
    }
    // External live request handling with transparent CORS proxy fallback
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
        if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
        if (typeof self.onload === 'function') self.onload();
        if (typeof self.onloadend === 'function') self.onloadend();
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
              if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
              if (typeof self.onload === 'function') self.onload();
              if (typeof self.onloadend === 'function') self.onloadend();
            };
            proxyNat.onerror = function() {
              self.status = 0;
              self.readyState = 4;
              if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
              if (typeof self.onerror === 'function') self.onerror();
              if (typeof self.onloadend === 'function') self.onloadend();
            };
            proxyNat.send();
            return;
          } catch (pe) {}
        }
        self.status = 0;
        self.readyState = 4;
        if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
        if (typeof self.onerror === 'function') self.onerror();
        if (typeof self.onloadend === 'function') self.onloadend();
      };
      nat.send();
    } catch (err) {
      setTimeout(function() {
        self.status = 0;
        self.readyState = 4;
        if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
        if (typeof self.onerror === 'function') self.onerror();
      }, 0);
    }
  };
  window.XMLHttpRequest = VfsXMLHttpRequest;

  // Intercept Fetch with transparent CORS proxy fallback for live external APIs
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function(input, init) {
    var rawUrl = typeof input === 'string' ? input : (input && (input.url || input.href)) || String(input);
    var entry = resolveVfsAsset(rawUrl);
    if (entry) {
      var bytes = getAssetBytes(entry);
      var slice = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      return Promise.resolve(new Response(slice, {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': entry.mime || 'application/octet-stream',
          'Content-Length': String(bytes.byteLength),
          'Access-Control-Allow-Origin': '*'
        }
      }));
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

  if (window.Worker) {
    var OrigWorker = window.Worker;
    window.Worker = function(scriptURL, options) {
      var entry = resolveVfsAsset(String(scriptURL));
      if (entry) return new OrigWorker(getAssetBlobUrl(entry), options);
      return new OrigWorker(scriptURL, options);
    };
    window.Worker.prototype = OrigWorker.prototype;
  }

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

  // Dynamic Element .src Interceptors
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
})();
</script>`;

  // 5. Replace stylesheets and media in packedHtml
  let packedHtml = htmlText;
  for (const [fullTag, replacement] of inlinedStylesMap.entries()) {
    packedHtml = packedHtml.replace(fullTag, () => replacement);
  }
  for (const [mediaPath, dataUri] of mediaReplacements.entries()) {
    packedHtml = packedHtml.split(`src="${mediaPath}"`).join(`src="${dataUri}"`);
    packedHtml = packedHtml.split(`src='${mediaPath}'`).join(`src='${dataUri}'`);
    packedHtml = packedHtml.split(`href="${mediaPath}"`).join(`href="${dataUri}"`);
  }

  const headInjection = `\n<!-- UnityPack Studio Local Folder VFS Bundle -->\n${vfsChunksHtml}\n${vfsBootstrapScript}\n`;
  if (/<head\b[^>]*>/i.test(packedHtml)) {
    packedHtml = packedHtml.replace(/<head\b[^>]*>/i, (m) => `${m}${headInjection}`);
  } else {
    packedHtml = `${headInjection}\n${packedHtml}`;
  }

  const totalBytes = Array.from(fileMap.values()).reduce((s, f) => s + f.size, 0);
  const htmlBytes = new TextEncoder().encode(packedHtml).length;
  const durationMs = Date.now() - startTime;
  const safeSlug = gameTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'folder-game';

  onProgress?.({ stage: 'done', message: `Packed ${fileMap.size} files into single offline HTML in ${(durationMs / 1000).toFixed(1)}s!`, progress: 100 });

  return {
    bundleId,
    title: gameTitle,
    engineVersion,
    entryHtmlPath: entryFile.path,
    totalFiles: fileMap.size,
    totalBytes,
    htmlBytes,
    durationMs,
    fileNameDownload: `${safeSlug}-offline.html`,
    htmlContent: packedHtml,
    assets: vfsEntries.map((rec) => ({
      id: rec.id,
      path: rec.path,
      fileName: rec.fileName,
      mime: rec.mime,
      size: rec.size,
      category: rec.category,
      inlined: false,
      compressed: rec.compressed,
    })),
  };
}
