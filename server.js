const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

function homixEnv(name) {
  return process.env[`HOMIX_${name}`] || process.env[`SCENESIFT_${name}`] || '';
}

const HOST = '127.0.0.1';
const PORT = Number(homixEnv('PORT') || 47821);
const VERSION = '0.20.5';
const ROOT = __dirname;
const WINDOWS_PROCESS_RUNNER = process.platform === 'win32' && homixEnv('PROCESS_RUNNER') && fs.existsSync(homixEnv('PROCESS_RUNNER'))
  ? homixEnv('PROCESS_RUNNER')
  : '';
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(homixEnv('DATA_DIR') || path.join(ROOT, 'data'));
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const AI_CONFIG_FILE = path.join(DATA_DIR, 'ai-config.json');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const LIBRARY_DIR = path.join(DATA_DIR, 'library');
const LIBRARY_CLIPS_DIR = path.join(LIBRARY_DIR, 'clips');
const LIBRARY_THUMBS_DIR = path.join(LIBRARY_DIR, 'thumbs');
const runtimeAi = {
  provider: homixEnv('AI_PROVIDER') || 'ollama',
  glmApiKey: homixEnv('GLM_API_KEY') || '',
  glmApiKeyProtected: '',
  glmModel: homixEnv('GLM_MODEL') || 'glm-4.6v-flash',
  glmBaseUrl: (homixEnv('GLM_BASE_URL') || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/$/, ''),
};

for (const dir of [DATA_DIR, PROJECTS_DIR, LIBRARY_CLIPS_DIR, LIBRARY_THUMBS_DIR]) fs.mkdirSync(dir, { recursive: true });

const WORKFLOW_JOBS = new Map();
const BATCH_EXPORT_JOBS = new Map();
const ACTIVE_BATCH_EXPORTS = new Map();
const ACTIVE_PREVIEWS = new Map();
const PROJECT_SAVE_QUEUES = new Map();
const MUSIC_WAVEFORM_JOBS = new Map();
let activePicker = null;

function hiddenProcessSpec(command, args = [], relayInput = false) {
  if (!WINDOWS_PROCESS_RUNNER || path.resolve(command) === path.resolve(WINDOWS_PROCESS_RUNNER)) return { command, args };
  return {
    command: WINDOWS_PROCESS_RUNNER,
    args: [relayInput ? '--run-hidden-stdin' : '--run-hidden', command, ...args],
  };
}

function spawnHidden(command, args = [], options = {}) {
  const target = hiddenProcessSpec(command, args, false);
  return spawn(target.command, target.args, { ...options, shell: false, windowsHide: process.platform === 'win32' });
}

function spawnHiddenSync(command, args = [], options = {}) {
  const target = hiddenProcessSpec(command, args, Boolean(options.input));
  return spawnSync(target.command, target.args, { ...options, shell: false, windowsHide: process.platform === 'win32' });
}

function updateWorkflowJob(job, patch = {}) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  return job;
}

function workflowOverall(progress) {
  const branches = [];
  if (progress.broll.total > 0) branches.push(progress.broll);
  if (progress.hooks.total > 0) branches.push(progress.hooks);
  if (!branches.length) return 0;
  const ratios = branches.map((branch) => branch.total > 0 ? branch.done / branch.total : 0);
  return Math.max(0, Math.min(99, Math.round((ratios.reduce((sum, value) => sum + value, 0) / ratios.length) * 100)));
}

function dpapi(mode, value) {
  if (process.platform !== 'win32' || !value) return '';
  const script = mode === 'protect'
    ? `Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$b=[Text.Encoding]::UTF8.GetBytes($v);$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($p)`
    : `Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd();$p=[Convert]::FromBase64String($v);$b=[System.Security.Cryptography.ProtectedData]::Unprotect($p,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($b)`;
  const result = spawnHiddenSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: value,
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

const MACOS_KEYCHAIN_SERVICE = 'HoMix GLM API Key';

function macosKeychain(mode, value) {
  if (process.platform !== 'darwin') return '';
  const account = os.userInfo().username;
  const service = mode === 'unprotect' && value.startsWith('keychain:')
    ? value.slice('keychain:'.length)
    : MACOS_KEYCHAIN_SERVICE;
  const args = mode === 'protect'
    ? ['add-generic-password', '-a', account, '-s', MACOS_KEYCHAIN_SERVICE, '-w', value, '-U']
    : ['find-generic-password', '-a', account, '-s', service, '-w'];
  const result = spawnSync('/usr/bin/security', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return '';
  return mode === 'protect' ? `keychain:${MACOS_KEYCHAIN_SERVICE}` : result.stdout.trim();
}

function protectSecret(value) {
  if (!value) return '';
  if (process.platform === 'win32') return dpapi('protect', value);
  if (process.platform === 'darwin') return macosKeychain('protect', value);
  return '';
}

function unprotectSecret(value) {
  if (!value) return '';
  if (process.platform === 'win32') return dpapi('unprotect', value);
  if (process.platform === 'darwin' && value.startsWith('keychain:')) return macosKeychain('unprotect', value);
  return '';
}

function loadSavedAiConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, 'utf8'));
    if (saved.provider === 'glm' || saved.provider === 'ollama') runtimeAi.provider = saved.provider;
    if (typeof saved.glmModel === 'string' && saved.glmModel) runtimeAi.glmModel = saved.glmModel;
    if (!homixEnv('GLM_API_KEY') && saved.glmApiKeyProtected) {
      runtimeAi.glmApiKeyProtected = saved.glmApiKeyProtected;
    }
  } catch {}
}

function hasGlmApiKey() {
  return Boolean(runtimeAi.glmApiKey || runtimeAi.glmApiKeyProtected);
}

function ensureGlmApiKeyLoaded() {
  if (!runtimeAi.glmApiKey && runtimeAi.glmApiKeyProtected) {
    runtimeAi.glmApiKey = unprotectSecret(runtimeAi.glmApiKeyProtected);
  }
  return runtimeAi.glmApiKey;
}

async function saveAiConfig() {
  const protectedKey = runtimeAi.glmApiKey ? protectSecret(runtimeAi.glmApiKey) : runtimeAi.glmApiKeyProtected;
  runtimeAi.glmApiKeyProtected = protectedKey;
  await fsp.writeFile(AI_CONFIG_FILE, JSON.stringify({
    provider: runtimeAi.provider,
    glmModel: runtimeAi.glmModel,
    glmApiKeyProtected: protectedKey,
    protection: protectedKey ? (process.platform === 'darwin' ? 'macos-keychain-current-user' : 'windows-dpapi-current-user') : 'none',
  }, null, 2), 'utf8');
}

loadSavedAiConfig();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
};

function findBinary(name) {
  const configured = homixEnv(name.toUpperCase());
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [
    configured,
    path.join(ROOT, 'tools', executable),
    process.platform === 'win32' ? `D:\\ECutPro\\Resources\\FFmpeg\\Windows\\ffmpeg\\bin\\${executable}` : '',
    process.platform === 'win32' ? path.join(os.homedir(), 'scoop', 'apps', 'ffmpeg', 'current', 'bin', executable) : '',
    process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', executable) : '',
    process.platform === 'darwin' ? path.join('/opt/homebrew/bin', executable) : '',
    process.platform === 'darwin' ? path.join('/usr/local/bin', executable) : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const located = spawnHiddenSync(locator, [name], { encoding: 'utf8' });
  if (located.status === 0) return located.stdout.trim().split(/\r?\n/)[0];
  return null;
}

function findOllamaBinary() {
  const candidates = [
    homixEnv('OLLAMA'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Ollama', 'ollama.exe'),
    process.platform === 'darwin' ? '/Applications/Ollama.app/Contents/Resources/ollama' : '',
    process.platform === 'darwin' ? '/opt/homebrew/bin/ollama' : '',
    process.platform === 'darwin' ? '/usr/local/bin/ollama' : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const located = spawnHiddenSync(locator, ['ollama'], { encoding: 'utf8' });
  return located.status === 0 ? located.stdout.trim().split(/\r?\n/)[0] : null;
}

const FFMPEG = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');
let ollamaExecutable = null;
let ollamaBinaryResolved = false;
let ollamaProcess = null;

function getOllamaBinary() {
  if (!ollamaBinaryResolved) {
    ollamaExecutable = findOllamaBinary();
    ollamaBinaryResolved = true;
  }
  return ollamaExecutable;
}

function uncheckedOllamaStatus() {
  return { checked: false, available: false, installed: null, executable: null, models: [], visionModels: [] };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message, detail) {
  sendJson(res, status, { error: message, detail: detail || undefined });
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('本地请求数据不完整，请重新执行当前操作');
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { signal, ...spawnOptions } = options;
    if (signal?.aborted) return reject(Object.assign(new Error('任务已取消'), { code: 'PREVIEW_ABORTED' }));
    const child = spawnHidden(command, args, spawnOptions);
    if (path.basename(command).toLowerCase().startsWith('ffmpeg')) {
      try { os.setPriority(child.pid, 10); } catch {}
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(error);
    };
    const abort = () => {
      try { child.kill(); } catch {}
      finishReject(Object.assign(new Error('任务已取消'), { code: 'PREVIEW_ABORTED' }));
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', finishReject);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${path.basename(command)} 运行失败 (${code})`), { stdout, stderr, code }));
    });
  });
}

async function probeVideo(file) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const data = JSON.parse(stdout);
  const video = data.streams.find((stream) => stream.codec_type === 'video') || {};
  const audio = data.streams.find((stream) => stream.codec_type === 'audio') || {};
  const rate = String(video.avg_frame_rate || video.r_frame_rate || '0/1').split('/').map(Number);
  const fps = rate.length === 2 && rate[1] ? rate[0] / rate[1] : 0;
  const duration = Number(data.format?.duration || video.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`无法读取视频时长：${file}`);
  return {
    duration,
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    codec: video.codec_name || 'unknown',
    audioCodec: audio.codec_name || '',
    fps: Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : 30,
    size: Number(data.format?.size || 0),
  };
}

function quantizeTime(value, fps) {
  return Number((Math.round(Number(value) * fps) / fps).toFixed(6));
}

function pickSceneCuts(candidates, duration, minDuration, fps) {
  const clean = candidates
    .map((item) => ({ time: Number(Number(item.time).toFixed(6)), score: Number(item.score) || 0 }))
    .filter((item) => item.time > Math.max(2 / fps, 0.05) && item.time < duration - Math.max(2 / fps, 0.05))
    .sort((a, b) => a.time - b.time);
  const strongest = [];
  // Scene scores can stay high for several frames during a flash/fade.  Keeping
  // the earliest frame in that burst prevents the preceding clip from carrying
  // frames that already belong to the next visual idea.
  const transitionWindow = Math.max(2 / fps, 0.055);
  for (const candidate of clean) {
    const previous = strongest[strongest.length - 1];
    if (previous && candidate.time - previous.time <= transitionWindow) {
      previous.score = Math.max(previous.score, candidate.score);
    } else strongest.push(candidate);
  }
  if (minDuration <= 0) return [0, ...strongest.map((item) => item.time), Number(duration.toFixed(6))];
  const spaced = [];
  for (const candidate of strongest) {
    const previous = spaced[spaced.length - 1];
    if (!previous || candidate.time - previous.time >= minDuration) spaced.push(candidate);
    // Never move a retained boundary later: that is precisely what makes the
    // previous exported shot leak the opening frames of the following shot.
  }
  if (spaced.length && duration - spaced[spaced.length - 1].time < minDuration) spaced.pop();
  return [0, ...spaced.map((item) => item.time), Number(duration.toFixed(6))];
}

async function detectScenes(file, threshold, minDuration, duration, fps, mode = 'continuity') {
  const escapedThreshold = Math.max(0.05, Math.min(0.95, Number(threshold) || 0.35));
  try {
    const filter = mode === 'precise'
      ? `blackdetect=d=0.04:pix_th=0.10,select='gt(scene,${escapedThreshold})',metadata=print`
      : `select='gt(scene,${escapedThreshold})',metadata=print`;
    const { stderr } = await run(FFMPEG, [
      '-hide_banner', '-nostdin', '-threads', '2', '-i', file,
      '-vf', filter,
      '-an', '-f', 'null', '-',
    ]);
    const candidates = [];
    let pendingTime = null;
    for (const line of stderr.split(/\r?\n/)) {
      const time = /pts_time:([0-9]+(?:\.[0-9]+)?)/.exec(line);
      if (time) pendingTime = Number(time[1]);
      const score = /lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/.exec(line);
      if (score && pendingTime !== null) {
        candidates.push({ time: pendingTime, score: Number(score[1]) });
        pendingTime = null;
      }
      const black = mode === 'precise' ? /black_start:([0-9.]+)\s+black_end:([0-9.]+)/.exec(line) : null;
      if (black) {
        candidates.push({ time: Number(black[1]), score: 1 });
        candidates.push({ time: Number(black[2]), score: 1 });
      }
    }
    return pickSceneCuts(candidates, duration, Math.max(0, minDuration), fps);
  } catch (error) {
    throw new Error(`场景检测失败：${error.stderr?.slice(-800) || error.message}`);
  }
}

async function makeThumbnail(file, at, output, width = 720) {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', String(Math.max(0, at)), '-threads', '2', '-i', file,
    '-frames:v', '1', '-vf', `scale=${Math.max(240, Math.round(Number(width) || 720))}:-2:flags=lanczos`, '-q:v', '2', '-y', output,
  ]);
}

async function makeThumbnails(file, items, fps, assetDir) {
  if (!items.length) return;
  const chunkSize = 6;
  for (let offset = 0; offset < items.length; offset += chunkSize) {
    const chunk = items.slice(offset, offset + chunkSize);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    for (const item of chunk) args.push('-ss', String(Math.max(0, item.at)), '-threads', '1', '-i', file);
    for (let index = 0; index < chunk.length; index += 1) {
      args.push('-map', `${index}:v:0`, '-frames:v', '1', '-vf', 'scale=720:-2:flags=lanczos', '-q:v', '2', '-y', path.join(assetDir, chunk[index].name));
    }
    try { await run(FFMPEG, args); } catch {}
  }
  for (const item of items) {
    const output = path.join(assetDir, item.name);
    if (!fs.existsSync(output)) {
      try { await makeThumbnail(file, item.at, output); } catch {}
    }
  }
}

function baseLabel(index, total) {
  if (total > 2 && index === 0) return '片头';
  if (total > 2 && index === total - 1) return '片尾';
  return `镜头 ${String(index + 1).padStart(2, '0')}`;
}

function layoutForDimensions(width, height) {
  return Number(width) > Number(height) ? 'triple' : 'portrait';
}

function projectFile(id) { return path.join(PROJECTS_DIR, `${id}.json`); }

async function readProjectSnapshot(id) {
  const record = projectFile(id);
  try { return JSON.parse(await fsp.readFile(record, 'utf8')); }
  catch (primaryError) {
    try { return JSON.parse(await fsp.readFile(`${record}.bak`, 'utf8')); }
    catch { throw primaryError; }
  }
}

async function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  const snapshot = JSON.stringify(project, null, 2);
  const previous = PROJECT_SAVE_QUEUES.get(project.id) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const record = projectFile(project.id);
    const temporary = `${record}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(temporary, snapshot, 'utf8');
      if (fs.existsSync(record)) await fsp.copyFile(record, `${record}.bak`);
      await fsp.rename(temporary, record);
    } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
  });
  PROJECT_SAVE_QUEUES.set(project.id, next);
  try { await next; }
  finally { if (PROJECT_SAVE_QUEUES.get(project.id) === next) PROJECT_SAVE_QUEUES.delete(project.id); }
}

async function loadProject(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('项目编号无效');
  return applyFrameCutRule(await readProjectSnapshot(id));
}

function applyFrameCutRule(project) {
  if (!project) return project;
  project.hookPlans = project.hookPlans && typeof project.hookPlans === 'object' ? project.hookPlans : {};
  project.musicTracks = Array.isArray(project.musicTracks) ? project.musicTracks : [];
  const inferredUseBroll = Boolean(project.files?.length || project.segments?.length);
  const inferredUseHooks = Boolean(project.hooks?.length || project.hook);
  project.workflowConfig = {
    useBroll: inferredUseBroll,
    useHooks: inferredUseHooks,
    useMusic: false,
    mixDuration: 15,
    outputCount: 1,
    ...(project.workflowConfig || {}),
  };
  for (const source of project.files || []) {
    source.layout = layoutForDimensions(source.width, source.height);
    source.orientation = source.layout === 'triple' ? 'landscape' : 'portrait';
  }
  if (!project?.segments?.length || !project?.files?.length) return project;
  for (const segment of project.segments) {
    if (!Number.isFinite(Number(segment.rawStart)) || !Number.isFinite(Number(segment.rawEnd))) continue;
    const source = project.files.find((file) => file.id === segment.fileId);
    segment.layout = source?.layout || layoutForDimensions(source?.width, source?.height);
    const fps = Number(source?.fps) || 30;
    segment.start = Number(Number(segment.rawStart).toFixed(6));
    segment.end = Number(Number(segment.rawEnd).toFixed(6));
    segment.duration = Number((segment.end - segment.start).toFixed(3));
    segment.startFrame = Number.isFinite(Number(segment.startFrame)) ? Number(segment.startFrame) : Math.round(segment.start * fps);
    segment.endFrameExclusive = Number.isFinite(Number(segment.endFrameExclusive)) ? Number(segment.endFrameExclusive) : Math.round(segment.end * fps);
    segment.endTrimFrames = 0;
    if (segment.boundaryMode !== 'manual-frame-pts-half-open') segment.boundaryMode = 'source-frame-pts-half-open';
    segment.transitionGuard = undefined;
  }
  project.options = { ...(project.options || {}), endTrimFrames: 0, cutRule: 'frame-pts-half-open-v4' };
  return project;
}

async function loadLibrary() {
  try {
    const data = JSON.parse(await fsp.readFile(LIBRARY_FILE, 'utf8'));
    return Array.isArray(data.items) ? data : { version: 1, items: [] };
  } catch {
    return { version: 1, items: [] };
  }
}

async function saveLibrary(library) {
  library.updatedAt = new Date().toISOString();
  await fsp.writeFile(LIBRARY_FILE, JSON.stringify(library, null, 2), 'utf8');
}

async function syncLibraryAiFromProject(project) {
  const library = await loadLibrary();
  let changed = false;
  for (const item of library.items) {
    if (item.projectId !== project.id) continue;
    const segment = project.segments.find((entry) => entry.id === item.segmentId);
    if (!segment?.ai) continue;
    item.ai = segment.ai;
    item.label = segment.label;
    changed = true;
  }
  if (changed) await saveLibrary(library);
}

function libraryAsProject(library) {
  const usable = library.items.filter((item) => item.type !== 'hook' && item.clipPath && fs.existsSync(item.clipPath));
  return {
    id: 'star-library',
    name: '星标素材库',
    libraryOnly: true,
    files: usable.map((item) => ({ id: `lf_${item.id}`, path: item.clipPath, name: item.sourceName || path.basename(item.clipPath), duration: Number(item.duration) || 1, fps: 30, width: item.width, height: item.height, layout: item.layout || layoutForDimensions(item.width, item.height) })),
    segments: usable.map((item, index) => ({
      id: `ls_${item.id}`, fileId: `lf_${item.id}`, index, start: 0, end: Number(item.duration) || 1,
      duration: Number(item.duration) || 1, selected: true, label: item.label, ai: item.ai || null, layout: item.layout || layoutForDimensions(item.width, item.height),
      libraryItem: true, libraryId: item.id,
      thumbnailUrl: item.thumbnailPath ? `/api/library/thumb?id=${encodeURIComponent(item.id)}` : '',
    })),
    mixPlans: library.mixPlans || [],
  };
}

function withLibraryCandidates(project, library) {
  const libraryProject = libraryAsProject(library);
  return {
    ...project,
    files: [...project.files, ...libraryProject.files],
    segments: [...project.segments, ...libraryProject.segments],
    mixPlans: [...(project.mixPlans || [])],
  };
}

function publicLibraryItem(item) {
  return {
    id: item.id,
    projectId: item.projectId,
    segmentId: item.segmentId,
    label: item.label,
    sourceName: item.sourceName,
    duration: item.duration,
    width: item.width,
    height: item.height,
    layout: item.layout || layoutForDimensions(item.width, item.height),
    createdAt: item.createdAt,
    hasClip: Boolean(item.clipPath && fs.existsSync(item.clipPath)),
    hasThumbnail: Boolean(item.thumbnailPath && fs.existsSync(item.thumbnailPath)),
    ai: item.ai || null,
    type: item.type === 'hook' ? 'hook' : 'broll',
  };
}

function createProject(options = {}) {
  const now = new Date().toISOString();
  return {
    id: `p_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    name: options.name || `镜头项目 ${new Date().toLocaleString('zh-CN')}`,
    createdAt: now,
    updatedAt: now,
    options: { ...options, endTrimFrames: 0, cutRule: 'frame-pts-half-open-v4' },
    files: [],
    segments: [],
    hooks: [],
    hookPlans: {},
    musicTracks: [],
    workflowConfig: {
      useBroll: options.useBroll !== false,
      useHooks: Boolean(options.useHooks),
      useMusic: Boolean(options.useMusic),
      mixDuration: Math.max(1, Number(options.mixDuration) || 15),
      outputCount: Math.max(1, Math.min(50, Number(options.outputCount) || 1)),
    },
  };
}

async function analyzeFiles(files, options, existingProject = null) {
  if (!FFMPEG || !FFPROBE) throw new Error('未找到 FFmpeg/FFprobe，请放入 HoMix 的 tools 文件夹或设置 HOMIX_FFMPEG 环境变量');
  const usable = files.filter((file) => typeof file === 'string' && fs.existsSync(file));
  if (!usable.length) throw new Error('没有可读取的视频文件');
  const project = existingProject || createProject(options);
  const id = project.id;
  const assetDir = path.join(DATA_DIR, id);
  await fsp.mkdir(assetDir, { recursive: true });
  project.name = options.name || project.name;
  project.options = { ...project.options, ...options, endTrimFrames: 0, cutRule: 'frame-pts-half-open-v4' };
  project.files = [];
  project.segments = [];
  options.onProgress?.({ done: 0, total: usable.length, current: '' });
  for (let fileIndex = 0; fileIndex < usable.length; fileIndex += 1) {
    const file = path.resolve(usable[fileIndex]);
    options.onProgress?.({ done: fileIndex, total: usable.length, current: path.basename(file) });
    const info = await probeVideo(file);
    const boundaries = await detectScenes(file, options.threshold, options.minDuration, info.duration, info.fps, options.splitMode || 'continuity');
    const sourceId = `f${fileIndex}`;
    const layout = layoutForDimensions(info.width, info.height);
    project.files.push({ id: sourceId, path: file, name: path.basename(file), ...info, layout, orientation: layout === 'triple' ? 'landscape' : 'portrait' });
    const total = boundaries.length - 1;
    const thumbnails = [];
    for (let index = 0; index < total; index += 1) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      const safeStart = Number(start.toFixed(6));
      const safeEnd = Number(end.toFixed(6));
      const segmentId = `${sourceId}_s${index}`;
      const thumbName = `${segmentId}.jpg`;
      const at = Math.min(end - 0.03, start + Math.max(0.12, Math.min((end - start) / 2, 2)));
      thumbnails.push({ name: thumbName, at });
      project.segments.push({
        id: segmentId,
        fileId: sourceId,
        index,
        rawStart: start,
        rawEnd: end,
        start: safeStart,
        end: safeEnd,
        duration: Number((safeEnd - safeStart).toFixed(3)),
        startFrame: Math.round(safeStart * info.fps),
        endFrameExclusive: Math.round(safeEnd * info.fps),
        endTrimFrames: 0,
        boundaryMode: 'source-frame-pts-half-open',
        label: baseLabel(index, total),
        selected: true,
        layout,
        thumbnail: thumbName,
      });
    }
    await makeThumbnails(file, thumbnails, info.fps, assetDir);
    for (const segment of project.segments.filter((item) => item.fileId === sourceId)) {
      if (!fs.existsSync(path.join(assetDir, segment.thumbnail))) segment.thumbnail = null;
    }
    options.onProgress?.({ done: fileIndex + 1, total: usable.length, current: path.basename(file), segments: project.segments.length });
  }
  await saveProject(project);
  return project;
}

function analyzeMusicWaveform(file, points = 640) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return resolve([]);
    const child = spawnHidden(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '120', '-f', 's16le', 'pipe:1']);
    try { os.setPriority(child.pid, 10); } catch {}
    const chunks = [];
    let error = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { error += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(error || '音乐波形分析失败'));
      const buffer = Buffer.concat(chunks);
      const samples = Math.floor(buffer.length / 2);
      if (!samples) return resolve([]);
      const count = Math.max(48, Math.min(points, samples));
      const values = [];
      for (let index = 0; index < count; index++) {
        const from = Math.floor(index * samples / count);
        const to = Math.max(from + 1, Math.floor((index + 1) * samples / count));
        let peak = 0;
        let squares = 0;
        for (let sample = from; sample < to; sample++) {
          const value = Math.abs(buffer.readInt16LE(sample * 2)) / 32768;
          peak = Math.max(peak, value);
          squares += value * value;
        }
        const rms = Math.sqrt(squares / Math.max(1, to - from));
        values.push(rms * 0.72 + peak * 0.28);
      }
      const sorted = [...values].sort((a, b) => a - b);
      const scale = Math.max(0.02, sorted[Math.floor(sorted.length * 0.96)] || sorted[sorted.length - 1] || 1);
      resolve(values.map((value) => Number(Math.min(1, value / scale).toFixed(3))));
    });
  });
}

async function prepareMusicTracks(paths) {
  const unique = [...new Set((paths || []).map((item) => path.resolve(String(item || '').trim())).filter(Boolean))].slice(0, 50);
  const tracks = [];
  for (const file of unique) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`音乐文件不存在：${path.basename(file)}`);
    const info = await probeVideo(file);
    if (!info.audioCodec) throw new Error(`文件没有可用音轨：${path.basename(file)}`);
    let waveform = [];
    try { waveform = await analyzeMusicWaveform(file); } catch {}
    tracks.push({
      id: `music_${crypto.createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 12)}`,
      path: file,
      name: path.basename(file),
      duration: info.duration,
      audioCodec: info.audioCodec,
      waveform,
    });
  }
  return tracks;
}

function appendLibraryBroll(project, library, ids) {
  const selected = new Set(ids || []);
  const items = library.items.filter((item) => selected.has(item.id) && item.type !== 'hook' && item.clipPath && fs.existsSync(item.clipPath));
  for (const item of items) {
    const fileId = `lib_file_${item.id}`;
    const segmentId = `lib_segment_${item.id}`;
    if (project.segments.some((segment) => segment.id === segmentId)) continue;
    project.files.push({
      id: fileId, path: item.clipPath, name: item.sourceName || path.basename(item.clipPath),
      duration: Number(item.duration) || 1, fps: 30, width: item.width, height: item.height,
      layout: item.layout || layoutForDimensions(item.width, item.height), libraryId: item.id,
    });
    project.segments.push({
      id: segmentId, fileId, index: project.segments.length, start: 0, end: Number(item.duration) || 1,
      duration: Number(item.duration) || 1, selected: true, label: item.label, ai: item.ai || null,
      layout: item.layout || layoutForDimensions(item.width, item.height), libraryItem: true, libraryId: item.id,
      thumbnailUrl: item.thumbnailPath ? `/api/library/thumb?id=${encodeURIComponent(item.id)}` : '', starred: true,
    });
  }
}

async function ollamaStatus(inspectCapabilities = true) {
  const executable = getOllamaBinary();
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return { checked: true, available: false, installed: Boolean(executable), executable, models: [], visionModels: [] };
    const data = await response.json();
    const models = (data.models || []).map((item) => item.name);
    const visionModels = [];
    if (inspectCapabilities) {
      for (const model of models.slice(0, 20)) {
        try {
          const detailResponse = await fetch('http://127.0.0.1:11434/api/show', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model }), signal: AbortSignal.timeout(2500),
          });
          const detail = detailResponse.ok ? await detailResponse.json() : {};
          if ((detail.capabilities || []).includes('vision')) visionModels.push(model);
        } catch {}
      }
    }
    return { checked: true, available: true, installed: Boolean(executable), executable, models, visionModels: inspectCapabilities ? visionModels : models };
  } catch { return { checked: true, available: false, installed: Boolean(executable), executable, models: [], visionModels: [] }; }
}

async function ensureOllamaRunning() {
  const current = await ollamaStatus(false);
  if (current.available) return ollamaStatus(true);
  const executable = getOllamaBinary();
  if (!executable) throw new Error('未找到 Ollama。请先安装 Ollama，再由 HoMix 自动启动并配置视觉模型。');
  if (!ollamaProcess || ollamaProcess.exitCode !== null) {
    ollamaProcess = spawnHidden(executable, ['serve'], { detached: true, stdio: 'ignore' });
    ollamaProcess.unref();
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const status = await ollamaStatus(false);
    if (status.available) return ollamaStatus(true);
  }
  throw new Error('Ollama 已尝试启动，但本地 API 在 9 秒内没有就绪。');
}

async function pullOllamaModel(model) {
  const name = String(model || '').trim();
  if (!/^[a-zA-Z0-9._:/-]{2,120}$/.test(name)) throw new Error('Ollama 模型名称无效');
  await ensureOllamaRunning();
  const response = await fetch('http://127.0.0.1:11434/api/pull', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, stream: false }),
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!response.ok) throw new Error(`Ollama 模型安装失败：${response.status} · ${(await response.text()).slice(0, 300)}`);
  const status = await ollamaStatus(true);
  if (!status.visionModels.includes(name) && !status.visionModels.some((item) => item.startsWith(`${name}:`))) {
    throw new Error(`模型 ${name} 已安装，但 Ollama 未将它识别为视觉模型。`);
  }
  return status;
}

function aiStatus(ollama) {
  const glm = {
    configured: hasGlmApiKey(),
    persisted: fs.existsSync(AI_CONFIG_FILE),
    model: runtimeAi.glmModel,
    baseUrl: runtimeAi.glmBaseUrl,
  };
  const available = [];
  if (ollama.available && ollama.visionModels.length) available.push('ollama');
  if (glm.configured) available.push('glm');
  const provider = ollama.checked === false
    ? runtimeAi.provider
    : available.includes(runtimeAi.provider) ? runtimeAi.provider : (available[0] || runtimeAi.provider);
  return { provider, available, glm };
}

function cleanLabel(value) {
  return String(value || '').trim().replace(/[。。，,“”"'\n\r]/g, '').slice(0, 24);
}

function parseJsonObject(value) {
  const text = String(value || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function normalizeVisionResult(value, provider, model) {
  const parsed = typeof value === 'object' && value ? value : parseJsonObject(value);
  if (!parsed) {
    const label = cleanLabel(value);
    return label ? { label, ai: { provider, model, summary: label, keywords: [label] } } : null;
  }
  const summary = cleanLabel(parsed.summary || parsed.label || parsed.scene || parsed.subject);
  const list = (item) => (Array.isArray(item) ? item : item ? [item] : [])
    .map((entry) => cleanLabel(entry)).filter(Boolean).slice(0, 8);
  const ai = {
    provider,
    model,
    summary,
    subjects: list(parsed.subjects || parsed.subject),
    scene: cleanLabel(parsed.scene),
    action: cleanLabel(parsed.action),
    shotType: cleanLabel(parsed.shot_type || parsed.shotType),
    mood: cleanLabel(parsed.mood),
    keywords: list(parsed.keywords || parsed.tags),
    narrativeRole: cleanLabel(parsed.narrative_role || parsed.narrativeRole || parsed.role),
    storyFunction: cleanLabel(parsed.story_function || parsed.storyFunction),
    cameraMotion: cleanLabel(parsed.camera_motion || parsed.cameraMotion),
    continuityKeys: list(parsed.continuity_keys || parsed.continuityKeys),
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
  };
  const label = summary || ai.scene || ai.subjects[0] || ai.keywords[0];
  return label ? { label, ai } : null;
}

const VISION_PROMPT = `按时间顺序分析这个镜头的开头、中间、结尾三张定格帧，只返回一个 JSON 对象，不要 Markdown 和解释。字段：summary（2到10个简体中文字的镜头标签）、subjects（主体数组）、scene（场景）、action（动作）、shot_type（景别）、mood（情绪或氛围）、camera_motion（镜头运动）、keywords（适合文案匹配的关键词数组）、continuity_keys（可与前后镜头建立连续关系的人物、地点、动作、方向或色彩关键词数组）、story_function（这个镜头在故事中的功能）、narrative_role（只能是 opening、development、climax、ending、neutral 之一；Logo片头为 opening，字幕片尾或结束页为 ending）、confidence（0到1的画面理解置信度）。必须综合三帧判断，禁止只根据单帧凭空猜测。`;

async function callVisionJson(provider, model, prompt, images) {
  if (provider === 'glm') {
    if (!ensureGlmApiKeyLoaded()) throw new Error('请先在 AI 设置中填写 GLM API Key');
    const selectedModel = model || runtimeAi.glmModel;
    const response = await fetch(`${runtimeAi.glmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${runtimeAi.glmApiKey}` },
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          ...images.map((item) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${item}` } })),
        ] }],
        temperature: 0.05,
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`GLM 返回错误：${response.status} · ${(await response.text().catch(() => '')).slice(0, 240)}`);
    const data = await response.json();
    return parseJsonObject(data.choices?.[0]?.message?.content || '');
  }
  const status = await ensureOllamaRunning();
  if (!status.available) throw new Error('未检测到 Ollama 本地模型服务');
  const selectedModel = model || status.visionModels[0];
  if (!selectedModel) throw new Error('Ollama 中没有已安装的视觉模型');
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: selectedModel,
      stream: false,
      think: false,
      format: 'json',
      messages: [{ role: 'user', content: prompt, images }],
      options: { temperature: 0.05, num_ctx: 3072, num_predict: 120 },
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`本地模型返回错误：${response.status} · ${(await response.text().catch(() => '')).slice(0, 260)}`);
  const data = await response.json();
  return parseJsonObject(data.message?.content || data.message?.thinking || data.response || '');
}

async function classifyHookBoundary(project, hookPath, info, boundaries, options = {}) {
  const internal = boundaries.slice(1, -1);
  const fallback = internal.find((time) => time >= 0.5)
    || Math.min(info.duration - (1 / info.fps), Math.max(0.6, Math.min(1.8, info.duration * 0.25)));
  const provider = options.provider || runtimeAi.provider;
  const status = provider === 'ollama'
    ? await ensureOllamaRunning().catch(() => ({ available: false, visionModels: [] }))
    : uncheckedOllamaStatus();
  const canUseAi = provider === 'glm' ? hasGlmApiKey() : Boolean(status.available && status.visionModels.length);
  if (!canUseAi) return {
    hookEnd: quantizeTime(fallback, info.fps), confidence: 0.42, needsReview: true,
    method: 'scene-logic-fallback', reason: '未连接视觉模型，按首个有效场景边界估算',
  };

  const sampleBoundaries = [0, ...internal.filter((time) => time <= Math.min(info.duration, 12)), Math.min(info.duration, 12)]
    .filter((time, index, list) => index === 0 || time - list[index - 1] >= 0.12)
  const allTimes = [];
  for (let index = 0; index < sampleBoundaries.length - 1; index += 1) {
    allTimes.push(Number(((sampleBoundaries[index] + sampleBoundaries[index + 1]) / 2).toFixed(3)));
  }
  const times = allTimes.length <= 4 ? allTimes : Array.from({ length: 4 }, (_, index) => allTimes[Math.round(index * (allTimes.length - 1) / 3)]);
  const assetDir = path.join(DATA_DIR, project.id);
  const sampleId = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const generated = times.map((time, index) => ({ time, file: path.join(assetDir, `hook_ai_${sampleId}_${index}.jpg`) }));
  try {
    await Promise.all(generated.map((item) => makeThumbnail(hookPath, item.time, item.file, 288)));
    const images = await Promise.all(generated.map(async (item) => (await fsp.readFile(item.file)).toString('base64')));
    const timeline = generated.map((item, index) => `图${index + 1}=${item.time.toFixed(2)}秒`).join('，');
    const prompt = `你是短视频广告剪辑导演。按顺序判断吸引停留的钩子何时结束、产品正文何时开始。钩子通常是意外、失误、进球、悬念或强动作；正文通常是商品/品牌特写、功能演示或购买信息。同一主体换机位不等于正文开始。帧时间：${timeline}。候选边界：${internal.map((time) => time.toFixed(3)).join('、') || '无'}。只返回 JSON：{"hook_end_seconds":数字,"confidence":0到1,"reason":"短理由","frame_types":["hook或product"]}；结束秒数优先取候选边界。`;
    const parsed = await callVisionJson(provider, options.model || (provider === 'ollama' ? status.visionModels[0] : runtimeAi.glmModel), prompt, images);
    let requested = Number(parsed?.hook_end_seconds);
    if (!Number.isFinite(requested) && Number.isFinite(Number(parsed?.first_product_frame))) {
      const frameIndex = Math.max(1, Math.round(Number(parsed.first_product_frame))) - 1;
      requested = generated[Math.min(frameIndex, generated.length - 1)]?.time;
    }
    if (!Number.isFinite(requested)) requested = fallback;
    const candidates = internal.length ? internal : [fallback];
    const nearest = candidates.reduce((best, time) => Math.abs(time - requested) < Math.abs(best - requested) ? time : best, candidates[0]);
    const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0.55));
    return {
      hookEnd: quantizeTime(nearest, info.fps), confidence, needsReview: confidence < 0.72,
      method: `${provider}-vision-logic`, reason: cleanLabel(parsed?.reason || '视觉与叙事逻辑联合判断'),
      frameTypes: Array.isArray(parsed?.frame_types) ? parsed.frame_types.slice(0, generated.length) : [],
    };
  } catch (error) {
    return {
      hookEnd: quantizeTime(fallback, info.fps), confidence: 0.38, needsReview: true,
      method: 'scene-logic-fallback', reason: `视觉判断失败：${String(error.message || error).slice(0, 80)}`,
    };
  } finally {
    await Promise.all(generated.map((item) => fsp.rm(item.file, { force: true }).catch(() => {})));
  }
}

async function segmentVisionImages(project, segment) {
  const assetDir = path.join(DATA_DIR, project.id);
  const source = project.files.find((file) => file.id === segment.fileId);
  if (!source || !fs.existsSync(source.path)) return [];
  const fps = Number(source.fps) || 30;
  const firstAt = Math.min(segment.end - 1 / fps, segment.start + 1 / fps);
  const lastAt = Math.max(segment.start, segment.end - 1 / fps);
  const generated = [
    { at: firstAt, file: path.join(assetDir, `${segment.id}_vision_start.jpg`) },
    { at: lastAt, file: path.join(assetDir, `${segment.id}_vision_end.jpg`) },
  ];
  for (const item of generated) await makeThumbnail(source.path, item.at, item.file);
  const paths = [generated[0].file];
  if (segment.thumbnail) paths.push(path.join(assetDir, segment.thumbnail));
  paths.push(generated[1].file);
  try { return await Promise.all(paths.filter((file) => fs.existsSync(file)).map(async (file) => (await fsp.readFile(file)).toString('base64'))); }
  finally { await Promise.all(generated.map((item) => fsp.rm(item.file, { force: true }).catch(() => {}))); }
}

async function labelWithOllama(project, model, ids) {
  const assetDir = path.join(DATA_DIR, project.id);
  const selected = ids?.length ? project.segments.filter((segment) => ids.includes(segment.id)) : project.segments;
  for (const segment of selected) {
    const images = await segmentVisionImages(project, segment);
    if (!images.length) continue;
    const response = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: 'json',
        messages: [{ role: 'user', content: VISION_PROMPT, images }],
        options: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`本地模型返回错误：${response.status}`);
    const data = await response.json();
    const result = normalizeVisionResult(data.message?.content || data.message?.thinking || data.response, 'ollama', model);
    if (result) Object.assign(segment, result);
  }
  await saveProject(project);
  await syncLibraryAiFromProject(project);
  return project;
}

async function labelWithGlm(project, model, ids) {
  if (!ensureGlmApiKeyLoaded()) throw new Error('请先在 AI 设置中填写 GLM API Key');
  const assetDir = path.join(DATA_DIR, project.id);
  const selected = ids?.length ? project.segments.filter((segment) => ids.includes(segment.id)) : project.segments;
  for (const segment of selected) {
    const images = await segmentVisionImages(project, segment);
    if (!images.length) continue;
    const response = await fetch(`${runtimeAi.glmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${runtimeAi.glmApiKey}`,
      },
      body: JSON.stringify({
        model: model || runtimeAi.glmModel,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            ...images.map((image) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } })),
          ],
        }],
        temperature: 0.1,
        stream: false,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`GLM 返回错误：${response.status}${detail ? ` · ${detail.slice(0, 240)}` : ''}`);
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const result = normalizeVisionResult(content, 'glm', model || runtimeAi.glmModel);
    if (result) Object.assign(segment, result);
  }
  await saveProject(project);
  await syncLibraryAiFromProject(project);
  return project;
}

function safeName(value) {
  return String(value || '未命名').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 80) || '未命名';
}

const CONCEPT_GROUPS = [
  ['科技', '智能', '数字', '数据', '设备', '机器', '芯片', '能源', '创新', '未来'],
  ['发展', '增长', '进步', '突破', '建设', '升级', '扩大', '全球', '国际'],
  ['人物', '员工', '团队', '工程师', '专家', '会议', '交流', '合作'],
  ['城市', '建筑', '工厂', '园区', '道路', '交通', '办公室'],
  ['自然', '海洋', '山川', '天空', '森林', '绿色', '环保', '生态'],
  ['产品', '细节', '特写', '展示', '操作', '生产', '制造', '装配'],
];
const CONCEPT_NAMES = ['科技与能源', '发展与全球化', '人物与协作', '城市与工业', '自然与环保', '产品与制造'];

function textTokens(value) {
  const source = String(value || '').toLowerCase();
  const normalized = source.replace(/[^\p{L}\p{N}]+/gu, '');
  const tokens = new Set(source.match(/[a-z0-9]+/g) || []);
  const chineseRuns = source.match(/[\p{Script=Han}]+/gu) || [];
  for (const run of chineseRuns) {
    const chars = [...run];
    for (let size = 2; size <= Math.min(4, chars.length); size += 1) {
      for (let index = 0; index + size <= chars.length; index += 1) tokens.add(chars.slice(index, index + size).join(''));
    }
  }
  CONCEPT_GROUPS.forEach((group, index) => {
    if (group.some((word) => normalized.includes(word))) tokens.add(`concept_${index}`);
  });
  return tokens;
}

function splitScriptBeats(script, targetCount) {
  const text = String(script || '').replace(/\r/g, '').trim();
  if (!text) throw new Error('请先输入混剪文案');
  const count = Math.max(2, Math.min(20, Math.round(Number(targetCount) || 10)));
  let units = text.split(/[\n。！？!?；;]+/).map((item) => item.trim()).filter(Boolean);
  if (units.length < count) {
    units = units.flatMap((item) => item.split(/[，,、：:]+/).map((part) => part.trim()).filter(Boolean));
  }
  if (units.length > count) {
    const compact = units.slice(0, count);
    compact[count - 1] = [...compact.slice(count - 1), ...units.slice(count)].join('，');
    units = compact;
  }
  return Array.from({ length: count }, (_, index) => ({
    index,
    text: units[Math.min(units.length - 1, Math.floor(index * units.length / count))] || text,
  }));
}

function segmentSearchText(segment) {
  const ai = segment.ai || {};
  return [segment.label, ai.summary, ...(ai.subjects || []), ai.scene, ai.action, ai.shotType, ai.mood, ai.cameraMotion, ai.storyFunction, ai.narrativeRole, ...(ai.continuityKeys || []), ...(ai.keywords || [])].filter(Boolean).join(' ');
}

function tokenOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += token.startsWith('concept_') ? 2.5 : token.length > 1 ? 2 : 0.45;
  return common / Math.sqrt(a.size * b.size);
}

function tokenSetsIntersect(a, b) {
  if (!a.size || !b.size) return false;
  for (const token of a) {
    if (token.length > 1 && !token.startsWith('concept_') && b.has(token)) return true;
  }
  return false;
}

function shotRank(value) {
  const text = String(value || '');
  if (/特写|极近/.test(text)) return 4;
  if (/近景/.test(text)) return 3;
  if (/中景/.test(text)) return 2;
  if (/全景|远景|航拍|广角/.test(text)) return 0;
  return 1;
}

function narrativePreference(segment, position) {
  const ai = segment.ai || {};
  const text = `${ai.shotType || ''} ${ai.action || ''} ${ai.mood || ''} ${segment.label || ''}`;
  if (position <= 0.16) return /全景|远景|航拍|建立|环境/.test(text) ? 1 : 0;
  if (position >= 0.84) return /全景|远景|收束|静态|背影|落日/.test(text) ? 1 : 0;
  if (position >= 0.58 && position < 0.84) return /特写|近景|运动|快速|动作|操作/.test(text) ? 1 : 0;
  return /中景|人物|动作|操作|生产/.test(text) ? 1 : 0;
}

function visualTokens(segment) {
  if (segment.ai) return textTokens([
    segment.ai.summary,
    ...(segment.ai.subjects || []),
    segment.ai.scene,
    segment.ai.action,
    segment.ai.shotType,
    segment.ai.mood,
    segment.ai.narrativeRole,
    segment.ai.storyFunction,
    segment.ai.cameraMotion,
    ...(segment.ai.continuityKeys || []),
    ...(segment.ai.keywords || []),
  ].filter(Boolean).join(' '));
  return /^镜头\s*\d+$/i.test(segment.label || '') || /^(片头|片尾)$/.test(segment.label || '')
    ? new Set()
    : textTokens(segment.label);
}

function setSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token) && token.length > 1) common += 1;
  return common / Math.max(1, Math.min(a.size, b.size));
}

function segmentNarrativeRole(project, segment) {
  const sourceSegments = project.segments.filter((item) => item.fileId === segment.fileId);
  const lastIndex = sourceSegments.reduce((max, item) => Math.max(max, Number(item.index) || 0), 0);
  const role = String(segment.ai?.narrativeRole || '').toLowerCase();
  const text = `${segment.label || ''} ${segment.ai?.summary || ''} ${(segment.ai?.keywords || []).join(' ')}`;
  if (/ending|片尾|结尾|结束页|收尾/.test(`${role} ${text}`) || (!segment.libraryItem && Number(segment.index) === lastIndex)) return 'ending';
  if (/opening|片头|开场|序章|开篇/.test(`${role} ${text}`) || (!segment.libraryItem && Number(segment.index) === 0)) return 'opening';
  if (/climax|高潮/.test(role)) return 'climax';
  if (/development|推进|发展/.test(role)) return 'development';
  return 'neutral';
}

function roleAllowed(role, beatIndex, shotCount) {
  if (shotCount <= 1) return role !== 'ending';
  if (beatIndex === 0) return role !== 'ending';
  if (beatIndex === shotCount - 1) return role !== 'opening';
  return role !== 'opening' && role !== 'ending';
}

function buildMixPlan(project, options) {
  const script = String(options.script || '').trim();
  if (!script) throw new Error('请先输入混剪文案');
  const matchMode = options.matchMode === 'lines' ? 'lines' : 'story';
  const lineUnits = script.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 50);
  const requestedCount = matchMode === 'lines'
    ? Math.max(1, lineUnits.length)
    : Math.max(2, Math.min(20, Math.round(Number(options.shotCount) || 10)));
  const totalDuration = Math.max(matchMode === 'lines' ? 1 : 5, Math.min(300, Number(options.duration) || requestedCount * 1.5));
  let beats = matchMode === 'lines'
    ? lineUnits.map((text, index) => ({ index, text }))
    : splitScriptBeats(script, requestedCount);
  const candidates = project.segments.filter((segment) => segment.selected !== false && Number(segment.duration) >= 0.35);
  if (!candidates.length) throw new Error('项目中没有可用于混剪的镜头');
  const understood = candidates.filter((segment) => segment.ai && segment.ai.summary);
  if (understood.length < requestedCount) {
    const action = project.libraryOnly
      ? '请先在原项目中为星标镜头生成视觉标签；标签会自动同步到素材库。'
      : '点击“批量理解全部未标注镜头”，系统会自动排队处理，无需先人工筛选。';
    throw new Error(`视觉理解不足：当前候选镜头中只有 ${understood.length} 个完成视觉标签，方案需要 ${requestedCount} 个。${action}`);
  }
  const historicalUse = new Map();
  for (const plan of project.mixPlans || []) {
    for (const shot of plan.shots || []) historicalUse.set(shot.segmentId, (historicalUse.get(shot.segmentId) || 0) + 1);
  }
  const unused = understood.filter((segment) => !historicalUse.has(segment.id));
  const candidatePool = unused.length >= requestedCount ? unused : understood;
  const shotCount = beats.length;
  const enriched = candidatePool.map((segment) => ({
    segment,
    tokens: textTokens(segmentSearchText(segment)),
    visualTokens: visualTokens(segment),
    role: segmentNarrativeRole(project, segment),
  }));
  const used = new Set();
  const shots = [];
  const picked = [];
  const lastIndexByFile = new Map();
  const targetDuration = totalDuration / shotCount;
  for (const beat of beats) {
    const position = shotCount <= 1 ? 0 : beat.index / (shotCount - 1);
    const beatTokens = textTokens(beat.text);
    const previous = shots[shots.length - 1];
    let best = null;
    for (const candidate of enriched) {
      const segment = candidate.segment;
      if (used.has(segment.id)) continue;
      if (!roleAllowed(candidate.role, beat.index, shotCount)) continue;
      const source = project.files.find((file) => file.id === segment.fileId);
      const priorSourceIndex = lastIndexByFile.get(segment.fileId);
      if (priorSourceIndex !== undefined && Number(segment.index) <= priorSourceIndex) continue;
      const remainingBeats = shotCount - beat.index - 1;
      if (remainingBeats > 0) {
        const futureAvailable = enriched.filter((future) => {
          if (future.segment.id === segment.id || used.has(future.segment.id)) return false;
          const floor = future.segment.fileId === segment.fileId
            ? Number(segment.index)
            : lastIndexByFile.get(future.segment.fileId);
          if (floor !== undefined && Number(future.segment.index) <= floor) return false;
          return beats.slice(beat.index + 1).some((futureBeat) => roleAllowed(future.role, futureBeat.index, shotCount));
        });
        if (futureAvailable.length < remainingBeats) continue;
      }
      let score = tokenOverlap(beatTokens, candidate.tokens) * 65;
      score += narrativePreference(segment, position) * 13;
      score += Math.max(0, Number(segment.ai?.confidence) || 0) * 8;
      score += segment.starred ? 8 : 0;
      score -= (historicalUse.get(segment.id) || 0) * 45;
      score += Math.min(6, Number(segment.duration) / targetDuration * 2);
      const sourcePosition = source?.duration ? Number(segment.start) / Number(source.duration) : position;
      score += Math.max(0, 1 - Math.abs(sourcePosition - position)) * 6;
      for (const prior of picked) {
        if (prior.segment.fileId === segment.fileId) {
          const timeGap = Math.abs(Number(prior.segment.start) - Number(segment.start));
          if (timeGap < 3) score -= 55;
          else if (timeGap < 8) score -= 24;
          else if (timeGap < 20) score -= 7;
        }
        const similarity = setSimilarity(candidate.visualTokens, prior.visualTokens);
        if (similarity >= 0.75) score -= 38;
        else if (similarity >= 0.5) score -= 18;
      }
      if (previous) {
        const rankGap = Math.abs(previous.shotRank - shotRank(segment.ai?.shotType));
        if (rankGap <= 1) score += 4;
        else if (rankGap >= 3) score -= 5;
        const sameScene = previous.scene && segment.ai?.scene
          && tokenSetsIntersect(textTokens(previous.scene), textTokens(segment.ai.scene));
        if (sameScene) score += 5;
        const continuity = tokenOverlap(
          textTokens(previous.continuityKeys || ''),
          textTokens((segment.ai?.continuityKeys || []).join(' ')),
        );
        score += continuity * 12;
      }
      if (!best || score > best.score) best = { candidate, source, score };
    }
    if (!best) throw new Error(`无法为第 ${beat.index + 1} 个文案节点找到符合片头/片尾位置和原片顺序约束的镜头。请增加已完成视觉理解的候选镜头。`);
    const segment = best.candidate.segment;
    used.add(segment.id);
    lastIndexByFile.set(segment.fileId, Number(segment.index));
    picked.push(best.candidate);
    const available = Math.max(0.2, segment.end - segment.start);
    const duration = Math.min(targetDuration, available);
    const fps = best.source?.fps || 30;
    const sourceStart = quantizeTime(segment.start + Math.max(0, (available - duration) / 2), fps);
    const matched = [...beatTokens].filter((token) => best.candidate.tokens.has(token) && !token.startsWith('concept_')).slice(0, 4);
    const concepts = [...beatTokens]
      .filter((token) => token.startsWith('concept_') && best.candidate.tokens.has(token))
      .map((token) => CONCEPT_NAMES[Number(token.slice(8))])
      .filter(Boolean)
      .slice(0, 2);
    shots.push({
      order: beat.index + 1,
      beat: beat.text,
      segmentId: segment.id,
      fileId: segment.fileId,
      index: segment.index,
      label: segment.label,
      sourceStart,
      duration: Number(duration.toFixed(3)),
      score: Number(best.score.toFixed(2)),
      reason: matched.length
        ? `画面语义：${matched.join('、')}`
        : concepts.length
          ? `主题语义：${concepts.join('、')}`
          : `叙事角色 ${best.candidate.role} · ${segment.ai.shotType || '画面节奏'}匹配`,
      shotRank: shotRank(segment.ai?.shotType),
      scene: segment.ai?.scene || '',
      continuityKeys: (segment.ai?.continuityKeys || []).join(' '),
      role: best.candidate.role,
      thumbnail: segment.thumbnail,
      thumbnailUrl: segment.thumbnailUrl || '',
      sourcePath: best.source?.path || '',
      libraryItem: Boolean(segment.libraryItem),
    });
  }
  const plan = {
    id: `mix_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    script,
    duration: Number(shots.reduce((sum, shot) => sum + shot.duration, 0).toFixed(3)),
    requestedDuration: totalDuration,
    shotCount: shots.length,
    createdAt: new Date().toISOString(),
    strategy: 'semantic-story-v3-role-locked-history-dedup',
    matchMode,
    duplicateGuard: 'strict',
    semanticCoverage: shots.length,
    shots,
  };
  project.mixPlans = [plan, ...(project.mixPlans || [])].slice(0, 10);
  return plan;
}

async function exportMixPlan(project, plan, options = {}) {
  if (!FFMPEG) throw new Error('未找到 FFmpeg');
  if (!plan?.shots?.length) throw new Error('混剪方案为空');
  const outputDir = path.resolve(options.outputDir || path.join(path.dirname(project.files[0].path), 'HoMix混剪'));
  await fsp.mkdir(outputDir, { recursive: true });
  const tempDir = path.join(DATA_DIR, `mix_tmp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`);
  await fsp.mkdir(tempDir, { recursive: true });
  const clips = [];
  try {
    for (let index = 0; index < plan.shots.length; index += 1) {
      const shot = plan.shots[index];
      const source = project.files.find((file) => file.id === shot.fileId) || (shot.sourcePath ? { path: shot.sourcePath, name: path.basename(shot.sourcePath) } : null);
      if (!source || !fs.existsSync(source.path)) throw new Error(`混剪源文件不存在：${shot.label}`);
      await assertSegmentIntegrity(source.path, shot.sourceStart, shot.duration, `混剪第 ${index + 1} 镜头“${shot.label}”`);
      const clip = path.join(tempDir, `clip_${String(index).padStart(3, '0')}.ts`);
      const frameCount = Math.max(1, Math.round(Number(shot.duration) * 30));
      await run(FFMPEG, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(shot.sourceStart), '-i', source.path,
        '-map', '0:v:0', '-an',
        '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p',
        '-frames:v', String(frameCount),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
        '-f', 'mpegts', '-y', clip,
      ]);
      clips.push(clip);
    }
    const listFile = path.join(tempDir, 'concat.txt');
    await fsp.writeFile(listFile, clips.map((clip) => `file '${clip.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const output = path.join(outputDir, `${safeName(project.name)}_${safeName(plan.id)}.mp4`);
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', '-y', output]);
    return { output, outputDir, duration: plan.duration, shots: plan.shots.length };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function updateSegmentBoundary(project, segmentId, requestedStart, requestedEnd) {
  const segment = project.segments.find((item) => item.id === segmentId);
  if (!segment) throw new Error('镜头不存在');
  const source = project.files.find((item) => item.id === segment.fileId);
  if (!source) throw new Error('源视频信息不存在');
  const fps = Number(source.fps) || 30;
  const frame = 1 / fps;
  const start = quantizeTime(Math.max(0, Math.min(Number(requestedStart), source.duration - frame)), fps);
  const end = quantizeTime(Math.max(start + frame, Math.min(Number(requestedEnd), source.duration)), fps);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('入点或出点无效');
  segment.rawStart = start;
  segment.rawEnd = end;
  segment.start = start;
  segment.end = end;
  segment.duration = Number((end - start).toFixed(3));
  segment.startFrame = Math.round(start * fps);
  segment.endFrameExclusive = Math.round(end * fps);
  segment.boundaryMode = 'manual-frame-pts-half-open';
  await saveProject(project);
  return project;
}

async function analyzeHook(project, requestedPath, options = {}) {
  if (!FFMPEG || !FFPROBE) throw new Error('未找到 FFmpeg/FFprobe');
  const hookPath = path.resolve(String(requestedPath || '').trim());
  if (!hookPath || !fs.existsSync(hookPath) || !fs.statSync(hookPath).isFile()) throw new Error('钩子视频不存在或无法读取');
  const info = await probeVideo(hookPath);
  if (!info.audioCodec) throw new Error('这条钩子视频没有音轨，无法执行“保留原音频、替换后段画面”');
  const threshold = Math.max(0.05, Math.min(0.5, Number(options.threshold) || 0.16));
  const boundaries = await detectScenes(hookPath, threshold, 0, info.duration, info.fps, 'precise');
  const candidates = boundaries.slice(1, -1);
  const hookId = `hook_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const assetDir = path.join(DATA_DIR, project.id);
  await fsp.mkdir(assetDir, { recursive: true });
  const audioPath = path.join(assetDir, `${hookId}_audio.m4a`);
  const classificationTask = options.autoClassify
    ? classifyHookBoundary(project, hookPath, info, boundaries, options)
    : Promise.resolve(null);
  const audioTask = (async () => {
    await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', hookPath,
      '-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', audioPath,
    ]);
  })();
  let classification;
  try {
    [classification] = await Promise.all([classificationTask, audioTask]);
  } catch (error) {
    await fsp.rm(audioPath, { force: true }).catch(() => {});
    throw new Error(`钩子音乐提取失败：${error.stderr?.trim().slice(-500) || error.message}`);
  }
  const suggestedCut = classification?.hookEnd || candidates.find((time) => time >= 0.35)
    || Math.min(info.duration - (1 / info.fps), Math.max(0.5, Math.min(1.5, info.duration * 0.25)));
  const hook = {
    id: hookId,
    path: hookPath,
    name: path.basename(hookPath),
    audioPath,
    audioName: `${path.parse(hookPath).name}_原音乐.m4a`,
    analyzedAt: new Date().toISOString(),
    info,
    boundaries,
    suggestedCut: quantizeTime(suggestedCut, info.fps),
    classification,
  };
  if (options.persist !== false) {
    project.hook = hook;
    project.hooks = [...(project.hooks || []).filter((item) => item.path !== hookPath), hook];
    await saveProject(project);
  }
  return hook;
}

async function confirmHookExtraction(project, requestedCut, requestedHook = null, persist = true) {
  const hook = requestedHook || project.hook;
  if (!hook?.path || !fs.existsSync(hook.path)) throw new Error('请先提取钩子与音乐');
  if (!hook.audioPath || !fs.existsSync(hook.audioPath)) throw new Error('提取的音乐文件不存在，请重新提取');
  const fps = Number(hook.info?.fps) || 30;
  const duration = Number(hook.info?.duration) || 0;
  hook.confirmedCut = quantizeTime(Math.max(1 / fps, Math.min(Number(requestedCut) || hook.suggestedCut, duration - (1 / fps))), fps);
  hook.visualPath = hook.visualPath && hook.visualPath !== hook.path && fs.existsSync(hook.visualPath) ? hook.visualPath : null;
  hook.visualName = `${path.parse(hook.name).name}_钩子切点`;
  hook.visualDeferred = true;
  hook.confirmedAt = new Date().toISOString();
  if (persist) {
    project.hook = hook;
    if (Array.isArray(project.hooks)) project.hooks = project.hooks.map((item) => item.id === hook.id ? hook : item);
    await saveProject(project);
  }
  return hook;
}

async function reviewProjectHook(project, hookId, requestedCut) {
  const hook = (project.hooks || []).find((item) => item.id === hookId);
  if (!hook) throw new Error('要核验的钩子不存在');
  const previousCut = Number(hook.confirmedCut || 0);
  await confirmHookExtraction(project, requestedCut, hook, false);
  if (previousCut && Math.abs(previousCut - hook.confirmedCut) > 1 / (Number(hook.info?.fps) || 30) / 2) {
    if (project.hookPlans) delete project.hookPlans[hook.id];
  }
  hook.humanReviewedAt = new Date().toISOString();
  project.hook = hook;
  project.hooks = (project.hooks || []).map((item) => item.id === hook.id ? hook : item);
  await saveProject(project);
  return hook;
}

async function deleteProjectHook(project, hookId) {
  const hook = (project.hooks || []).find((item) => item.id === hookId);
  if (!hook) throw new Error('要删除的钩子不存在或已经移除');
  project.hooks = (project.hooks || []).filter((item) => item.id !== hookId);
  if (project.hookPlans) delete project.hookPlans[hookId];
  if (project.hook?.id === hookId) {
    project.hook = project.hooks.find((item) => !item.humanReviewedAt) || project.hooks[0] || null;
  }

  // Only derived files inside this project's private asset directory may be
  // removed. The user's original hook video is never touched.
  const assetRoot = path.resolve(DATA_DIR, project.id);
  const insideAssetRoot = (file) => {
    if (!file) return false;
    const resolved = path.resolve(file);
    return resolved.startsWith(`${assetRoot}${path.sep}`);
  };
  for (const file of [hook.audioPath, hook.visualPath]) {
    if (insideAssetRoot(file)) await fsp.rm(path.resolve(file), { force: true }).catch(() => {});
  }
  const prefix = `${hookId}_composition_preview_`;
  const entries = await fsp.readdir(assetRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.mp4')) {
      await fsp.rm(path.join(assetRoot, entry.name), { force: true }).catch(() => {});
    }
  }
  await saveProject(project);
  return {
    deleted: true,
    hookId,
    sourceVideoPreserved: true,
    hooks: project.hooks,
    hook: project.hook,
    hookPlans: project.hookPlans || {},
  };
}

async function batchAnalyzeHooks(project, options = {}) {
  const paths = [...new Set((options.paths || []).map((item) => path.resolve(String(item || '').trim())).filter(Boolean))].slice(0, 50);
  if (!paths.length) throw new Error('请至少选择一条钩子视频');
  const results = new Array(paths.length);
  let cursor = 0;
  let completed = 0;
  options.onProgress?.({ done: 0, total: paths.length, current: '' });
  const concurrency = Math.min(paths.length, options.provider === 'glm' ? 3 : 2);
  const worker = async () => {
    while (cursor < paths.length) {
      const index = cursor++;
      const hookPath = paths[index];
      try {
        const hook = await analyzeHook(project, hookPath, { ...options, autoClassify: true, persist: false });
        if (!hook.classification?.needsReview) await confirmHookExtraction(project, hook.classification.hookEnd, hook, false);
        results[index] = { ok: true, hook };
      } catch (error) {
        results[index] = { ok: false, path: hookPath, error: error.message };
      }
      completed += 1;
      options.onProgress?.({ done: completed, total: paths.length, current: path.basename(hookPath) });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const hooks = results.filter((item) => item.ok).map((item) => item.hook);
  const analyzedPaths = new Set(paths);
  const replacedHookIds = (project.hooks || []).filter((item) => analyzedPaths.has(path.resolve(item.path))).map((item) => item.id);
  for (const hookId of replacedHookIds) if (project.hookPlans) delete project.hookPlans[hookId];
  project.hooks = [...(project.hooks || []).filter((item) => !analyzedPaths.has(path.resolve(item.path))), ...hooks];
  const preferred = hooks.find((item) => item.confirmedCut) || hooks[0];
  if (preferred) project.hook = preferred;
  await saveProject(project);
  return {
    hooks,
    failures: results.filter((item) => !item.ok),
    autoConfirmed: hooks.filter((item) => item.confirmedCut).length,
    needsReview: hooks.filter((item) => !item.confirmedCut).length,
  };
}

async function runAutomatedWorkflow(options = {}) {
  const useBroll = options.useBroll !== false;
  const useHooks = Boolean(options.useHooks ?? (options.hookPaths || []).length);
  const useMusic = Boolean(options.useMusic ?? (options.musicPaths || []).length);
  if (!useBroll && !useHooks) throw new Error('请至少启用混剪素材或钩子');
  const project = createProject({
    name: options.name,
    threshold: Number(options.threshold ?? 0.30),
    minDuration: Number(options.minDuration ?? 0.45),
    splitMode: options.splitMode === 'precise' ? 'precise' : 'continuity',
    useBroll,
    useHooks,
    useMusic,
    mixDuration: options.mixDuration,
    outputCount: options.outputCount,
  });
  await fsp.mkdir(path.join(DATA_DIR, project.id), { recursive: true });
  project.workflow = { state: 'processing', startedAt: new Date().toISOString() };
  await saveProject(project);
  const library = await loadLibrary();
  const selectedLibrary = new Set(options.libraryItemIds || []);
  const libraryHookPaths = library.items
    .filter((item) => selectedLibrary.has(item.id) && item.type === 'hook' && item.clipPath && fs.existsSync(item.clipPath))
    .map((item) => item.clipPath);
  const hookPaths = useHooks ? [...new Set([...(options.hookPaths || []), ...libraryHookPaths])] : [];
  if (useHooks && !hookPaths.length) throw new Error('已启用钩子，请至少添加一条钩子视频');
  project.musicTracks = useMusic ? await prepareMusicTracks(options.musicPaths || []) : [];
  if (useMusic && !project.musicTracks.length) throw new Error('已启用音乐，请至少添加一首音乐');
  project.workflowConfig = { useBroll, useHooks, useMusic, mixDuration: Math.max(1, Number(options.mixDuration) || 15), outputCount: Math.max(1, Math.min(50, Number(options.outputCount) || 1)) };
  await saveProject(project);
  const report = (branch, next) => options.onProgress?.({ branch, ...next });
  const brollTask = useBroll && (options.files || []).length
    ? analyzeFiles(options.files || [], { ...project.options, onProgress: (next) => report('broll', next) }, project)
    : Promise.resolve(project);
  const hookTask = hookPaths.length
    ? batchAnalyzeHooks(project, {
      paths: hookPaths,
      threshold: Number(options.hookThreshold ?? 0.16),
      provider: options.provider,
      model: options.model,
      onProgress: (next) => report('hooks', next),
    })
    : Promise.resolve({ hooks: [], failures: [], autoConfirmed: 0, needsReview: 0 });
  try {
    const [, hookBatch] = await Promise.all([brollTask, hookTask]);
    if (useBroll) appendLibraryBroll(project, library, options.libraryItemIds || []);
    if (useBroll && !project.segments.length) throw new Error('已启用混剪素材，请上传素材或从星标库手动选择');
    const confirmed = (hookBatch.hooks || []).find((hook) => hook.confirmedCut);
    if (confirmed) project.hook = confirmed;
    const composition = null;
    project.workflow = {
      state: 'ready',
      startedAt: project.workflow.startedAt,
      completedAt: new Date().toISOString(),
      brollCount: project.segments.length,
      hookCount: hookBatch.hooks.length,
      autoConfirmed: hookBatch.autoConfirmed,
      needsReview: hookBatch.needsReview,
      mode: !useHooks ? 'mix-only' : !useBroll ? 'hook-only' : 'hook-mix',
    };
    await saveProject(project);
    options.onProgress?.({ branch: 'complete', done: 1, total: 1, current: '' });
    return { project, hookBatch, composition };
  } catch (error) {
    project.workflow = { ...project.workflow, state: 'failed', error: error.message, completedAt: new Date().toISOString() };
    await saveProject(project).catch(() => {});
    throw error;
  }
}

async function selectProjectHook(project, hookId) {
  const hook = (project.hooks || []).find((item) => item.id === hookId);
  if (!hook) throw new Error('钩子记录不存在');
  project.hook = hook;
  await saveProject(project);
  return hook;
}

function transitionDuration(type) {
  if (type === 'black') return 0.14;
  if (type === 'dissolve') return 0.24;
  return 0;
}

function stableRank(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) / 0xffffffff;
}

function usedHookSegmentIds(project, excludingHookId = '') {
  const used = new Set();
  for (const [hookId, plan] of Object.entries(project.hookPlans || {})) {
    if (hookId === excludingHookId) continue;
    if (!plan?.confirmed) continue;
    for (const clip of plan?.clips || []) used.add(clip.segmentId);
  }
  return used;
}

function musicIdForPlan(project, plan) {
  return String(plan?.musicId || project.musicTracks?.[0]?.id || '');
}

function usedMusicRanges(project, excludingTaskId = '', musicId = '') {
  const ranges = [];
  for (const [taskId, plan] of Object.entries(project.hookPlans || {})) {
    if (taskId === excludingTaskId || !plan?.confirmed || musicIdForPlan(project, plan) !== musicId) continue;
    const duration = Math.max(0, Number(plan.mixDuration) || 0);
    if (!duration) continue;
    const start = Math.max(0, Number(plan.musicStart) || 0);
    ranges.push({ taskId, start, end: start + duration });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function mergeMusicRanges(ranges, limit = Infinity) {
  const merged = [];
  for (const range of ranges) {
    const start = Math.max(0, Math.min(Number(range.start) || 0, limit));
    const end = Math.max(start, Math.min(Number(range.end) || 0, limit));
    const previous = merged[merged.length - 1];
    if (previous && start <= previous.end + 0.001) previous.end = Math.max(previous.end, end);
    else merged.push({ start, end });
  }
  return merged;
}

function freeMusicRanges(trackDuration, usedRanges, needed) {
  const duration = Math.max(0, Number(trackDuration) || 0);
  const occupied = mergeMusicRanges(usedRanges, duration);
  const free = [];
  let cursor = 0;
  for (const range of occupied) {
    if (range.start - cursor >= needed) free.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (duration - cursor >= needed) free.push({ start: cursor, end: duration });
  return free;
}

function chooseAutoMusicPlacement(project, taskId, needed, seed) {
  const tracks = (project.musicTracks || []).filter((track) => fs.existsSync(track.path) && Number(track.duration) >= needed);
  const placements = [];
  for (const track of tracks) {
    const gaps = freeMusicRanges(track.duration, usedMusicRanges(project, taskId, track.id), needed);
    const waveform = Array.isArray(track.waveform) ? track.waveform : [];
    for (const [gapIndex, gap] of gaps.entries()) {
      const latest = Math.max(gap.start, gap.end - needed);
      const span = Math.max(0, latest - gap.start);
      let best = {
        start: gap.start + span * stableRank(`${seed}:${track.id}:${gapIndex}:start`),
        score: stableRank(`${seed}:${track.id}:${gapIndex}:base`),
      };
      waveform.forEach((value, index) => {
        const time = Number(track.duration) * index / Math.max(1, waveform.length - 1);
        if (time < gap.start || time > latest) return;
        const score = Math.max(0, Number(value) || 0) * 0.38 + stableRank(`${seed}:${track.id}:${index}`) * 0.62;
        if (score > best.score) best = { start: time, score };
      });
      placements.push({ musicId: track.id, musicStart: Number(best.start.toFixed(3)), score: best.score });
    }
  }
  if (!placements.length) return null;
  placements.sort((a, b) => b.score - a.score);
  return { ...placements[0], musicAuto: true, musicReuseTaskIds: [] };
}

function sanitizeHookClips(project, clips) {
  const seen = new Set();
  const sanitized = [];
  for (const item of Array.isArray(clips) ? clips : []) {
    const segment = project.segments.find((entry) => entry.id === item.segmentId);
    if (!segment || seen.has(segment.id)) continue;
    const source = project.files.find((entry) => entry.id === segment.fileId);
    seen.add(segment.id);
    const requestedDuration = Math.min(Number(item.duration) || segment.duration, Number(segment.duration));
    const renderSafeDuration = requestedDuration < 0.35 && Number(segment.duration) >= 0.35
      ? Math.min(0.35, Number(segment.duration))
      : requestedDuration;
    sanitized.push({
      segmentId: segment.id,
      duration: Number(Math.max(1 / 30, renderSafeDuration).toFixed(3)),
      transition: ['cut', 'black', 'dissolve'].includes(item.transition) ? item.transition : 'cut',
      auto: Boolean(item.auto),
      layout: segment.layout || source?.layout || layoutForDimensions(source?.width, source?.height),
    });
  }
  return sanitized;
}

function storeHookPlans(project, requestedPlans) {
  const next = { ...(project.hookPlans || {}) };
  const validSegmentIds = new Set((project.segments || []).map((segment) => segment.id));
  for (const [hookId, value] of Object.entries(requestedPlans || {})) {
    const isMixTask = /^mix_\d+$/.test(hookId);
    if (!isMixTask && !(project.hooks || []).some((hook) => hook.id === hookId)) throw new Error(`组合方案对应的成片任务不存在：${hookId}`);
    next[hookId] = {
      ...(next[hookId] || {}),
      hookId,
      clips: sanitizeHookClips(project, value?.clips || value),
      shuffleSeed: String(value?.shuffleSeed || crypto.randomBytes(6).toString('hex')),
      previewReady: Boolean(value?.previewReady),
      confirmed: Boolean(value?.confirmed),
      mixDuration: Math.max(0, Number(value?.mixDuration ?? project.workflowConfig?.mixDuration) || 0),
      useHook: value?.useHook !== false,
      musicId: String(value?.musicId || ''),
      musicStart: Math.max(0, Number(value?.musicStart) || 0),
      musicAuto: Boolean(value?.musicAuto),
      musicReuseTaskIds: [...new Set((Array.isArray(value?.musicReuseTaskIds) ? value.musicReuseTaskIds : []).map(String))].filter((taskId) => taskId && taskId !== hookId),
      segmentReuseIds: [...new Set((Array.isArray(value?.segmentReuseIds) ? value.segmentReuseIds : []).map(String))].filter((segmentId) => validSegmentIds.has(segmentId)),
      musicFadeOut: value?.musicFadeOut !== false,
      updatedAt: new Date().toISOString(),
    };
  }
  const owners = new Map();
  for (const [hookId, plan] of Object.entries(next)) {
    if (!plan.confirmed) continue;
    for (const clip of plan.clips || []) {
      if (!owners.has(clip.segmentId)) owners.set(clip.segmentId, []);
      owners.get(clip.segmentId).push(hookId);
    }
  }
  for (const [segmentId, hookIds] of owners) {
    if (hookIds.length <= 1) continue;
    const withoutReusePermission = hookIds.filter((hookId) => !(next[hookId].segmentReuseIds || []).includes(segmentId));
    if (withoutReusePermission.length > 1) throw new Error(`空镜片段 ${segmentId} 已被另一条钩子占用；请双击灰色片段重新激活，或重新随机铺满`);
  }
  project.hookPlans = next;
  return next;
}

function buildAutoHookClips(project, hook, options = {}) {
  const needed = Math.max(0, Number(options.mixDuration ?? project.workflowConfig?.mixDuration) || 15);
  const excluded = options.excludedSegmentIds instanceof Set ? options.excludedSegmentIds : new Set(options.excludedSegmentIds || []);
  const shuffleSeed = String(options.shuffleSeed || crypto.randomBytes(8).toString('hex'));
  const candidates = project.segments.map((segment) => {
    const source = project.files.find((file) => file.id === segment.fileId);
    const layout = segment.layout || source?.layout || layoutForDimensions(source?.width, source?.height);
    return source && fs.existsSync(source.path) ? { segment, source, layout } : null;
  }).filter((item) => item && !excluded.has(item.segment.id));
  if (!candidates.length) {
    if (options.allowShort) return [];
    throw new Error('未被其他钩子使用的空镜已经不足；请补充素材后再生成这一条组合');
  }
  const layouts = [...new Set(candidates.map((item) => item.layout))];
  const preferredLayout = layouts.length === 1
    ? layouts[0]
    : stableRank(`${shuffleSeed}:layout`) < 0.5 ? 'portrait' : 'triple';
  const pool = [...candidates];
  const clips = [];
  let covered = 0;
  let previousItem = null;
  let sourceRun = 0;
  while (covered < needed - 1 / 30 && pool.length) {
    const remaining = needed - covered;
    if (remaining < 0.35 && clips.length) {
      const lastClip = clips[clips.length - 1];
      const lastSegment = project.segments.find((segment) => segment.id === lastClip.segmentId);
      const capacity = Math.max(0, Number(lastSegment?.duration || 0) - Number(lastClip.duration || 0));
      if (capacity >= remaining) {
        lastClip.duration = Number((Number(lastClip.duration) + remaining).toFixed(3));
        covered += remaining;
        break;
      }
    }
    const target = Math.max(0.55, Math.min(3.2, remaining + 0.24));
    let bestIndex = 0;
    let bestScore = Infinity;
    for (let index = 0; index < pool.length; index += 1) {
      const item = pool[index];
      const usableDuration = Math.min(Number(item.segment.duration), target);
      const sameSource = item.source.id === previousItem?.source.id;
      const directlyContinues = sameSource && Number(item.segment.index) === Number(previousItem?.segment.index) + 1;
      const continuityBonus = directlyContinues && sourceRun < 3 ? -1.25 : sameSource ? 0.75 : 0;
      const layoutSwitchPenalty = previousItem && item.layout !== previousItem.layout ? 6 : 0;
      const preferredLayoutPenalty = item.layout === preferredLayout ? 0 : 1.8;
      const score = Math.abs(usableDuration - target) * 0.35
        + layoutSwitchPenalty
        + preferredLayoutPenalty
        + continuityBonus
        + stableRank(`${shuffleSeed}:${item.segment.id}`) * 2.4;
      if (score < bestScore) { bestScore = score; bestIndex = index; }
    }
    const item = pool.splice(bestIndex, 1)[0];
    const transition = 'cut';
    const overlap = transitionDuration(transition);
    const take = Math.min(Number(item.segment.duration), remaining + overlap, 3.2);
    clips.push({ segmentId: item.segment.id, duration: Number(take.toFixed(3)), transition, auto: true, layout: item.layout });
    covered += Math.max(0, take - overlap);
    sourceRun = item.source.id === previousItem?.source.id ? sourceRun + 1 : 1;
    previousItem = item;
  }
  if (covered < needed - 1 / 30 && !options.allowShort) throw new Error(`排除其他钩子已使用的片段后，空镜还缺少 ${(needed - covered).toFixed(2)} 秒；为保证不重复，本条未生成`);
  return clips;
}

function compositionClipCoverage(project, clips, targetDuration) {
  const frame = 1 / 30;
  const target = Math.max(0, Number(targetDuration) || 0);
  let covered = 0;
  for (const item of sanitizeHookClips(project, clips)) {
    if (covered >= target - frame / 2) break;
    const segment = project.segments.find((entry) => entry.id === item.segmentId);
    const source = segment && project.files.find((entry) => entry.id === segment.fileId);
    if (!segment || !source || !fs.existsSync(source.path)) continue;
    const maxDuration = Math.max(frame, Math.min(Number(item.duration) || segment.duration, segment.duration));
    const type = ['cut', 'black', 'dissolve'].includes(item.transition) ? item.transition : 'cut';
    let transition = Math.min(transitionDuration(type), Math.max(0, covered - frame), Math.max(0, maxDuration - frame));
    const take = Math.min(maxDuration, target - covered + transition);
    transition = Math.min(transition, Math.max(0, take - frame));
    if (take > frame / 2) covered += take - transition;
  }
  return Math.max(0, Math.min(target, covered));
}

function createAutoHookComposition(project, hookId, options = {}) {
  const taskId = String(options.taskId || hookId || '');
  const hook = hookId ? (project.hooks || []).find((item) => item.id === hookId) : null;
  const isMixOnly = /^mix_\d+$/.test(taskId) && !hook;
  if (!isMixOnly && !hook?.confirmedCut) throw new Error('请先完成钩子识别；低置信度钩子需要人工确认');
  if (!project.workflowConfig?.useBroll) {
    const plan = { hookId: taskId, clips: [], mixDuration: 0, useHook: !isMixOnly && options.useHook !== false, musicFadeOut: options.musicFadeOut !== false, confirmed: true, previewReady: false, updatedAt: new Date().toISOString() };
    storeHookPlans(project, { [taskId]: plan });
    return project.hookPlans[taskId];
  }
  const mixDuration = Math.max(1, Number(options.mixDuration ?? project.hookPlans?.[taskId]?.mixDuration ?? project.workflowConfig?.mixDuration) || 15);
  const shuffleSeed = crypto.randomBytes(8).toString('hex');
  const previousPlan = project.hookPlans?.[taskId] || null;
  const excluded = usedHookSegmentIds(project, taskId);
  const clips = buildAutoHookClips(project, hook, { excludedSegmentIds: excluded, shuffleSeed, mixDuration, allowShort: Boolean(options.allowShort) });
  const musicPlacement = previousPlan?.musicId
    ? {
      musicId: previousPlan.musicId,
      musicStart: Math.max(0, Number(previousPlan.musicStart) || 0),
      musicAuto: Boolean(previousPlan.musicAuto),
      musicReuseTaskIds: previousPlan.musicReuseTaskIds || [],
    }
    : chooseAutoMusicPlacement(project, taskId, mixDuration, shuffleSeed);
  const plan = {
    hookId: taskId,
    clips,
    shuffleSeed,
    previewReady: false,
    confirmed: true,
    hookDuration: hook ? hook.confirmedCut : 0,
    hookCut: hook ? hook.confirmedCut : 0,
    mixDuration,
    useHook: !isMixOnly && (options.useHook ?? project.hookPlans?.[taskId]?.useHook) !== false,
    needed: mixDuration,
    musicId: musicPlacement?.musicId || project.musicTracks?.[0]?.id || '',
    musicStart: Number(musicPlacement?.musicStart) || 0,
    musicAuto: Boolean(musicPlacement?.musicAuto),
    musicReuseTaskIds: musicPlacement?.musicReuseTaskIds || [],
    musicFadeOut: project.hookPlans?.[taskId]?.musicFadeOut !== false,
    updatedAt: new Date().toISOString(),
  };
  storeHookPlans(project, { [taskId]: plan });
  return project.hookPlans[taskId];
}

async function exportHookRemix(project, options = {}) {
  if (!FFMPEG) throw new Error('未找到 FFmpeg');
  const hook = options.hookId ? (project.hooks || []).find((item) => item.id === options.hookId) : project.hook;
  if (!hook?.path || !fs.existsSync(hook.path)) throw new Error('请先分析一条钩子视频');
  if (!hook.confirmedCut) throw new Error('请先确认钩子结束帧');
  if (!hook.audioPath || !fs.existsSync(hook.audioPath)) throw new Error('提取的钩子音乐不存在，请重新提取');
  const fps = 30;
  const frame = 1 / fps;
  const duration = Number(hook.info?.duration) || 0;
  const hookCut = Math.max(frame, Math.min(Number(hook.confirmedCut), duration - frame));
  let requested = Array.isArray(options.clips) && options.clips.length
    ? sanitizeHookClips(project, options.clips)
    : sanitizeHookClips(project, project.hookPlans?.[hook.id]?.clips || []);
  if (!requested.length) {
    const generated = createAutoHookComposition(project, hook.id);
    requested = generated.clips;
    await saveProject(project);
  }

  const pieces = [];
  let chainDuration = hookCut;
  for (const item of requested) {
    if (chainDuration >= duration - frame / 2) break;
    const segment = project.segments.find((entry) => entry.id === item.segmentId);
    if (!segment) continue;
    const source = project.files.find((entry) => entry.id === segment.fileId);
    if (!source || !fs.existsSync(source.path)) continue;
    const maxDuration = Math.max(frame, Math.min(Number(item.duration) || segment.duration, segment.duration));
    const type = ['cut', 'black', 'dissolve'].includes(item.transition) ? item.transition : 'cut';
    let transition = Math.min(transitionDuration(type), Math.max(0, chainDuration - frame), Math.max(0, maxDuration - frame));
    const remaining = duration - chainDuration;
    const take = Math.min(maxDuration, remaining + transition);
    transition = Math.min(transition, Math.max(0, take - frame));
    if (take <= frame / 2) continue;
    const layout = segment.layout || source.layout || layoutForDimensions(source.width, source.height);
    pieces.push({ segment, source, take, transition, type, layout });
    chainDuration += take - transition;
  }
  if (chainDuration < duration - frame && pieces.length) {
    const last = pieces[pieces.length - 1];
    const missing = duration - chainDuration;
    const capacity = Math.max(0, Number(last.segment.duration) - Number(last.take));
    const extension = Math.min(missing, capacity);
    if (extension > 0) {
      last.take = Number((last.take + extension).toFixed(6));
      chainDuration += extension;
    }
  }
  if (chainDuration < duration - frame) {
    throw new Error(`空镜画面还差 ${(duration - chainDuration).toFixed(2)} 秒，继续选择镜头后再导出`);
  }

  const preview = Boolean(options.preview);
  const outputDir = preview
    ? path.join(DATA_DIR, project.id)
    : path.resolve(options.outputDir || path.join(path.dirname(hook.path), 'HoMix钩子成片'));
  await fsp.mkdir(outputDir, { recursive: true });
  const output = preview
    ? path.join(outputDir, `${hook.id}_composition_preview_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.mp4`)
    : path.join(outputDir, `${safeName(path.parse(hook.name).name)}_换画面_${Date.now()}.mp4`);
  const sourceWidth = Math.max(2, Number(hook.info.width) || 1080);
  const sourceHeight = Math.max(2, Number(hook.info.height) || 1920);
  const previewScale = preview ? Math.min(1, 720 / Math.max(sourceWidth, sourceHeight)) : 1;
  const width = Math.max(2, Math.round(sourceWidth * previewScale / 2) * 2);
  const height = Math.max(2, Math.round(sourceHeight * previewScale / 2) * 2);
  // Always decode the original hook. Older deferred visual files may be empty or
  // locked by WebView2 and were the source of intermittent "received no packets" errors.
  const visualPath = hook.path;
  const audioPath = hook.audioPath;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', visualPath, '-i', audioPath];
  for (const piece of pieces) {
    args.push('-ss', String(piece.segment.start), '-t', String(piece.take), '-i', piece.source.path);
  }
  const normalize = (input, length, outputLabel) => `[${input}:v]trim=duration=${length.toFixed(6)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps},settb=AVTB,format=yuv420p[${outputLabel}]`;
  const filters = [normalize(0, hookCut, 'v0')];
  // yuv420p requires even chroma dimensions. 1280 / 3 rounds to 427, which
  // previews at 720p did not expose but full-size exports could not encode.
  const bandHeight = Math.ceil(height / 6) * 2;
  pieces.forEach((piece, index) => {
    const input = index + 2;
    const outputLabel = `v${index + 1}`;
    if (piece.layout !== 'triple' || height <= width) {
      filters.push(normalize(input, piece.take, outputLabel));
      return;
    }
    const band = `t${index}band`;
    const a = `t${index}a`;
    const b = `t${index}b`;
    const c = `t${index}c`;
    filters.push(`[${input}:v]trim=duration=${piece.take.toFixed(6)},setpts=PTS-STARTPTS,scale=${width}:${bandHeight}:force_original_aspect_ratio=increase,crop=${width}:${bandHeight},setsar=1,fps=${fps},settb=AVTB,format=yuv420p[${band}]`);
    filters.push(`[${band}]split=3[${a}][${b}][${c}]`);
    filters.push(`[${a}][${b}][${c}]vstack=inputs=3,crop=${width}:${height}:0:0,setsar=1,fps=${fps},settb=AVTB,format=yuv420p[${outputLabel}]`);
  });
  let current = 'v0';
  let currentDuration = hookCut;
  pieces.forEach((piece, index) => {
    const next = `v${index + 1}`;
    const out = `mix${index + 1}`;
    if (piece.transition > 0) {
      const effect = piece.type === 'black' ? 'fadeblack' : 'fade';
      const offset = Math.max(0, currentDuration - piece.transition);
      filters.push(`[${current}][${next}]xfade=transition=${effect}:duration=${piece.transition.toFixed(6)}:offset=${offset.toFixed(6)}[${out}]`);
      currentDuration += piece.take - piece.transition;
    } else {
      filters.push(`[${current}][${next}]concat=n=2:v=1:a=0[${out}]`);
      currentDuration += piece.take;
    }
    current = out;
  });
  filters.push(`[1:a:0]atrim=duration=${duration.toFixed(6)},asetpts=PTS-STARTPTS[aout]`);
  args.push(
    '-filter_complex', filters.join(';'), '-map', `[${current}]`, '-map', '[aout]',
    '-t', String(duration), '-c:v', 'libx264', '-preset', preview ? 'ultrafast' : 'fast', '-crf', preview ? '27' : '19',
    '-threads', preview ? '2' : '0',
    '-c:a', 'aac', '-b:a', preview ? '128k' : '192k', '-movflags', '+faststart', '-y', output,
  );
  try {
    await run(FFMPEG, args, { signal: options.signal });
  } catch (error) {
    await fsp.rm(output, { force: true }).catch(() => {});
    if (error.code === 'PREVIEW_ABORTED') throw error;
    const detail = String(error.stderr || error.message || '未知错误').trim();
    if (/input link.*parameters.*do not match|failed to configure output pad|error reinitializing filters/i.test(detail)) {
      throw Object.assign(new Error('预览画面格式不一致，系统已统一画面比例；请重新生成当前预览'), { detail });
    }
    if (/could not open encoder before eof/i.test(detail)) {
      throw Object.assign(new Error('预览编码器未能启动；旧预览任务已停止，请重新生成当前预览'), { detail });
    }
    if (/received no packets|nothing was written into output/i.test(detail)) {
      throw Object.assign(new Error('预览生成失败：某个空镜片段在当前入点没有读到画面，请点“重新自动铺满”后再试'), { detail });
    }
    if (/permission denied|being used by another process/i.test(detail)) {
      throw new Error('预览文件正被播放器占用，请稍候重试');
    }
    throw new Error(`预览生成失败：${detail.split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 260)}`);
  }
  if (preview) {
    const prefix = `${hook.id}_composition_preview_`;
    const old = (await fsp.readdir(outputDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.mp4'))
      .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(outputDir, entry.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(5);
    for (const item of old) await fsp.rm(path.join(outputDir, item.name), { force: true }).catch(() => {});
  }
  return {
    hookId: hook.id,
    hookName: hook.name,
    output,
    outputDir,
    duration,
    hookCut,
    clipCount: pieces.length,
    audioPreserved: true,
    transitions: pieces.map((piece) => piece.type),
    clips: pieces.map((piece) => ({ segmentId: piece.segment.id, duration: Number(piece.take.toFixed(3)), transition: piece.type, layout: piece.layout })),
    autoFilled: !(Array.isArray(options.clips) && options.clips.length),
    preview,
    previewUrl: preview ? `/api/hook/rendered-preview?project=${encodeURIComponent(project.id)}&hook=${encodeURIComponent(hook.id)}&file=${encodeURIComponent(path.basename(output))}` : '',
  };
}

async function exportCompositionTask(project, options = {}) {
  if (!FFMPEG) throw new Error('未找到 FFmpeg');
  const taskId = String(options.taskId || options.hookId || '');
  const hook = options.hookId ? (project.hooks || []).find((item) => item.id === options.hookId) : null;
  const isMixOnly = /^mix_\d+$/.test(taskId) && !hook;
  if (!isMixOnly && !hook?.confirmedCut) throw new Error('请先完成钩子识别');
  const useBroll = project.workflowConfig?.useBroll !== false;
  const savedPlan = project.hookPlans?.[taskId] || {};
  const useHook = !isMixOnly && Boolean(hook) && (options.useHook ?? savedPlan.useHook) !== false;
  const hookCut = useHook ? Number(hook.confirmedCut) : 0;
  const musicFadeOut = (options.musicFadeOut ?? savedPlan.musicFadeOut) !== false;
  const requestedMixDuration = useBroll ? Math.max(1, Number(options.mixDuration ?? savedPlan.mixDuration ?? project.workflowConfig?.mixDuration) || 15) : 0;
  let mixDuration = requestedMixDuration;

  let requested = sanitizeHookClips(project, Array.isArray(options.clips) ? options.clips : savedPlan.clips || []);
  if (useBroll && !requested.length) {
    requested = createAutoHookComposition(project, hook?.id || null, { taskId, mixDuration, allowShort: Boolean(options.allowShortDuration) }).clips;
    await saveProject(project);
  }
  const frame = 1 / 30;
  const pieces = [];
  let covered = 0;
  for (const item of requested) {
    if (covered >= mixDuration - frame / 2) break;
    const segment = project.segments.find((entry) => entry.id === item.segmentId);
    const source = segment && project.files.find((entry) => entry.id === segment.fileId);
    if (!segment || !source || !fs.existsSync(source.path)) continue;
    const maxDuration = Math.max(frame, Math.min(Number(item.duration) || segment.duration, segment.duration));
    const type = ['cut', 'black', 'dissolve'].includes(item.transition) ? item.transition : 'cut';
    let transition = Math.min(transitionDuration(type), Math.max(0, covered - frame), Math.max(0, maxDuration - frame));
    const take = Math.min(maxDuration, mixDuration - covered + transition);
    transition = Math.min(transition, Math.max(0, take - frame));
    if (take <= frame / 2) continue;
    pieces.push({ segment, source, take, transition, type, layout: segment.layout || source.layout || layoutForDimensions(source.width, source.height) });
    covered += take - transition;
  }
  const shortfall = useBroll ? Math.max(0, requestedMixDuration - covered) : 0;
  if (shortfall > frame && !options.allowShortDuration) throw new Error(`混剪画面还差 ${shortfall.toFixed(2)} 秒，请添加或延长片段`);
  if (shortfall > frame && options.allowShortDuration) mixDuration = Math.max(0, covered);
  const duration = hookCut + mixDuration;
  if (duration <= frame / 2 || (!useHook && !pieces.length)) throw new Error('没有可用于导出的有效画面');

  const preview = Boolean(options.preview);
  const referencePath = useHook ? hook.path : pieces[0]?.source.path;
  const outputDir = preview
    ? path.join(DATA_DIR, project.id)
    : path.resolve(options.outputDir || path.join(path.dirname(referencePath), 'HoMix成片'));
  await fsp.mkdir(outputDir, { recursive: true });
  const prefix = `${taskId}_composition_preview_`;
  const output = preview
    ? path.join(outputDir, `${prefix}${Date.now()}_${crypto.randomBytes(3).toString('hex')}.mp4`)
    : path.join(outputDir, `${safeName(useHook ? path.parse(hook.name).name : `${hook ? path.parse(hook.name).name : taskId.replace('_', ' ')}_纯混剪`)}_${Date.now()}.mp4`);

  const baseWidth = useHook ? Number(hook.info?.width) : Number(pieces[0]?.source.width);
  const baseHeight = useHook ? Number(hook.info?.height) : Number(pieces[0]?.source.height);
  const portrait = !useHook && baseWidth > baseHeight;
  const sourceWidth = portrait ? 1080 : Math.max(2, baseWidth || 1080);
  const sourceHeight = portrait ? 1920 : Math.max(2, baseHeight || 1920);
  const previewScale = preview ? Math.min(1, 720 / Math.max(sourceWidth, sourceHeight)) : 1;
  const width = Math.max(2, Math.round(sourceWidth * previewScale / 2) * 2);
  const height = Math.max(2, Math.round(sourceHeight * previewScale / 2) * 2);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  let inputIndex = 0;
  let hookInput = -1;
  if (useHook) {
    hookInput = inputIndex++;
    args.push('-i', hook.path);
  }
  const selectedMusicId = String(options.musicId || savedPlan.musicId || project.musicTracks?.[0]?.id || '');
  const music = project.workflowConfig?.useMusic ? project.musicTracks?.find((item) => item.id === selectedMusicId) || project.musicTracks?.[0] : null;
  let musicInput = -1;
  let musicStart = Math.max(0, Number(options.musicStart ?? savedPlan.musicStart) || 0);
  if (music && mixDuration > 0) {
    musicStart = Math.min(musicStart, Math.max(0, Number(music.duration) - mixDuration));
    const allowedOwners = new Set((Array.isArray(options.musicReuseTaskIds) ? options.musicReuseTaskIds : savedPlan.musicReuseTaskIds || []).map(String));
    const conflicts = usedMusicRanges(project, taskId, music.id).filter((range) => range.start < musicStart + mixDuration - 0.001 && range.end > musicStart + 0.001 && !allowedOwners.has(range.taskId));
    if (conflicts.length) throw new Error('当前音乐片段已被其他成片使用；请调整音乐入点，或双击波形中的灰色区间重新激活');
    musicInput = inputIndex++;
    args.push('-ss', String(musicStart), '-t', String(mixDuration), '-i', music.path);
  }
  for (const piece of pieces) {
    piece.input = inputIndex++;
    args.push('-ss', String(piece.segment.start), '-t', String(piece.take), '-i', piece.source.path);
  }

  const fps = 30;
  const normalize = (input, length, outputLabel) => `[${input}:v]trim=duration=${length.toFixed(6)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps},settb=AVTB,format=yuv420p[${outputLabel}]`;
  const filters = [];
  let current = '';
  let currentDuration = 0;
  if (useHook) {
    filters.push(normalize(hookInput, hookCut, 'vhook'));
    current = 'vhook';
    currentDuration = hookCut;
  }
  const bandHeight = Math.ceil(height / 6) * 2;
  pieces.forEach((piece, index) => {
    const outputLabel = `vpiece${index}`;
    if (piece.layout !== 'triple' || height <= width) filters.push(normalize(piece.input, piece.take, outputLabel));
    else {
      const band = `p${index}band`;
      filters.push(`[${piece.input}:v]trim=duration=${piece.take.toFixed(6)},setpts=PTS-STARTPTS,scale=${width}:${bandHeight}:force_original_aspect_ratio=increase,crop=${width}:${bandHeight},setsar=1,fps=${fps},settb=AVTB,format=yuv420p[${band}]`);
      filters.push(`[${band}]split=3[p${index}a][p${index}b][p${index}c]`);
      filters.push(`[p${index}a][p${index}b][p${index}c]vstack=inputs=3,crop=${width}:${height}:0:0,setsar=1,fps=${fps},settb=AVTB,format=yuv420p[${outputLabel}]`);
    }
    if (!current) {
      current = outputLabel;
      currentDuration = piece.take;
      return;
    }
    const out = `vmix${index}`;
    if (piece.transition > 0) {
      const effect = piece.type === 'black' ? 'fadeblack' : 'fade';
      filters.push(`[${current}][${outputLabel}]xfade=transition=${effect}:duration=${piece.transition.toFixed(6)}:offset=${Math.max(0, currentDuration - piece.transition).toFixed(6)}[${out}]`);
      currentDuration += piece.take - piece.transition;
    } else {
      filters.push(`[${current}][${outputLabel}]concat=n=2:v=1:a=0[${out}]`);
      currentDuration += piece.take;
    }
    current = out;
  });

  if (useHook) filters.push(`[${hookInput}:a:0]atrim=duration=${hookCut.toFixed(6)},asetpts=PTS-STARTPTS[ahook]`);
  if (mixDuration > 0) {
    if (musicInput >= 0) {
      const fade = musicFadeOut ? `,afade=t=out:st=${Math.max(0, mixDuration - .5).toFixed(6)}:d=${Math.min(.5, mixDuration).toFixed(6)}` : '';
      filters.push(`[${musicInput}:a:0]atrim=duration=${mixDuration.toFixed(6)},asetpts=PTS-STARTPTS${fade}[amix]`);
    }
    else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${mixDuration.toFixed(6)},asetpts=PTS-STARTPTS[amix]`);
  }
  let audioLabel = useHook ? 'ahook' : 'amix';
  if (useHook && mixDuration > 0) {
    filters.push('[ahook][amix]concat=n=2:v=0:a=1[aout]');
    audioLabel = 'aout';
  }
  args.push('-filter_complex', filters.join(';'), '-map', `[${current}]`, '-map', `[${audioLabel}]`, '-t', String(duration),
    '-c:v', 'libx264', '-preset', preview ? 'ultrafast' : 'fast', '-crf', preview ? '27' : '19', '-threads', preview ? '2' : '0',
    '-c:a', 'aac', '-b:a', preview ? '128k' : '192k', '-movflags', '+faststart', '-y', output);
  try { await run(FFMPEG, args, { signal: options.signal }); }
  catch (error) {
    await fsp.rm(output, { force: true }).catch(() => {});
    if (error.code === 'PREVIEW_ABORTED') throw error;
    throw new Error(`成片生成失败：${String(error.stderr || error.message).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 300)}`);
  }
  return {
    taskId, hookId: hook?.id || '', hookName: hook?.name || taskId.replace('_', ' '), output, outputDir,
    duration, useHook, hookCut, mixDuration, requestedMixDuration, shortfall, clipCount: pieces.length, musicId: music?.id || '', musicStart, musicFadeOut,
    musicReuseTaskIds: Array.isArray(options.musicReuseTaskIds) ? options.musicReuseTaskIds : savedPlan.musicReuseTaskIds || [],
    clips: pieces.map((piece) => ({ segmentId: piece.segment.id, duration: Number(piece.take.toFixed(3)), transition: piece.type, layout: piece.layout })),
    preview, previewUrl: preview ? `/api/hook/rendered-preview?project=${encodeURIComponent(project.id)}&task=${encodeURIComponent(taskId)}&file=${encodeURIComponent(path.basename(output))}` : '',
  };
}

async function batchExportHooks(project, options = {}) {
  const hooks = (project.hooks || []).filter((hook) => hook.confirmedCut && hook.humanReviewedAt);
  const tasks = project.workflowConfig?.useHooks
    ? hooks.map((hook) => ({ taskId: hook.id, hook }))
    : Array.from({ length: project.workflowConfig?.outputCount || 1 }, (_, index) => ({ taskId: `mix_${index + 1}`, hook: null }));
  if (!tasks.length) throw new Error('没有可导出的成片任务');
  options.onProgress?.({ phase: 'preparing', total: tasks.length, completed: 0, succeeded: 0, failed: 0, currentName: '' });
  for (const task of tasks) {
    if (!project.workflowConfig?.useBroll) continue;
    let plan = project.hookPlans?.[task.taskId];
    if (!plan?.clips?.length) plan = createAutoHookComposition(project, task.hook?.id || null, { taskId: task.taskId, allowShort: true });
  }
  const shortages = tasks.map((task) => {
    const plan = project.hookPlans?.[task.taskId] || {};
    const targetDuration = project.workflowConfig?.useBroll === false ? 0 : Math.max(1, Number(plan.mixDuration ?? project.workflowConfig?.mixDuration) || 15);
    const actualDuration = compositionClipCoverage(project, plan.clips || [], targetDuration);
    return {
      taskId: task.taskId,
      name: task.hook?.name || task.taskId.replace('_', ' '),
      targetDuration,
      actualDuration,
      missingDuration: Math.max(0, targetDuration - actualDuration),
    };
  }).filter((item) => item.missingDuration > 1 / 30);
  await saveProject(project);
  if (shortages.length && !options.allowShortDuration) {
    return { outputs: [], failures: [], requested: tasks.length, confirmationRequired: true, shortages, hookPlans: project.hookPlans };
  }
  const outputs = [];
  const failures = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const currentName = task.hook?.name || task.taskId.replace('_', ' ');
    options.onProgress?.({ phase: 'exporting', total: tasks.length, completed: index, succeeded: outputs.length, failed: failures.length, currentName, currentIndex: index + 1 });
    try {
      let plan = project.hookPlans?.[task.taskId];
      if (project.workflowConfig?.useBroll && !plan?.clips?.length) plan = createAutoHookComposition(project, task.hook?.id || null, { taskId: task.taskId, allowShort: Boolean(options.allowShortDuration) });
      outputs.push(await exportCompositionTask(project, { ...options, taskId: task.taskId, hookId: task.hook?.id, ...(plan || {}) }));
    } catch (error) { failures.push({ hookId: task.hook?.id || '', taskId: task.taskId, name: task.hook?.name || task.taskId, error: error.message }); }
    options.onProgress?.({ phase: 'exporting', total: tasks.length, completed: index + 1, succeeded: outputs.length, failed: failures.length, currentName, currentIndex: index + 1 });
  }
  await saveProject(project);
  return { outputs, failures, requested: tasks.length, confirmationRequired: false, shortages, hookPlans: project.hookPlans };
}

function publicBatchExportJob(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    state: job.state,
    phase: job.phase,
    overall: job.overall,
    total: job.total,
    completed: job.completed,
    succeeded: job.succeeded,
    failed: job.failed,
    currentName: job.currentName,
    currentIndex: job.currentIndex,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.state === 'complete' ? job.result : undefined,
    error: job.state === 'failed' ? job.error : undefined,
  };
}

function startBatchExportJob(project, options = {}) {
  const activeId = ACTIVE_BATCH_EXPORTS.get(project.id);
  const active = activeId ? BATCH_EXPORT_JOBS.get(activeId) : null;
  if (active?.state === 'processing') return active;
  const hooks = (project.hooks || []).filter((hook) => hook.confirmedCut && hook.humanReviewedAt);
  const total = project.workflowConfig?.useHooks
    ? hooks.length
    : Math.max(1, Number(project.workflowConfig?.outputCount) || 1);
  if (!total) throw new Error('没有可导出的成片任务');
  const jobId = `e_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const job = {
    id: jobId,
    projectId: project.id,
    state: 'processing',
    phase: '准备导出',
    overall: 0,
    total,
    completed: 0,
    succeeded: 0,
    failed: 0,
    currentName: '',
    currentIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  BATCH_EXPORT_JOBS.set(jobId, job);
  ACTIVE_BATCH_EXPORTS.set(project.id, jobId);
  const onProgress = (event) => {
    const completed = Math.max(0, Number(event.completed) || 0);
    const eventTotal = Math.max(1, Number(event.total) || job.total);
    Object.assign(job, {
      phase: event.phase === 'preparing' ? '准备导出' : '正在渲染成片',
      total: eventTotal,
      completed,
      succeeded: Math.max(0, Number(event.succeeded) || 0),
      failed: Math.max(0, Number(event.failed) || 0),
      currentName: event.currentName || '',
      currentIndex: Math.max(0, Number(event.currentIndex) || 0),
      overall: Math.min(99, Math.round((completed / eventTotal) * 100)),
      updatedAt: new Date().toISOString(),
    });
  };
  batchExportHooks(project, { ...options, onProgress })
    .then((result) => {
      Object.assign(job, {
        state: 'complete',
        phase: result.confirmationRequired ? '等待时长确认' : '导出完成',
        overall: result.confirmationRequired ? 0 : 100,
        completed: result.confirmationRequired ? 0 : result.requested,
        succeeded: result.outputs?.length || 0,
        failed: result.failures?.length || 0,
        currentName: '',
        result,
        updatedAt: new Date().toISOString(),
      });
    })
    .catch((error) => Object.assign(job, { state: 'failed', phase: '导出失败', error: error.message, updatedAt: new Date().toISOString() }))
    .finally(() => {
      if (ACTIVE_BATCH_EXPORTS.get(project.id) === jobId) ACTIVE_BATCH_EXPORTS.delete(project.id);
    });
  const cleanup = setTimeout(() => BATCH_EXPORT_JOBS.delete(jobId), 6 * 60 * 60 * 1000);
  cleanup.unref?.();
  return job;
}

const CORRUPT_FRAME_PATTERN = /invalid nal unit|missing picture in access unit|error while decoding|corrupt(?:ed)? frame|decode_slice_header error|error submitting packet|concealing \d+ dc|invalid data found when processing input/i;

async function scanSegmentIntegrity(sourcePath, start, duration) {
  let stderr = '';
  try {
    const result = await run(FFMPEG, [
      '-hide_banner', '-loglevel', 'warning', '-nostdin',
      '-ss', String(Math.max(0, Number(start) || 0)), '-i', sourcePath,
      '-t', String(Math.max(0.02, Number(duration) || 0.02)),
      '-map', '0:v:0', '-an', '-f', 'null', '-',
    ]);
    stderr = result.stderr || '';
  } catch (error) {
    stderr = error.stderr || error.message || '';
  }
  const issues = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => CORRUPT_FRAME_PATTERN.test(line));
  return { ok: issues.length === 0, issues: issues.slice(0, 3) };
}

async function assertSegmentIntegrity(sourcePath, start, duration, label) {
  const result = await scanSegmentIntegrity(sourcePath, start, duration);
  if (!result.ok) {
    const detail = result.issues[0].replace(/^.*?\]\s*/, '').slice(0, 180);
    throw new Error(`${label}的源视频存在损坏帧，已阻止导出以避免马赛克。请更换或先修复源文件。${detail ? `检测信息：${detail}` : ''}`);
  }
}

async function exportSegmentFile(project, segment, outputDir, options = {}, filename) {
  if (!FFMPEG) throw new Error('未找到 FFmpeg');
  const source = project.files.find((file) => file.id === segment.fileId);
  if (!source || !fs.existsSync(source.path)) throw new Error('源视频不存在或已移动');
  const extension = '.mp4';
  const output = path.join(outputDir, filename || `${safeName(segment.label)}${extension}`);
  const length = Math.max(0.02, segment.end - segment.start);
  await assertSegmentIntegrity(source.path, segment.start, length, `镜头“${segment.label}”`);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-accurate_seek', '-ss', String(segment.start), '-i', source.path, '-t', String(length), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-fps_mode', 'passthrough', '-c:a', 'aac', '-b:a', '192k', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', output];
  try {
    await run(FFMPEG, args);
    return output;
  } catch (error) {
    await fsp.rm(output, { force: true }).catch(() => {});
    throw new Error(error.stderr?.trim().slice(-500) || error.message);
  }
}

async function exportSegments(project, options) {
  if (!FFMPEG) throw new Error('未找到 FFmpeg');
  const outputDir = path.resolve(options.outputDir || path.join(path.dirname(project.files[0].path), 'HoMix导出'));
  await fsp.mkdir(outputDir, { recursive: true });
  const selected = project.segments.filter((segment) => options.ids?.length ? options.ids.includes(segment.id) : segment.selected);
  if (!selected.length) throw new Error('没有选中的片段');
  const outputs = [];
  const failures = [];
  for (let index = 0; index < selected.length; index += 1) {
    const segment = selected[index];
    const source = project.files.find((file) => file.id === segment.fileId);
    const extension = '.mp4';
    const filename = `${String(index + 1).padStart(3, '0')}_${safeName(segment.label)}${extension}`;
    try {
      outputs.push(await exportSegmentFile(project, segment, outputDir, options, filename));
    } catch (error) {
      failures.push({ segmentId: segment.id, label: segment.label, error: error.message });
    }
  }
  if (!outputs.length) throw new Error(`全部导出失败：${failures[0]?.label || ''} ${failures[0]?.error || ''}`.trim());
  return { outputDir, requested: selected.length, outputs, failures };
}

async function starSegments(projectId, segmentIds) {
  const project = await loadProject(projectId);
  const library = await loadLibrary();
  const ids = [...new Set((Array.isArray(segmentIds) ? segmentIds : [segmentIds]).filter(Boolean))];
  if (!ids.length) throw new Error('请先框选要入库的镜头');
  const items = [];
  const failures = [];
  for (const segmentId of ids) {
    try {
      const segment = project.segments.find((item) => item.id === segmentId);
      if (!segment) throw new Error('镜头不存在');
      const source = project.files.find((file) => file.id === segment.fileId);
      if (!source) throw new Error('源视频信息不存在');
      let entry = library.items.find((item) => item.projectId === projectId && item.segmentId === segmentId);
      if (entry?.clipPath && fs.existsSync(entry.clipPath)) {
        segment.starred = true;
        items.push(publicLibraryItem(entry));
        continue;
      }
      const id = entry?.id || `lib_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const clipPath = await exportSegmentFile(project, segment, LIBRARY_CLIPS_DIR, { accurate: true }, `${id}.mp4`);
      let thumbnailPath = '';
      if (segment.thumbnail) {
        const sourceThumbnail = path.join(DATA_DIR, project.id, path.basename(segment.thumbnail));
        if (fs.existsSync(sourceThumbnail)) {
          thumbnailPath = path.join(LIBRARY_THUMBS_DIR, `${id}.jpg`);
          await fsp.copyFile(sourceThumbnail, thumbnailPath);
        }
      }
      entry = {
        id,
        projectId,
        segmentId,
        label: segment.label,
        sourceName: source.name,
        sourcePath: source.path,
        sourceStart: segment.start,
        sourceEnd: segment.end,
        duration: segment.duration,
        width: source.width,
        height: source.height,
        layout: segment.layout || source.layout || layoutForDimensions(source.width, source.height),
        clipPath,
        thumbnailPath,
        ai: segment.ai || null,
        createdAt: entry?.createdAt || new Date().toISOString(),
      };
      library.items = [entry, ...library.items.filter((item) => item.id !== id)];
      segment.starred = true;
      items.push(publicLibraryItem(entry));
    } catch (error) {
      failures.push({ segmentId, error: error.message });
    }
  }
  await Promise.all([saveLibrary(library), saveProject(project)]);
  if (!items.length) throw new Error(`批量入库失败：${failures[0]?.error || '没有可导出的镜头'}`);
  return { items, failures, requested: ids.length };
}

async function starSegment(projectId, segmentId) {
  const result = await starSegments(projectId, [segmentId]);
  return result.items[0];
}

async function starHook(projectId, hookId) {
  const project = await loadProject(projectId);
  const hook = (project.hooks || []).find((item) => item.id === hookId);
  if (!hook?.confirmedCut || !hook.path || !fs.existsSync(hook.path)) throw new Error('请先确认钩子切点');
  const library = await loadLibrary();
  let entry = library.items.find((item) => item.type === 'hook' && item.projectId === projectId && item.hookId === hookId);
  if (entry?.clipPath && fs.existsSync(entry.clipPath)) return publicLibraryItem(entry);
  const id = entry?.id || `lib_hook_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const clipPath = path.join(LIBRARY_CLIPS_DIR, `${id}.mp4`);
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', hook.path, '-t', String(hook.confirmedCut), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', clipPath]);
  const thumbnailPath = path.join(LIBRARY_THUMBS_DIR, `${id}.jpg`);
  await makeThumbnail(hook.path, Math.min(hook.confirmedCut / 2, Math.max(0.05, hook.confirmedCut - 0.04)), thumbnailPath, 720);
  entry = {
    id, type: 'hook', projectId, hookId, segmentId: '', label: path.parse(hook.name).name,
    sourceName: hook.name, sourcePath: hook.path, sourceStart: 0, sourceEnd: hook.confirmedCut,
    duration: hook.confirmedCut, width: hook.info?.width, height: hook.info?.height,
    layout: layoutForDimensions(hook.info?.width, hook.info?.height), clipPath, thumbnailPath,
    createdAt: entry?.createdAt || new Date().toISOString(),
  };
  library.items = [entry, ...library.items.filter((item) => item.id !== id)];
  hook.starred = true;
  project.hooks = project.hooks.map((item) => item.id === hookId ? hook : item);
  if (project.hook?.id === hookId) project.hook = hook;
  await Promise.all([saveLibrary(library), saveProject(project)]);
  return publicLibraryItem(entry);
}

async function renameLibraryItem(id, label) {
  const library = await loadLibrary();
  const item = library.items.find((entry) => entry.id === id);
  if (!item) throw new Error('素材库片段不存在');
  const nextLabel = String(label || '').trim().slice(0, 120);
  if (!nextLabel) throw new Error('名称不能为空');
  item.label = nextLabel;
  await saveLibrary(library);
  return publicLibraryItem(item);
}

function openInExplorer(target) {
  const resolved = path.resolve(target || LIBRARY_DIR);
  const isFile = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32'
    ? (isFile ? ['/select,', resolved] : [resolved])
    : process.platform === 'darwin' && isFile ? ['-R', resolved] : [resolved];
  const child = spawn(command, args, { shell: false, windowsHide: process.platform === 'win32', detached: true, stdio: 'ignore' });
  child.unref();
  return { path: resolved };
}

function powershellPicker(mode) {
  if (activePicker) return Promise.reject(new Error('文件选择窗口已经打开，请先在任务栏中完成或取消选择'));
  const owner = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Windows.Forms; public sealed class WindowWrapper : IWin32Window { private readonly IntPtr handle; public WindowWrapper(IntPtr handle) { this.handle = handle; } public IntPtr Handle { get { return handle; } } } public static class PickerNativeMethods { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'; [System.Windows.Forms.Application]::EnableVisualStyles(); $handle=[PickerNativeMethods]::GetForegroundWindow(); $owner=New-Object WindowWrapper($handle); if($handle -ne [IntPtr]::Zero){[PickerNativeMethods]::SetForegroundWindow($handle) | Out-Null}; `;
  const dialog = mode === 'folder'
    ? `$d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择文件夹'; try { if($d.ShowDialog($owner) -eq 'OK'){[Console]::OutputEncoding=[Text.Encoding]::UTF8; $d.SelectedPath} } finally { $d.Dispose() }`
    : mode === 'audio'
      ? `$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='选择音乐'; $d.Multiselect=$true; $d.RestoreDirectory=$true; $d.Filter='音频文件|*.mp3;*.wav;*.m4a;*.aac;*.flac;*.ogg;*.wma;*.mp4|所有文件|*.*'; try { if($d.ShowDialog($owner) -eq 'OK'){[Console]::OutputEncoding=[Text.Encoding]::UTF8; $d.FileNames | ConvertTo-Json -Compress} } finally { $d.Dispose() }`
      : `$d=New-Object System.Windows.Forms.OpenFileDialog; $d.Title='选择视频'; $d.Multiselect=$true; $d.RestoreDirectory=$true; $d.Filter='视频文件|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v;*.mts;*.m2ts|所有文件|*.*'; try { if($d.ShowDialog($owner) -eq 'OK'){[Console]::OutputEncoding=[Text.Encoding]::UTF8; $d.FileNames | ConvertTo-Json -Compress} } finally { $d.Dispose() }`;
  const script = owner + dialog;
  activePicker = new Promise((resolve, reject) => {
    const child = spawnHidden('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script]);
    let output = '';
    let error = '';
    child.stdout.on('data', (data) => { output += data.toString('utf8'); });
    child.stderr.on('data', (data) => { error += data.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(error || '文件选择器启动失败'));
      const value = output.trim();
      if (!value) return resolve([]);
      if (mode === 'folder') return resolve([value]);
      try {
        const parsed = JSON.parse(value);
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch { resolve([value]); }
    });
  });
  return activePicker.finally(() => { activePicker = null; });
}

function macosPicker(mode) {
  if (activePicker) return Promise.reject(new Error('文件选择窗口已经打开，请先完成或取消选择'));
  const folderMode = mode === 'folder';
  const types = mode === 'audio' ? "['public.audio', 'public.movie']" : "['public.movie']";
  const prompt = folderMode ? '选择文件夹' : mode === 'audio' ? '选择音乐' : '选择视频';
  const script = folderMode
    ? `const app=Application.currentApplication();app.includeStandardAdditions=true;const item=app.chooseFolder({withPrompt:${JSON.stringify(prompt)}});JSON.stringify([item.toString()]);`
    : `const app=Application.currentApplication();app.includeStandardAdditions=true;const items=app.chooseFile({withPrompt:${JSON.stringify(prompt)},multipleSelectionsAllowed:true,ofType:${types}});JSON.stringify((Array.isArray(items)?items:[items]).map(item=>item.toString()));`;
  activePicker = new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script]);
    let output = '';
    let error = '';
    child.stdout.on('data', (data) => { output += data.toString('utf8'); });
    child.stderr.on('data', (data) => { error += data.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && /-128|User canceled/i.test(error)) return resolve([]);
      if (code !== 0) return reject(new Error(error || '文件选择器启动失败'));
      try { resolve(JSON.parse(output.trim() || '[]')); } catch { resolve([]); }
    });
  });
  return activePicker.finally(() => { activePicker = null; });
}

function nativePicker(mode) {
  if (process.platform === 'win32') return powershellPicker(mode);
  if (process.platform === 'darwin') return macosPicker(mode);
  return Promise.reject(new Error('当前系统不支持文件选择器'));
}

async function listVideosInFolder(root) {
  const extensions = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.mts', '.m2ts']);
  const videos = [];
  const pending = [path.resolve(root)];
  while (pending.length && videos.length < 5000) {
    const current = pending.pop();
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const item = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(item);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) videos.push(item);
    }
  }
  return videos.sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

async function serveMedia(req, res, file, contentType = 'video/mp4') {
  if (!file || !fs.existsSync(file)) return sendError(res, 404, '媒体文件不存在');
  const stat = await fsp.stat(file);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300' });
    return fs.createReadStream(file).pipe(res);
  }
  const match = /bytes=(\d+)-(\d*)/.exec(range);
  if (!match) return sendError(res, 416, 'Range 无效');
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : Math.min(start + 4 * 1024 * 1024, stat.size - 1);
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=300',
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

async function serveVideo(req, res, project, fileId) {
  const source = project.files.find((file) => file.id === fileId);
  if (!source || !fs.existsSync(source.path)) return sendError(res, 404, '视频不存在');
  const contentType = source.path.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
  return serveMedia(req, res, source.path, contentType);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, version: VERSION });
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const ollama = url.searchParams.get('ollama') === '1' ? await ollamaStatus() : uncheckedOllamaStatus();
      const library = await loadLibrary();
      return sendJson(res, 200, { ffmpeg: FFMPEG, ffprobe: FFPROBE, ollama, ai: aiStatus(ollama), version: VERSION, libraryCount: library.items.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/config') {
      const body = await readJson(req);
      if (body.provider === 'glm' || body.provider === 'ollama') runtimeAi.provider = body.provider;
      if (typeof body.glmApiKey === 'string' && body.glmApiKey.trim()) runtimeAi.glmApiKey = body.glmApiKey.trim();
      if (typeof body.glmModel === 'string' && body.glmModel.trim()) runtimeAi.glmModel = body.glmModel.trim().slice(0, 80);
      await saveAiConfig();
      const ollama = runtimeAi.provider === 'ollama' ? await ollamaStatus() : uncheckedOllamaStatus();
      return sendJson(res, 200, aiStatus(ollama));
    }
    if (req.method === 'POST' && url.pathname === '/api/ollama/start') {
      return sendJson(res, 200, await ensureOllamaRunning());
    }
    if (req.method === 'POST' && url.pathname === '/api/ollama/pull') {
      const body = await readJson(req);
      return sendJson(res, 200, await pullOllamaModel(body.model || 'qwen3-vl:4b'));
    }
    if (req.method === 'POST' && url.pathname === '/api/pick') {
      const body = await readJson(req);
      if (body.mode === 'video-folder') {
        const folders = await nativePicker('folder');
        return sendJson(res, 200, { paths: folders[0] ? await listVideosInFolder(folders[0]) : [] });
      }
      return sendJson(res, 200, { paths: await nativePicker(body.mode === 'folder' ? 'folder' : body.mode === 'audio' ? 'audio' : 'files') });
    }
    if (req.method === 'POST' && url.pathname === '/api/list-folder') {
      const body = await readJson(req);
      const requestedFolder = String(body.path || '').trim();
      if (!requestedFolder) return sendError(res, 400, '请选择视频文件夹');
      const folder = path.resolve(requestedFolder);
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return sendError(res, 400, '视频文件夹不存在');
      return sendJson(res, 200, { paths: await listVideosInFolder(folder) });
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze') {
      const body = await readJson(req);
      const project = await analyzeFiles(body.files || [], {
        name: body.name,
        threshold: Number(body.threshold ?? 0.30),
        minDuration: Number(body.minDuration ?? 0.45),
        splitMode: body.splitMode === 'precise' ? 'precise' : 'continuity',
        endTrimFrames: 0,
      });
      return sendJson(res, 200, project);
    }
    if (req.method === 'POST' && url.pathname === '/api/workflow/run') {
      const body = await readJson(req);
      return sendJson(res, 200, await runAutomatedWorkflow({
        files: body.files || [],
        hookPaths: body.hookPaths || [],
        musicPaths: body.musicPaths || [],
        libraryItemIds: body.libraryItemIds || [],
        useBroll: body.useBroll,
        useHooks: body.useHooks,
        useMusic: body.useMusic,
        mixDuration: body.mixDuration,
        outputCount: body.outputCount,
        name: body.name,
        threshold: body.threshold,
        minDuration: body.minDuration,
        splitMode: body.splitMode,
        hookThreshold: body.hookThreshold,
        provider: body.provider,
        model: body.model,
      }));
    }
    if (req.method === 'POST' && url.pathname === '/api/workflow/start') {
      const body = await readJson(req);
      const jobId = `w_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const job = {
        id: jobId,
        state: 'processing',
        phase: '准备素材',
        overall: 0,
        broll: { done: 0, total: (body.files || []).length, current: '', segments: 0 },
        hooks: { done: 0, total: (body.hookPaths || []).length, current: '' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      WORKFLOW_JOBS.set(jobId, job);
      const onProgress = (event) => {
        if (event.branch === 'complete') return updateWorkflowJob(job, { overall: 100, phase: '处理完成' });
        if (event.branch === 'broll' || event.branch === 'hooks') {
          job[event.branch] = { ...job[event.branch], done: event.done, total: event.total, current: event.current || '', ...(event.segments == null ? {} : { segments: event.segments }) };
          updateWorkflowJob(job, { overall: workflowOverall(job), phase: event.branch === 'broll' ? '正在拆分空镜' : '正在识别钩子' });
        }
      };
      runAutomatedWorkflow({
        files: body.files || [], hookPaths: body.hookPaths || [], musicPaths: body.musicPaths || [],
        libraryItemIds: body.libraryItemIds || [], useBroll: body.useBroll, useHooks: body.useHooks,
        useMusic: body.useMusic, mixDuration: body.mixDuration, outputCount: body.outputCount, name: body.name,
        threshold: body.threshold, minDuration: body.minDuration, splitMode: body.splitMode,
        hookThreshold: body.hookThreshold, provider: body.provider, model: body.model, onProgress,
      }).then((result) => updateWorkflowJob(job, { state: 'complete', overall: 100, phase: '处理完成', result }))
        .catch((error) => updateWorkflowJob(job, { state: 'failed', phase: '处理失败', error: error.message }));
      const cleanup = setTimeout(() => WORKFLOW_JOBS.delete(jobId), 60 * 60 * 1000);
      cleanup.unref?.();
      return sendJson(res, 202, { jobId });
    }
    if (req.method === 'GET' && url.pathname === '/api/workflow/status') {
      const job = WORKFLOW_JOBS.get(String(url.searchParams.get('job') || ''));
      if (!job) return sendError(res, 404, '处理任务不存在或已经过期');
      return sendJson(res, 200, job);
    }
    if (req.method === 'POST' && url.pathname === '/api/project/save') {
      const body = await readJson(req);
      const project = await loadProject(body.id);
      const updates = new Map((body.segments || []).map((segment) => [segment.id, segment]));
      project.segments = project.segments.map((segment) => ({ ...segment, ...(updates.get(segment.id) || {}) }));
      if (body.name) project.name = body.name;
      await saveProject(project);
      return sendJson(res, 200, project);
    }
    if (req.method === 'POST' && url.pathname === '/api/project/append-library') {
      const body = await readJson(req);
      const project = await loadProject(body.id);
      const before = new Set(project.segments.map((segment) => segment.id));
      appendLibraryBroll(project, await loadLibrary(), body.libraryItemIds || []);
      const addedSegmentIds = project.segments.filter((segment) => !before.has(segment.id)).map((segment) => segment.id);
      await saveProject(project);
      return sendJson(res, 200, { project, addedSegmentIds });
    }
    if (req.method === 'POST' && url.pathname === '/api/project/segment-boundary') {
      const body = await readJson(req);
      return sendJson(res, 200, await updateSegmentBoundary(await loadProject(body.id), body.segmentId, body.start, body.end));
    }
    if (req.method === 'POST' && url.pathname === '/api/project/delete') {
      const body = await readJson(req);
      const id = String(body.id || '');
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) return sendError(res, 400, '项目编号无效');
      const record = projectFile(id);
      if (!fs.existsSync(record)) return sendError(res, 404, '项目不存在或已经删除');
      const assetRoot = path.resolve(DATA_DIR, id);
      if (path.dirname(assetRoot) !== path.resolve(DATA_DIR)) return sendError(res, 400, '项目路径无效');
      await fsp.rm(record, { force: true });
      await fsp.rm(`${record}.bak`, { force: true });
      await fsp.rm(assetRoot, { recursive: true, force: true });
      return sendJson(res, 200, { deleted: true, id, sourceVideosPreserved: true, starredClipsPreserved: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/project/ai-label') {
      const body = await readJson(req);
      if (body.provider === 'glm') {
        const model = body.model || runtimeAi.glmModel;
        return sendJson(res, 200, await labelWithGlm(await loadProject(body.id), model, body.ids));
      }
      const status = await ensureOllamaRunning();
      if (!status.available) return sendError(res, 409, '未检测到 Ollama 本地模型服务');
      const model = body.model || status.visionModels[0];
      if (!model) return sendError(res, 409, 'Ollama 中没有已安装的视觉模型');
      return sendJson(res, 200, await labelWithOllama(await loadProject(body.id), model, body.ids));
    }
    if (req.method === 'POST' && url.pathname === '/api/project/script-match') {
      const body = await readJson(req);
      if (body.libraryOnly) {
        const library = await loadLibrary();
        const libraryProject = libraryAsProject(library);
        const plan = buildMixPlan(libraryProject, body);
        library.mixPlans = libraryProject.mixPlans;
        await saveLibrary(library);
        return sendJson(res, 200, plan);
      }
      const project = await loadProject(body.id);
      const matchingProject = project;
      const plan = buildMixPlan(matchingProject, body);
      project.mixPlans = matchingProject.mixPlans;
      await saveProject(project);
      return sendJson(res, 200, plan);
    }
    if (req.method === 'POST' && url.pathname === '/api/project/mix-export') {
      const body = await readJson(req);
      const project = body.libraryOnly ? libraryAsProject(await loadLibrary()) : await loadProject(body.id);
      const plan = (project.mixPlans || []).find((item) => item.id === body.planId);
      if (!plan) return sendError(res, 404, '混剪方案不存在');
      return sendJson(res, 200, await exportMixPlan(project, plan, body));
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/analyze') {
      const body = await readJson(req);
      const project = await loadProject(body.id);
      return sendJson(res, 200, await analyzeHook(project, body.path, body));
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/batch-analyze') {
      const body = await readJson(req);
      return sendJson(res, 200, await batchAnalyzeHooks(await loadProject(body.id), body));
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/select') {
      const body = await readJson(req);
      return sendJson(res, 200, await selectProjectHook(await loadProject(body.id), body.hookId));
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/export') {
      const body = await readJson(req);
      return sendJson(res, 200, await exportCompositionTask(await loadProject(body.id), body));
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/preview') {
      const body = await readJson(req);
      const project = await loadProject(body.id);
      const previous = ACTIVE_PREVIEWS.get(project.id);
      if (previous) previous.abort();
      const controller = new AbortController();
      ACTIVE_PREVIEWS.set(project.id, controller);
      const cancelDisconnected = () => {
        if (!res.writableEnded) controller.abort();
      };
      req.once('aborted', cancelDisconnected);
      res.once('close', cancelDisconnected);
      try {
        const result = await exportCompositionTask(project, { ...body, preview: true, signal: controller.signal });
        if (!controller.signal.aborted && !res.destroyed) return sendJson(res, 200, result);
        return undefined;
      } catch (error) {
        if (error.code === 'PREVIEW_ABORTED') {
          if (!res.destroyed && !res.writableEnded) return sendError(res, 409, '已切换到新的预览任务');
          return undefined;
        }
        throw error;
      } finally {
        req.removeListener('aborted', cancelDisconnected);
        res.removeListener('close', cancelDisconnected);
        if (ACTIVE_PREVIEWS.get(project.id) === controller) ACTIVE_PREVIEWS.delete(project.id);
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/auto-compose') {
      const body = await readJson(req);
      const project = await loadProject(body.id);
      const plan = createAutoHookComposition(project, body.hookId, body);
      await saveProject(project);
      return sendJson(res, 200, plan);
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/plans/save') {
      const body = await readJson(req);
      const project = await loadProject(body.id);
      storeHookPlans(project, body.plans || {});
      await saveProject(project);
      return sendJson(res, 200, { saved: true, hookPlans: project.hookPlans });
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/batch-export') {
      const body = await readJson(req);
      return sendJson(res, 200, await batchExportHooks(await loadProject(body.id), body));
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/batch-export/start') {
      const body = await readJson(req);
      const job = startBatchExportJob(await loadProject(body.id), body);
      return sendJson(res, 202, { jobId: job.id, job: publicBatchExportJob(job) });
    }
    if (req.method === 'GET' && url.pathname === '/api/hook/batch-export/status') {
      const job = BATCH_EXPORT_JOBS.get(String(url.searchParams.get('job') || ''));
      if (!job) return sendError(res, 404, '导出任务不存在或已经过期');
      return sendJson(res, 200, publicBatchExportJob(job));
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/confirm') {
      const body = await readJson(req);
      const project = await loadProject(body.id);
      const hook = await confirmHookExtraction(project, body.hookCut);
      const composition = body.autoCompose ? createAutoHookComposition(project, hook.id) : null;
      if (composition) await saveProject(project);
      return sendJson(res, 200, body.autoCompose ? { hook, composition } : hook);
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/review') {
      const body = await readJson(req);
      return sendJson(res, 200, await reviewProjectHook(await loadProject(body.id), body.hookId, body.hookCut));
    }
    if (req.method === 'POST' && url.pathname === '/api/hook/delete') {
      const body = await readJson(req);
      return sendJson(res, 200, await deleteProjectHook(await loadProject(body.id), body.hookId));
    }
    if (req.method === 'GET' && url.pathname === '/api/hook/video') {
      const project = await loadProject(url.searchParams.get('project') || '');
      const hookId = String(url.searchParams.get('hook') || '');
      const hook = hookId ? (project.hooks || []).find((item) => item.id === hookId) : project.hook;
      if (!hook?.path || !fs.existsSync(hook.path)) return sendError(res, 404, '钩子视频不存在');
      const contentType = hook.path.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
      return serveMedia(req, res, hook.path, contentType);
    }
    if (req.method === 'GET' && url.pathname === '/api/hook/audio') {
      const project = await loadProject(url.searchParams.get('project') || '');
      const hookId = String(url.searchParams.get('hook') || '');
      const hook = hookId ? (project.hooks || []).find((item) => item.id === hookId) : project.hook;
      if (!hook?.audioPath || !fs.existsSync(hook.audioPath)) return sendError(res, 404, '钩子音乐尚未提取');
      return serveMedia(req, res, hook.audioPath, 'audio/mp4');
    }
    if (req.method === 'GET' && url.pathname === '/api/hook/rendered-preview') {
      const project = await loadProject(url.searchParams.get('project') || '');
      const taskId = String(url.searchParams.get('task') || url.searchParams.get('hook') || '');
      if (!(project.hooks || []).some((hook) => hook.id === taskId) && !/^mix_\d+$/.test(taskId)) return sendError(res, 404, '预览对应的成片任务不存在');
      const file = String(url.searchParams.get('file') || '');
      const prefix = `${taskId}_composition_preview_`;
      if (path.basename(file) !== file || !file.startsWith(prefix) || !file.endsWith('.mp4')) return sendError(res, 400, '预览文件参数无效');
      const preview = path.join(DATA_DIR, project.id, file);
      return serveMedia(req, res, preview, 'video/mp4');
    }
    if (req.method === 'GET' && url.pathname === '/api/music/audio') {
      const project = await loadProject(url.searchParams.get('project') || '');
      const track = (project.musicTracks || []).find((item) => item.id === url.searchParams.get('track'));
      if (!track?.path || !fs.existsSync(track.path)) return sendError(res, 404, '音乐文件不存在');
      return serveMedia(req, res, track.path, MIME[path.extname(track.path).toLowerCase()] || 'application/octet-stream');
    }
    if (req.method === 'GET' && url.pathname === '/api/music/waveform') {
      const project = await loadProject(url.searchParams.get('project') || '');
      const track = (project.musicTracks || []).find((item) => item.id === url.searchParams.get('track'));
      if (!track?.path || !fs.existsSync(track.path)) return sendError(res, 404, '音乐文件不存在');
      if (!Array.isArray(track.waveform) || track.waveform.length < 48) {
        const key = `${project.id}:${track.id}`;
        let job = MUSIC_WAVEFORM_JOBS.get(key);
        if (!job) {
          job = (async () => {
            track.waveform = await analyzeMusicWaveform(track.path);
            await saveProject(project);
            return track.waveform;
          })().finally(() => MUSIC_WAVEFORM_JOBS.delete(key));
          MUSIC_WAVEFORM_JOBS.set(key, job);
        }
        track.waveform = await job;
      }
      return sendJson(res, 200, { id: track.id, duration: track.duration, waveform: track.waveform });
    }
    if (req.method === 'GET' && url.pathname === '/api/library') {
      const library = await loadLibrary();
      return sendJson(res, 200, { items: library.items.map(publicLibraryItem), directory: LIBRARY_DIR });
    }
    if (req.method === 'POST' && url.pathname === '/api/library/star') {
      const body = await readJson(req);
      return sendJson(res, 200, await starSegment(body.projectId, body.segmentId));
    }
    if (req.method === 'POST' && url.pathname === '/api/library/star-batch') {
      const body = await readJson(req);
      return sendJson(res, 200, await starSegments(body.projectId, body.segmentIds));
    }
    if (req.method === 'POST' && url.pathname === '/api/library/star-hook') {
      const body = await readJson(req);
      return sendJson(res, 200, await starHook(body.projectId, body.hookId));
    }
    if (req.method === 'POST' && url.pathname === '/api/library/rename') {
      const body = await readJson(req);
      return sendJson(res, 200, await renameLibraryItem(body.id, body.label));
    }
    if (req.method === 'POST' && url.pathname === '/api/open-path') {
      const body = await readJson(req);
      const target = body.path ? path.resolve(body.path) : LIBRARY_DIR;
      if (!fs.existsSync(target)) return sendError(res, 404, '路径不存在');
      return sendJson(res, 200, openInExplorer(target));
    }
    if (req.method === 'GET' && url.pathname === '/api/library/thumb') {
      const library = await loadLibrary();
      const item = library.items.find((entry) => entry.id === url.searchParams.get('id'));
      if (!item?.thumbnailPath || !fs.existsSync(item.thumbnailPath)) return sendError(res, 404, '素材库缩略图不存在');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
      return fs.createReadStream(item.thumbnailPath).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/library/video') {
      const library = await loadLibrary();
      const item = library.items.find((entry) => entry.id === url.searchParams.get('id'));
      return serveMedia(req, res, item?.clipPath, 'video/mp4');
    }
    if (req.method === 'POST' && url.pathname === '/api/export') {
      const body = await readJson(req);
      return sendJson(res, 200, await exportSegments(await loadProject(body.id), body));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/project/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/project/'.length));
      return sendJson(res, 200, await loadProject(id));
    }
    if (req.method === 'GET' && url.pathname === '/api/video') {
      return serveVideo(req, res, await loadProject(url.searchParams.get('project') || ''), url.searchParams.get('file'));
    }
    if (req.method === 'GET' && url.pathname === '/api/thumb') {
      const project = await loadProject(url.searchParams.get('project') || '');
      const name = path.basename(url.searchParams.get('name') || '');
      const file = path.join(DATA_DIR, project.id, name);
      if (!name || !fs.existsSync(file)) return sendError(res, 404, '缩略图不存在');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const files = (await fsp.readdir(PROJECTS_DIR)).filter((name) => name.endsWith('.json'));
      const items = [];
      for (const file of files) {
        try {
          const project = JSON.parse(await fsp.readFile(path.join(PROJECTS_DIR, file), 'utf8'));
          items.push({ id: project.id, name: project.name, updatedAt: project.updatedAt, count: project.segments.length });
        } catch {}
      }
      return sendJson(res, 200, items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
    }

    let relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    relative = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, relative);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return sendError(res, 404, '页面不存在');
    }
    const stat = await fsp.stat(file);
    const extension = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[extension] || 'application/octet-stream', 'Content-Length': stat.size };
    if (['.html', '.css', '.js'].includes(extension)) {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers.Pragma = 'no-cache';
      headers.Expires = '0';
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    sendError(res, 500, error.message || '内部错误', homixEnv('DEBUG') ? (error.detail || error.stack) : undefined);
  }
}

const server = http.createServer(route);
server.listen(PORT, HOST, () => {
  console.log(`HoMix 已启动：http://${HOST}:${PORT}`);
  console.log(FFMPEG && FFPROBE ? `FFmpeg：${FFMPEG}` : '警告：未找到 FFmpeg');
  if (process.platform === 'win32') console.log(WINDOWS_PROCESS_RUNNER ? '后台进程：无控制台代理已启用' : '后台进程：开发模式直接执行');
if (homixEnv('NO_BROWSER') !== '1') {
    const url = `http://${HOST}:${PORT}`;
    const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = [url];
    const browser = spawn(command, args, { shell: false, windowsHide: process.platform === 'win32', detached: true, stdio: 'ignore' });
    browser.unref();
  }
  console.log('Ollama：按需检测，仅在使用视觉功能时启动');
});
