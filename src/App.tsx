import React, { useState, useRef, useMemo } from 'react';
import {
  Download,
  Play,
  RefreshCw,
  Search,
  Maximize2,
  FolderOpen,
  Layers,
  Archive,
  Folder,
  ArrowLeft,
  Info,
  Sliders,
  ChevronDown,
} from 'lucide-react';
import { packLocalFolder, extractZipFiles, LocalFolderFile } from './utils/folderPacker';

interface PackedAssetInfo {
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

interface BundleData {
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
  fileNameDownload: string;
}

interface ProgressLogItem {
  stage: string;
  message: string;
  progress: number;
  timestamp: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function App() {
  const [inputUrl, setInputUrl] = useState('');
  const [isPacking, setIsPacking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressStage, setProgressStage] = useState('');
  const [progressLogs, setProgressLogs] = useState<ProgressLogItem[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Active view: 'home' | 'player' | 'manifest'
  const [viewMode, setViewMode] = useState<'home' | 'player' | 'manifest'>('home');

  // Modals & dropdowns
  const [showOptionsModal, setShowOptionsModal] = useState(false);
  const [showInfoModal, setShowInfoModal] = useState(false);
  const [showPresetsDropdown, setShowPresetsDropdown] = useState(false);

  // Compiler options
  const [spoofOrigin, setSpoofOrigin] = useState(true);
  const [deepScanIl2Cpp, setDeepScanIl2Cpp] = useState(true);
  const [stripAntiDebug, setStripAntiDebug] = useState(true);
  const [disableUnityCache, setDisableUnityCache] = useState(true);
  const [includeOfflineHud, setIncludeOfflineHud] = useState(true);
  const [autoDownload, setAutoDownload] = useState(true);

  // Folder / ZIP state
  const [localFiles, setLocalFiles] = useState<LocalFolderFile[]>([]);
  const [folderName, setFolderName] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);

  // Packed bundle result
  const [bundle, setBundle] = useState<BundleData | null>(null);
  const [bundleBlobUrl, setBundleBlobUrl] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);

  const presets = [
    { label: 'Among Us (Unity WebGL)', url: 'https://stgames.top/unity/amongus/' },
    { label: 'WebBlox Demo (Wasm Engine)', url: 'https://coldbrewofficial.github.io/WebBloxDemo/' },
    { label: 'Drive Mad (Emscripten)', url: 'https://classroom-6x.org/games/drive-mad/' },
    { label: 'Blooket Bot (Web App)', url: 'https://blooketbot.schoolcheats.net/' },
  ];

  const handlePack = async (urlOverride?: string) => {
    const target = (urlOverride || inputUrl).trim();
    if (!target || isPacking) return;

    setIsPacking(true);
    setErrorMsg(null);
    setProgress(5);
    setProgressStage('Connecting & fetching entry document...');
    setProgressLogs([]);

    try {
      let usedServerApi = false;
      try {
        const response = await fetch('/api/pack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetUrl: target,
            spoofOrigin,
            deepScanIl2Cpp,
            stripAntiDebug,
            disableUnityCache,
            includeOfflineHud,
          }),
        });

        if (response.ok && response.body) {
          usedServerApi = true;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;
              const event = JSON.parse(line);
              if (event.type === 'progress') {
                setProgress(event.progress || 0);
                setProgressStage(event.message || '');
                const now = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                setProgressLogs((prev) => [...prev, { stage: event.stage, message: event.message, progress: event.progress, timestamp: now }]);
              } else if (event.type === 'result') {
                setBundle(event.bundle);
                setProgress(100);
                try {
                  const htmlRes = await fetch(`/api/bundle/${event.bundle.bundleId}/download`, { credentials: 'include' });
                  if (htmlRes.ok) {
                    const blob = await htmlRes.blob();
                    const bUrl = URL.createObjectURL(blob);
                    setBundleBlobUrl(bUrl);
                    setViewMode('player');

                    if (autoDownload) {
                      const link = document.createElement('a');
                      link.href = bUrl;
                      link.download = event.bundle.fileNameDownload;
                      document.body.appendChild(link);
                      link.click();
                      document.body.removeChild(link);
                    }
                  }
                } catch (blobErr) {
                  console.error('Blob URL creation error:', blobErr);
                }
              } else if (event.type === 'error') {
                throw new Error(event.error || 'Failed to pack URL');
              }
            }
          }
        }
      } catch (serverErr) {
        if (usedServerApi) throw serverErr;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error packaging game';
      setErrorMsg(msg);
    } finally {
      setIsPacking(false);
    }
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const filesList = e.target.files;
    if (!filesList || filesList.length === 0) return;
    setErrorMsg(null);
    setIsPacking(true);
    setProgress(10);
    setProgressStage('Reading local folder files...');

    try {
      const loadedFiles: LocalFolderFile[] = [];
      let detectedFolder = '';
      for (let i = 0; i < filesList.length; i++) {
        const file = filesList[i];
        const relPath = file.webkitRelativePath || file.name;
        if (!detectedFolder && relPath.includes('/')) {
          detectedFolder = relPath.split('/')[0];
        }
        const arrayBuf = await file.arrayBuffer();
        loadedFiles.push({
          path: relPath.replace(/^[^/]+\//, ''),
          name: file.name,
          size: file.size,
          type: file.type || '',
          data: new Uint8Array(arrayBuf),
        });
      }

      setLocalFiles(loadedFiles);
      setFolderName(detectedFolder || 'Local Game Folder');
      const defaultHtml =
        loadedFiles.find((f) => f.path.toLowerCase() === 'index.html' || f.name.toLowerCase() === 'index.html')?.path ||
        loadedFiles.find((f) => f.path.endsWith('.html'))?.path ||
        'index.html';

      const result = await packLocalFolder(
        loadedFiles,
        defaultHtml,
        {
          spoofOrigin,
          stripAntiDebug,
          disableUnityCache,
          includeOfflineHud,
          compressLargeChunks: true,
        },
        (p) => {
          setProgress(p.progress);
          setProgressStage(p.message);
        }
      );

      const blob = new Blob([result.htmlContent], { type: 'text/html' });
      const bUrl = URL.createObjectURL(blob);
      setBundleBlobUrl(bUrl);

      const bundleData: BundleData = {
        bundleId: result.bundleId,
        targetUrl: `local://${detectedFolder || 'folder'}/${defaultHtml}`,
        finalUrl: `local://${detectedFolder || 'folder'}/${defaultHtml}`,
        baseDirUrl: `local://${detectedFolder || 'folder'}/`,
        originUrl: 'https://localhost',
        title: result.title,
        engineVersion: result.engineVersion,
        companyName: 'Local Folder Compiler',
        productName: result.title,
        totalBytes: result.totalBytes,
        htmlBytes: result.htmlBytes,
        durationMs: result.durationMs,
        assets: result.assets.map((a) => ({
          id: a.id,
          url: `https://localhost/${a.path}`,
          relPath: a.path,
          originPath: `/${a.path}`,
          fileName: a.fileName,
          mime: a.mime,
          size: a.size,
          category: a.category,
          source: 'Local Folder File',
          status: 200,
          inlined: a.inlined,
        })),
        fileNameDownload: result.fileNameDownload,
      };

      setBundle(bundleData);
      setViewMode('player');

      if (autoDownload) {
        const link = document.createElement('a');
        link.href = bUrl;
        link.download = result.fileNameDownload;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error packaging local folder';
      setErrorMsg(msg);
    } finally {
      setIsPacking(false);
    }
  };

  const handleZipSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    setIsPacking(true);
    setProgress(10);
    setProgressStage('Extracting ZIP archive in memory...');

    try {
      const arrayBuf = await file.arrayBuffer();
      const extracted = extractZipFiles(new Uint8Array(arrayBuf));
      setLocalFiles(extracted);
      const title = file.name.replace(/\.zip$/i, '');
      setFolderName(title);

      const defaultHtml =
        extracted.find((f) => f.path.toLowerCase() === 'index.html' || f.name.toLowerCase() === 'index.html')?.path ||
        extracted.find((f) => f.path.endsWith('.html'))?.path ||
        'index.html';

      const result = await packLocalFolder(
        extracted,
        defaultHtml,
        {
          spoofOrigin,
          stripAntiDebug,
          disableUnityCache,
          includeOfflineHud,
          compressLargeChunks: true,
        },
        (p) => {
          setProgress(p.progress);
          setProgressStage(p.message);
        }
      );

      const blob = new Blob([result.htmlContent], { type: 'text/html' });
      const bUrl = URL.createObjectURL(blob);
      setBundleBlobUrl(bUrl);

      const bundleData: BundleData = {
        bundleId: result.bundleId,
        targetUrl: `local://${title}/${defaultHtml}`,
        finalUrl: `local://${title}/${defaultHtml}`,
        baseDirUrl: `local://${title}/`,
        originUrl: 'https://localhost',
        title: result.title,
        engineVersion: result.engineVersion,
        companyName: 'ZIP Compiler',
        productName: result.title,
        totalBytes: result.totalBytes,
        htmlBytes: result.htmlBytes,
        durationMs: result.durationMs,
        assets: result.assets.map((a) => ({
          id: a.id,
          url: `https://localhost/${a.path}`,
          relPath: a.path,
          originPath: `/${a.path}`,
          fileName: a.fileName,
          mime: a.mime,
          size: a.size,
          category: a.category,
          source: 'ZIP File',
          status: 200,
          inlined: a.inlined,
        })),
        fileNameDownload: result.fileNameDownload,
      };

      setBundle(bundleData);
      setViewMode('player');

      if (autoDownload) {
        const link = document.createElement('a');
        link.href = bUrl;
        link.download = result.fileNameDownload;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error extracting and compiling ZIP';
      setErrorMsg(msg);
    } finally {
      setIsPacking(false);
    }
  };

  const handleDownload = () => {
    if (!bundleBlobUrl || !bundle) return;
    const link = document.createElement('a');
    link.href = bundleBlobUrl;
    link.download = bundle.fileNameDownload;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredAssets = useMemo(() => {
    if (!bundle) return [];
    if (!searchQuery.trim()) return bundle.assets;
    const q = searchQuery.toLowerCase();
    return bundle.assets.filter(
      (a) => a.fileName.toLowerCase().includes(q) || a.relPath.toLowerCase().includes(q) || a.mime.toLowerCase().includes(q)
    );
  }, [bundle, searchQuery]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#244b1c] via-[#1a3814] to-[#10240d] text-slate-100 flex flex-col justify-between selection:bg-emerald-400 selection:text-black font-sans relative overflow-x-hidden">
      {/* Hidden file pickers for local folder / ZIP */}
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory attribute
        webkitdirectory=""
        directory=""
        multiple
        className="hidden"
        onChange={handleFolderSelect}
      />
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={handleZipSelect}
      />

      {/* Main Container */}
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-12 sm:py-20 max-w-4xl mx-auto w-full">
        {viewMode === 'home' && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={async (e) => {
              e.preventDefault();
              setIsDragging(false);
              const filesList = e.dataTransfer.files;
              if (filesList && filesList.length > 0) {
                const first = filesList[0];
                if (first.name.endsWith('.zip')) {
                  const arrayBuf = await first.arrayBuffer();
                  const extracted = extractZipFiles(new Uint8Array(arrayBuf));
                  setLocalFiles(extracted);
                  setFolderName(first.name.replace(/\.zip$/i, ''));
                  const defaultHtml =
                    extracted.find((f) => f.path.toLowerCase() === 'index.html' || f.name.toLowerCase() === 'index.html')?.path ||
                    extracted.find((f) => f.path.endsWith('.html'))?.path ||
                    'index.html';
                  setIsPacking(true);
                  setProgress(20);
                  setProgressStage('Compiling dropped ZIP into single HTML...');
                  const result = await packLocalFolder(extracted, defaultHtml, {
                    spoofOrigin,
                    stripAntiDebug,
                    disableUnityCache,
                    includeOfflineHud,
                    compressLargeChunks: true,
                  });
                  const blob = new Blob([result.htmlContent], { type: 'text/html' });
                  const bUrl = URL.createObjectURL(blob);
                  setBundleBlobUrl(bUrl);
                  setBundle({
                    bundleId: result.bundleId,
                    targetUrl: `local://${first.name}/${defaultHtml}`,
                    finalUrl: `local://${first.name}/${defaultHtml}`,
                    baseDirUrl: `local://${first.name}/`,
                    originUrl: 'https://localhost',
                    title: result.title,
                    engineVersion: result.engineVersion,
                    companyName: 'ZIP Compiler',
                    productName: result.title,
                    totalBytes: result.totalBytes,
                    htmlBytes: result.htmlBytes,
                    durationMs: result.durationMs,
                    assets: result.assets.map((a) => ({
                      id: a.id,
                      url: `https://localhost/${a.path}`,
                      relPath: a.path,
                      originPath: `/${a.path}`,
                      fileName: a.fileName,
                      mime: a.mime,
                      size: a.size,
                      category: a.category,
                      source: 'Dropped ZIP',
                      status: 200,
                      inlined: a.inlined,
                    })),
                    fileNameDownload: result.fileNameDownload,
                  });
                  setViewMode('player');
                  setIsPacking(false);
                }
              }
            }}
            className={`w-full flex flex-col items-center text-center space-y-8 transition-all duration-200 p-6 rounded-2xl ${
              isDragging ? 'bg-white/10 ring-2 ring-white scale-102' : ''
            }`}
          >
            {/* Minimalist Serif Headline styled cleanly */}
            <h1 className="font-serif text-3xl sm:text-4xl md:text-5xl text-white tracking-wide font-normal select-none drop-shadow-sm">
              singlefilegamepacker
            </h1>

            {/* Centered Input Box */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handlePack();
              }}
              className="w-full max-w-xl space-y-4"
            >
              <div className="relative group">
                <input
                  type="text"
                  value={inputUrl}
                  onChange={(e) => setInputUrl(e.target.value)}
                  placeholder="Paste Game/Web URL or Drop Folder + press Enter"
                  disabled={isPacking}
                  className="w-full h-12 sm:h-14 px-5 bg-black/25 hover:bg-black/35 focus:bg-black/40 border border-white/70 focus:border-white rounded-lg text-white placeholder:text-white/50 text-center text-xs sm:text-sm font-mono tracking-tight shadow-xl focus:outline-none focus:ring-1 focus:ring-white/80 transition-all"
                />
              </div>

              {/* Progress and status message */}
              {isPacking && (
                <div className="space-y-2 pt-2 animate-fade-in">
                  <div className="flex items-center justify-between text-xs font-mono text-emerald-200">
                    <span>{progressStage || 'Fetching & compiling bundle...'}</span>
                    <span className="font-bold">{progress}%</span>
                  </div>
                  <div className="w-full h-1 bg-white/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-white transition-all duration-150 origin-left"
                      style={{ transform: `scaleX(${Math.max(0.05, progress / 100)})` }}
                    />
                  </div>
                </div>
              )}

              {errorMsg && (
                <div className="p-3 bg-rose-950/80 border border-rose-500/50 rounded-lg text-rose-200 text-xs text-center font-mono">
                  {errorMsg}
                </div>
              )}
            </form>

            {/* Minimalist Sub-links */}
            <div className="flex flex-wrap items-center justify-center gap-3 text-xs sm:text-sm text-white/80 font-mono">
              {/* Presets dropdown toggle */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowPresetsDropdown(!showPresetsDropdown)}
                  className="underline underline-offset-4 hover:text-white transition-colors cursor-pointer flex items-center gap-1"
                >
                  <span>presets</span>
                  <ChevronDown className="w-3 h-3" />
                </button>

                {showPresetsDropdown && (
                  <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 bg-[#142d10] border border-[#2d5d23] rounded-lg shadow-2xl p-1.5 z-40 text-left">
                    {presets.map((p) => (
                      <button
                        key={p.url}
                        onClick={() => {
                          setInputUrl(p.url);
                          setShowPresetsDropdown(false);
                          handlePack(p.url);
                        }}
                        className="w-full text-left px-3 py-2 text-xs rounded hover:bg-white/10 text-emerald-100 hover:text-white transition-colors cursor-pointer"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <span>+</span>

              {/* Local Folder Upload trigger */}
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="underline underline-offset-4 hover:text-white transition-colors cursor-pointer"
              >
                folder
              </button>

              <span>+</span>

              {/* ZIP Archive upload trigger */}
              <button
                type="button"
                onClick={() => zipInputRef.current?.click()}
                className="underline underline-offset-4 hover:text-white transition-colors cursor-pointer"
              >
                zip
              </button>

              <span>+</span>

              {/* Options modal toggle */}
              <button
                type="button"
                onClick={() => setShowOptionsModal(true)}
                className="underline underline-offset-4 hover:text-white transition-colors cursor-pointer"
              >
                options
              </button>

              <span>+</span>

              {/* Info modal toggle */}
              <button
                type="button"
                onClick={() => setShowInfoModal(true)}
                className="underline underline-offset-4 hover:text-white transition-colors cursor-pointer"
              >
                info
              </button>
            </div>
          </div>
        )}

        {/* Live Playable Sandbox Player Mode */}
        {viewMode === 'player' && bundle && (
          <div className="w-full flex-1 flex flex-col space-y-3 max-w-5xl">
            {/* Minimal Player Toolbar */}
            <div className="flex items-center justify-between bg-[#142e0f]/90 border border-[#2d5d23] px-4 py-2.5 rounded-xl shadow-lg backdrop-blur-md">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setViewMode('home')}
                  className="px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white rounded text-xs font-mono flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Launcher</span>
                </button>
                <div className="text-xs font-semibold text-white truncate max-w-[200px] sm:max-w-[320px]">
                  {bundle.title || 'Offline Web Game'}
                </div>
                <span className="hidden sm:inline-block px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  {bundle.engineVersion}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setViewMode('manifest')}
                  className="px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white rounded text-xs font-mono flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Layers className="w-3.5 h-3.5" />
                  <span>Assets ({bundle.assets.length})</span>
                </button>

                <button
                  type="button"
                  onClick={handleDownload}
                  className="px-3 py-1 bg-emerald-400 hover:bg-emerald-300 text-black font-semibold rounded text-xs font-mono flex items-center gap-1.5 transition-colors cursor-pointer shadow-md"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download HTML ({formatBytes(bundle.htmlBytes)})</span>
                </button>

                <button
                  type="button"
                  onClick={() => previewIframeRef.current?.requestFullscreen().catch(() => {})}
                  className="p-1 bg-white/10 hover:bg-white/20 text-white rounded transition-colors cursor-pointer"
                  title="Fullscreen"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Embedded Iframe Player */}
            <div className="w-full aspect-[16/9] sm:h-[620px] bg-black rounded-xl overflow-hidden border border-[#2d5d23] shadow-2xl relative">
              {bundleBlobUrl ? (
                <iframe
                  ref={previewIframeRef}
                  src={bundleBlobUrl}
                  title="Offline Sandbox Preview"
                  sandbox="allow-scripts allow-same-origin allow-modals allow-downloads allow-pointer-lock allow-orientation-lock"
                  className="w-full h-full border-0 absolute inset-0"
                />
              ) : null}
            </div>
          </div>
        )}

        {/* Manifest Inspector Mode */}
        {viewMode === 'manifest' && bundle && (
          <div className="w-full max-w-4xl bg-[#142e0f]/90 border border-[#2d5d23] p-6 rounded-2xl space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#2d5d23]/80 pb-3">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setViewMode('player')}
                  className="px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white rounded text-xs font-mono flex items-center gap-1 cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back to Game</span>
                </button>
                <h2 className="text-sm font-semibold font-mono text-white">
                  VFS Bundle Assets ({bundle.assets.length})
                </h2>
              </div>

              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search assets..."
                className="px-3 py-1 bg-black/40 border border-white/30 rounded text-xs text-white placeholder:text-white/40 font-mono focus:outline-none focus:border-white"
              />
            </div>

            <div className="max-h-96 overflow-y-auto font-mono text-xs divide-y divide-[#2d5d23]/40">
              {filteredAssets.map((asset) => (
                <div key={asset.id} className="py-2 flex items-center justify-between hover:bg-white/5 px-2 rounded">
                  <div className="truncate max-w-[320px] sm:max-w-md font-medium text-emerald-100">
                    {asset.relPath || asset.fileName}
                  </div>
                  <div className="flex items-center gap-4 text-emerald-300/80 text-[11px] shrink-0">
                    <span>{asset.mime}</span>
                    <span className="tabular-nums font-semibold text-white">{formatBytes(asset.size)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Options Modal */}
      {showOptionsModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#142e0f] border border-[#2d5d23] rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl font-mono text-xs">
            <div className="flex items-center justify-between border-b border-[#2d5d23] pb-3">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Sliders className="w-4 h-4 text-emerald-400" />
                <span>Compiler & Offline Options</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowOptionsModal(false)}
                className="text-white/60 hover:text-white cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-slate-200">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={spoofOrigin}
                  onChange={(e) => setSpoofOrigin(e.target.checked)}
                  className="mt-0.5 rounded border-[#2d5d23] text-emerald-500 focus:ring-emerald-500"
                />
                <div>
                  <div className="font-semibold text-white">Bypass CORS & Sitelocks</div>
                  <div className="text-[11px] text-emerald-300/70">Spoofs document.URL and cookies for file://</div>
                </div>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={deepScanIl2Cpp}
                  onChange={(e) => setDeepScanIl2Cpp(e.target.checked)}
                  className="mt-0.5 rounded border-[#2d5d23] text-emerald-500 focus:ring-emerald-500"
                />
                <div>
                  <div className="font-semibold text-white">IL2CPP & Data Archive Deep Scan</div>
                  <div className="text-[11px] text-emerald-300/70">Finds ChatData and internal WebAssembly dependencies</div>
                </div>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={stripAntiDebug}
                  onChange={(e) => setStripAntiDebug(e.target.checked)}
                  className="mt-0.5 rounded border-[#2d5d23] text-emerald-500 focus:ring-emerald-500"
                />
                <div>
                  <div className="font-semibold text-white">Strip Anti-DevTools Traps</div>
                  <div className="text-[11px] text-emerald-300/70">Neutralizes infinite debugger statements</div>
                </div>
              </label>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoDownload}
                  onChange={(e) => setAutoDownload(e.target.checked)}
                  className="mt-0.5 rounded border-[#2d5d23] text-emerald-500 focus:ring-emerald-500"
                />
                <div>
                  <div className="font-semibold text-white">Auto-Download on Finish</div>
                  <div className="text-[11px] text-emerald-300/70">Instantly saves single HTML locally upon completion</div>
                </div>
              </label>
            </div>

            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowOptionsModal(false)}
                className="w-full py-2 bg-emerald-500 hover:bg-emerald-400 text-black font-semibold rounded-lg transition-colors cursor-pointer"
              >
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Info Modal */}
      {showInfoModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#142e0f] border border-[#2d5d23] rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl font-mono text-xs">
            <div className="flex items-center justify-between border-b border-[#2d5d23] pb-3">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Info className="w-4 h-4 text-emerald-400" />
                <span>About singlefilegamepacker</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowInfoModal(false)}
                className="text-white/60 hover:text-white cursor-pointer"
              >
                ✕
              </button>
            </div>

            <p className="text-emerald-100 leading-relaxed">
              <strong>singlefilegamepacker</strong> crawls remote web games, WebAssembly engines, and web apps — or takes any local folder / .ZIP archive — and compiles all assets, stylesheets, scripts, and binaries into a <strong>single standalone offline HTML file</strong> with an embedded in-memory Virtual File System (VFS).
            </p>

            <div className="p-3 bg-black/30 rounded-lg space-y-1.5 text-[11px] text-emerald-300/90">
              <div>✓ Zero network calls after compilation</div>
              <div>✓ Plays locally on <code className="text-white">file://</code> and sandboxed contexts</div>
              <div>✓ Deployable to GitHub Pages, Vercel, or static servers</div>
            </div>

            <button
              type="button"
              onClick={() => setShowInfoModal(false)}
              className="w-full py-2 bg-white/10 hover:bg-white/20 text-white font-semibold rounded-lg transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Bottom Minimal Footer */}
      <footer className="w-full py-4 text-center text-xs text-white/40 font-mono">
        singlefilegamepacker — single-file offline web game compiler
      </footer>
    </div>
  );
}
