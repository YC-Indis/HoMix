const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const desktopPlatform = new URLSearchParams(location.search).get('desktop') || '';
document.documentElement.classList.toggle('platform-macos', desktopPlatform === 'macos');
const nativeBridge = (() => {
  const platformBridge = window.hoMixNative || window.sceneSiftNative;
  if (platformBridge?.postMessage && platformBridge?.onMessage) {
    return {
      postMessage: (message) => platformBridge.postMessage(message),
      onMessage: (listener) => platformBridge.onMessage(listener),
    };
  }
  if (window.chrome?.webview) {
    return {
      postMessage: (message) => window.chrome.webview.postMessage(message),
      onMessage: (listener) => window.chrome.webview.addEventListener('message', (event) => listener(event.data)),
    };
  }
  return null;
})();
const nativeHost = Boolean(nativeBridge);

const state = {
  status: null,
  files: [],
  musicPaths: [],
  intakeOptions: { useBroll: true, useHooks: true, useMusic: false },
  intakeLibraryIds: { broll: new Set(), hook: new Set() },
  libraryPickMode: '',
  libraryType: 'broll',
  project: null,
  activeId: null,
  exportMode: 'accurate',
  gridView: 'grid',
  aiPreset: false,
  aiProvider: 'ollama',
  mixPlan: null,
  mixContext: 'project',
  library: { items: [], directory: '' },
  lastExportDir: '',
  hookPath: '',
  hookPaths: [],
  hookBatch: null,
  hook: null,
  hookCut: 0,
  hookClips: [],
  hookPlans: {},
  hookActivationToken: 0,
  previewGenerationToken: 0,
  previewAbortController: null,
  hookReviewVersions: {},
  hookAnalysisRunning: false,
  workflowPage: 'intake',
  compositionPreviewReady: false,
  compositionPreviewUrl: '',
  compositionEditVersion: 0,
  boxSelectMode: false,
  boxSelectedIds: new Set(),
  boxDrag: null,
  suppressSegmentClick: false,
  replacingClipIndex: -1,
  clipPickerMode: 'add',
  clipPickerSource: 'project',
  clipPickerSelection: new Set(),
  draggedClipIndex: -1,
  musicWaveformLoading: new Set(),
  musicWaveformDragging: false,
  lastMusicConflictToast: 0,
  shortDurationResolver: null,
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  });
  const raw = await response.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { throw new Error('本地服务返回了不完整结果，请重新执行当前操作'); }
  }
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.className = 'toast'; }, 3200);
}

function formatTime(seconds, compact = false) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const ms = Math.round((value - Math.floor(value)) * 1000);
  if (compact && hours === 0) return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function humanBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function refreshStatus(checkOllama = false) {
  try {
    state.status = await api(checkOllama ? '/api/status?ollama=1' : '/api/status');
    $('#ffmpegState').textContent = state.status.ffmpeg ? '已就绪' : '未找到';
    $('#ffmpegState').classList.toggle('ok', Boolean(state.status.ffmpeg));
    $('#libraryCount').textContent = state.status.libraryCount || 0;
    const ollama = state.status.ollama || { checked: false, available: false, installed: null, models: [], visionModels: [] };
    const ai = state.status.ai || { available: [], glm: {} };
    state.aiProvider = ai.provider || state.aiProvider;
    const aiReady = state.aiProvider === 'glm'
      ? Boolean(ai.glm?.configured)
      : Boolean(ollama.available && ollama.visionModels?.length);
    const aiText = state.aiProvider === 'ollama'
      ? ollama.available
        ? `Ollama · ${ollama.visionModels?.length || 0} 个视觉模型`
        : ollama.checked ? 'Ollama 未配置' : 'Ollama 按需检测'
      : ai.glm?.configured ? 'GLM 已配置' : 'GLM 未配置';
    $('#ollamaState').textContent = aiText;
    $('#ollamaState').classList.toggle('ok', aiReady);
    $('#aiLabel').disabled = !aiReady;
    $('#aiPreset').disabled = !aiReady;
    $('#labelModeHint').textContent = aiReady ? `${state.aiProvider === 'glm' ? 'GLM' : 'Ollama'} 分析后生成` : ollama.checked ? '请先配置视觉模型' : '使用时检测视觉模型';
    $('#aiFeature')?.classList.toggle('active', state.aiPreset && aiReady);
    const aiFeatureStatus = $('#aiFeature em');
    if (aiFeatureStatus) aiFeatureStatus.textContent = state.aiPreset && aiReady ? '✓' : '＋';
    $('#engineTitle').textContent = aiReady ? `${aiText} · CPU 分镜已就绪` : '本地 CPU 已就绪';
    $('#engineHint').textContent = aiReady ? '场景检测在本机运行，缩略图按需发送给所选视觉模型' : 'FFmpeg 负责镜头检测，可在 AI 设置中接入 GLM';
    $('#aiProvider').value = state.aiProvider;
    $('#glmModel').value = ai.glm?.model || 'glm-4.6v-flash';
    const visionModels = ollama.visionModels || [];
    $('#ollamaModel').innerHTML = visionModels.length
      ? visionModels.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('')
      : '<option value="">尚未安装视觉模型</option>';
    $('#ollamaSetupState').textContent = !ollama.checked
      ? '尚未检测 Ollama'
      : ollama.available
      ? `Ollama 已连接 · ${visionModels.length} 个视觉模型`
      : ollama.installed ? '已找到 Ollama，但服务尚未连接' : '未找到 Ollama 安装程序';
    $('#ollamaSetupHint').textContent = visionModels.length
      ? `当前可用：${visionModels.join('、')}`
      : ollama.available ? '服务已启动；安装 qwen3-vl:4b 后即可本地识图。' : '点击“启动/重新检测”，HoMix 会尝试自动启动本地服务。';
    $('#startOllama').disabled = ollama.available;
    syncAiProviderFields();
  } catch (error) { toast(error.message, true); }
}

async function refreshProjects() {
  try {
    const projects = await api('/api/projects');
    $('#projectCount').textContent = projects.length;
    $('#projectCountTop').textContent = projects.length;
    $('#projectList').innerHTML = projects.length ? projects.map((project) => `
      <article class="project-row" data-id="${project.id}">
        <button class="project-open" data-open-project="${project.id}"><div><b>${escapeHtml(project.name)}</b><small>${project.count} 个镜头 · ${new Date(project.updatedAt).toLocaleString('zh-CN')}</small></div><span>→</span></button>
        <button class="project-delete" data-delete-project="${project.id}" title="删除本地项目">删除</button>
      </article>`).join('') : '<p style="color:#687182;font-size:11px">还没有保存的项目。</p>';
    $$('[data-open-project]').forEach((button) => button.addEventListener('click', () => openProject(button.dataset.openProject)));
    $$('[data-delete-project]').forEach((button) => button.addEventListener('click', () => deleteProject(button.dataset.deleteProject)));
  } catch {}
}

async function requestBrowserPicker(mode, event, busyText) {
  const button = event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
  const originalText = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = busyText;
  }
  toast('正在打开系统文件选择窗口…');
  try {
    return await api('/api/pick', { method: 'POST', body: JSON.stringify({ mode }) });
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function chooseFiles(event) {
  pauseAllPlayback();
  if (nativeHost) {
    nativeBridge.postMessage('pick-files');
    return;
  }
  try {
    const result = await requestBrowserPicker('files', event, '正在打开…');
    addFiles(result.paths || []);
  } catch (error) { toast(error.message, true); }
}

async function chooseFolderVideos(event) {
  pauseAllPlayback();
  if (nativeHost) {
    nativeBridge.postMessage('pick-video-folder');
    return;
  }
  try {
    const result = await requestBrowserPicker('video-folder', event, '正在打开…');
    addFiles(result.paths || []);
  } catch (error) { toast(error.message, true); }
}

function addFiles(paths) {
  pauseAllPlayback();
  for (const item of paths) {
    const value = String(item || '').trim().replace(/^"|"$/g, '');
    if (value && !state.files.includes(value)) state.files.push(value);
  }
  renderSources();
}

function intakeConfig() {
  return {
    ...state.intakeOptions,
    mixDuration: Math.max(1, Number($('#mixSegmentDuration').value) || 15),
    outputCount: Math.max(1, Math.min(50, Number($('#mixOutputCount').value) || 1)),
  };
}

function syncIntakeOptionControls() {
  const keys = { broll: 'useBroll', hooks: 'useHooks', music: 'useMusic' };
  $$('[data-content-toggle]').forEach((input) => { input.checked = Boolean(state.intakeOptions[keys[input.dataset.contentToggle]]); });
}

function updateIntakeMode() {
  const config = intakeConfig();
  syncIntakeOptionControls();
  $('#initialHookPanel').classList.toggle('hidden', !config.useHooks);
  $('#initialMusicPanel').classList.toggle('hidden', !config.useMusic);
  $('#outputCountSetting').classList.toggle('hidden', config.useHooks);
  $('#stepHook').classList.toggle('workflow-disabled', !config.useHooks);
  $('#hookFeature')?.classList.toggle('workflow-disabled', !config.useHooks);
  $('#pickBrollLibrary').classList.toggle('hidden', !config.useBroll);
  ['#pickFiles', '#pickFolder', '#enterPath', '#addMore', '#addFolder', '#clearFiles'].forEach((selector) => {
    const button = $(selector);
    if (button) button.disabled = !config.useBroll;
  });
  renderSources();
}

async function chooseMusic(event) {
  pauseAllPlayback();
  if (nativeHost) {
    nativeBridge.postMessage('pick-music-file');
    return;
  }
  try {
    const result = await requestBrowserPicker('audio', event, '正在打开…');
    for (const item of result.paths || []) if (!state.musicPaths.includes(item)) state.musicPaths.push(item);
    renderInitialMusicSources();
    renderSources();
  } catch (error) { toast(error.message, true); }
}

function renderInitialMusicSources() {
  $('#initialMusicCount').textContent = state.musicPaths.length;
  $('#initialMusicList').innerHTML = state.musicPaths.length ? state.musicPaths.map((file, index) => `<div class="initial-hook-row"><span>${String(index + 1).padStart(2, '0')}</span><div><b>${escapeHtml(file.split(/[\\/]/).pop())}</b><small>${escapeHtml(file)}</small></div><em>待使用</em><button data-remove-music="${index}" title="移除">×</button></div>`).join('') : '<div class="initial-hook-empty">尚未添加音乐。</div>';
  $$('[data-remove-music]').forEach((button) => button.addEventListener('click', () => { state.musicPaths.splice(Number(button.dataset.removeMusic), 1); renderInitialMusicSources(); renderSources(); }));
}

function renderSources() {
  const config = intakeConfig();
  const hasFiles = state.files.length > 0;
  $('#importPanel').classList.toggle('hidden', hasFiles);
  $('#sourcePanel').classList.toggle('hidden', !hasFiles);
  $('#importPanel').classList.toggle('content-disabled', !config.useBroll);
  $('#sourcePanel').classList.toggle('content-disabled', !config.useBroll);
  $('#sourceCount').textContent = state.files.length;
  $('#readyCount').textContent = state.files.length;
  const brollCount = state.files.length + state.intakeLibraryIds.broll.size;
  const hookCount = state.hookPaths.length + state.intakeLibraryIds.hook.size;
  const valid = (config.useBroll || config.useHooks)
    && (!config.useBroll || brollCount > 0)
    && (!config.useHooks || hookCount > 0)
    && (!config.useMusic || state.musicPaths.length > 0);
  $('#analyzeButton').disabled = !valid;
  $('#analyzeButton span').textContent = config.useHooks ? '开始自动工作流' : '处理素材并进入第三步';
  $('#analyzeButton small').textContent = `${brollCount} 组混剪素材 · ${hookCount} 个钩子 · ${state.musicPaths.length} 首音乐`;
  if (!hasFiles) {
    $('#sourceList').innerHTML = '';
    return;
  }
  $('#sourceList').innerHTML = state.files.map((file, index) => {
    const name = file.split(/[\\/]/).pop();
    const ext = (name.split('.').pop() || 'video').toUpperCase();
    return `<div class="source-row"><span class="source-id">${String(index + 1).padStart(2, '0')}</span><div class="source-name"><b>${escapeHtml(name)}</b><small>${escapeHtml(ext)} 视频</small></div><span class="source-path">${escapeHtml(file)}</span><span class="source-ready">已就绪</span><button class="source-remove" data-index="${index}" title="移除">×</button></div>`;
  }).join('');
  $$('.source-remove').forEach((button) => button.addEventListener('click', () => {
    state.files.splice(Number(button.dataset.index), 1);
    renderSources();
  }));
}

function renderInitialHookSources() {
  const list = $('#initialHookList');
  $('#initialHookCount').textContent = state.hookPaths.length;
  if (!state.hookPaths.length) {
    list.innerHTML = '<div class="initial-hook-empty">钩子可稍后补充，但建议在这里一次导入。</div>';
  } else {
    list.innerHTML = state.hookPaths.map((file, index) => `<div class="initial-hook-row"><span>${String(index + 1).padStart(2, '0')}</span><div><b>${escapeHtml(file.split(/[\\/]/).pop())}</b><small>${escapeHtml(file)}</small></div><em>待并行识别</em><button data-remove-initial-hook="${index}" title="移除">×</button></div>`).join('');
    $$('[data-remove-initial-hook]').forEach((button) => button.addEventListener('click', () => {
      state.hookPaths.splice(Number(button.dataset.removeInitialHook), 1);
      state.hookPath = state.hookPaths[0] || '';
      renderInitialHookSources();
      renderSources();
    }));
  }
}

function setWorkflow(step) {
  const skipHooks = state.project ? state.project.workflowConfig?.useHooks === false : !state.intakeOptions.useHooks;
  $$('.workflow-step').forEach((node, index) => {
    const skipped = index === 1 && skipHooks;
    node.classList.toggle('active', index === step && !skipped);
    node.classList.toggle('completed', index < step && !skipped);
    node.classList.toggle('skipped', skipped);
  });
  const featureSteps = [document.querySelector('[data-feature="scene"]'), $('#hookFeature'), $('#composeFeature')];
  featureSteps.forEach((node, index) => {
    if (!node) return;
    const skipped = index === 1 && skipHooks;
    node.classList.toggle('active', index === step && !skipped);
    node.classList.toggle('workflow-disabled', skipped);
    const status = node.querySelector('em');
    if (status) status.textContent = skipped ? '跳过' : index < step ? '✓' : index === step ? '当前' : '→';
  });
}

async function analyze() {
  const config = intakeConfig();
  if (!config.useBroll && !config.useHooks) return toast('请至少启用混剪素材或钩子', true);
  if (!state.status?.ffmpeg) return toast('未找到 FFmpeg，无法开始分析', true);
  $('#intakeWorkbench').classList.add('hidden');
  $('#analysisLoading').classList.remove('hidden');
  $('#brollJobStatus').textContent = config.useBroll ? `${state.files.length} 条本地素材正在拆分` : '未启用混剪素材，本轮跳过';
  $('#hookJobStatus').textContent = config.useHooks ? `${state.hookPaths.length + state.intakeLibraryIds.hook.size} 条钩子正在并行识别` : '未启用钩子，本轮跳过';
  $('#composeJobStatus').textContent = config.useHooks ? '等待钩子确认' : '处理后直接进入成片编排';
  $('#workflowProgressBar').style.width = '0%';
  $('#workflowPercent').textContent = '0%';
  $('#workflowProgressDetail').textContent = '正在创建本地处理任务…';
  $('#loadingText').textContent = config.useBroll && config.useHooks ? '混剪素材拆分和钩子识别正在并行处理。' : config.useBroll ? '正在建立混剪素材库，完成后直接进入成片编排。' : '正在识别钩子切点，确认后可以直接导出。';
  setWorkflow(0);
  try {
    const started = await api('/api/workflow/start', {
      method: 'POST',
      body: JSON.stringify({
        files: state.files,
        hookPaths: state.hookPaths,
        musicPaths: state.musicPaths,
        libraryItemIds: [...state.intakeLibraryIds.broll, ...state.intakeLibraryIds.hook],
        ...config,
        threshold: Number($('#threshold').value),
        minDuration: Number($('#minDuration').value),
        provider: state.aiProvider || state.status?.ai?.provider,
        model: state.aiProvider === 'glm' ? state.status?.ai?.glm?.model : state.status?.ollama?.visionModels?.[0],
      }),
    });
    let job = null;
    while (!job || job.state === 'processing') {
      await new Promise((resolve) => setTimeout(resolve, 650));
      job = await api(`/api/workflow/status?job=${encodeURIComponent(started.jobId)}`);
      const percent = Number(job.overall || 0);
      $('#workflowProgressBar').style.width = `${percent}%`;
      $('#workflowPercent').textContent = `${percent}%`;
      $('#workflowProgressDetail').textContent = job.phase || '正在处理';
      const broll = job.broll || { done: 0, total: state.files.length };
      const hooks = job.hooks || { done: 0, total: state.hookPaths.length };
      $('#brollJobStatus').textContent = `${broll.done} / ${broll.total} 条${broll.current ? ` · ${broll.current}` : ''}${broll.segments ? ` · ${broll.segments} 个片段` : ''}`;
      $('#hookJobStatus').textContent = hooks.total ? `${hooks.done} / ${hooks.total} 条${hooks.current ? ` · ${hooks.current}` : ''}` : '未导入钩子，本轮跳过';
      if (job.state === 'failed') throw new Error(job.error || '自动工作流处理失败');
    }
    const result = job.result;
    state.project = result.project;
    state.hookBatch = result.hookBatch;
    state.hook = state.project.hook || result.hookBatch?.hooks?.[0] || null;
    state.hookCut = state.hook?.confirmedCut || state.hook?.suggestedCut || 0;
    state.hookPlans = state.project.hookPlans || {};
    if (result.composition?.hookId) state.hookPlans[result.composition.hookId] = result.composition;
    state.hookClips = state.hook ? (state.hookPlans[state.hook.id]?.clips || []) : [];
    state.compositionPreviewReady = false;
    $('#brollJobStatus').textContent = `${state.project.segments.length} 个连贯片段已建立`;
    $('#hookJobStatus').textContent = state.hookPaths.length ? `${result.hookBatch.autoConfirmed} 条自动通过 · ${result.hookBatch.needsReview} 条待确认` : '本轮未导入钩子';
    $('#composeJobStatus').textContent = result.composition ? `已自动铺入 ${result.composition.clips.length} 个空镜` : '等待已确认钩子';
    $('#workflowProgressBar').style.width = '100%';
    $('#workflowPercent').textContent = '100%';
    $('#workflowProgressDetail').textContent = '第一轮处理完成';
    $('#analysisLoading').classList.add('hidden');
    renderProject();
    renderHookBatchResults();
    showWorkflowPage(config.useBroll ? 'scene' : 'extract');
    await refreshProjects();
    toast(`自动工作流完成：${state.project.segments.length} 个混剪片段，${result.hookBatch.autoConfirmed} 个钩子自动通过，${result.hookBatch.needsReview} 个待确认`);
  } catch (error) {
    $('#analysisLoading').classList.add('hidden');
    $('#intakeWorkbench').classList.remove('hidden');
    renderSources();
    setWorkflow(0);
    toast(error.message, true);
  }
}

function currentSource(segment) {
  return state.project?.files.find((file) => file.id === segment.fileId);
}

function sourceLayout(source, segment = null) {
  return segment?.layout || source?.layout || (Number(source?.width) > Number(source?.height) ? 'triple' : 'portrait');
}

function updateBoxSelectionToolbar() {
  const count = state.boxSelectedIds.size;
  $('#segmentGrid')?.classList.toggle('box-selecting', state.boxSelectMode);
  $('#boxSelectSegments')?.classList.toggle('active', state.boxSelectMode);
  $('#boxSelectSegments').textContent = state.boxSelectMode ? '正在框选…' : '框选入库';
  $('#starBoxSelection')?.classList.toggle('hidden', !state.boxSelectMode);
  $('#clearBoxSelection')?.classList.toggle('hidden', !state.boxSelectMode);
  $('#starBoxSelection').disabled = count === 0;
  $('#starBoxSelection span').textContent = count;
}

function clearBoxSelection(exitMode = false) {
  state.boxSelectedIds.clear();
  if (exitMode) state.boxSelectMode = false;
  $$('.segment-card.box-selected').forEach((card) => card.classList.remove('box-selected'));
  updateBoxSelectionToolbar();
}

function renderProject() {
  if (!state.project) return;
  $('#pageTitle').textContent = state.project.name;
  $('#segmentCount').textContent = state.project.segments.length;
  renderSegments();
  updateSelectionSummary();
  const useHooks = state.project.workflowConfig?.useHooks !== false;
  $('#hookStudio').textContent = useHooks ? '下一步：确认钩子 →' : '跳过步骤二：进入成片编排 →';
  if (!state.activeId && state.project.segments.length) activateSegment(state.project.segments[0].id, false);
}

function renderSegments() {
  const query = $('#segmentSearch').value.trim().toLowerCase();
  const segments = state.project.segments.filter((segment) => {
    const source = currentSource(segment);
    return !query || `${segment.label} ${source?.name || ''}`.toLowerCase().includes(query);
  });
  const grid = $('#segmentGrid');
  grid.classList.toggle('list-view', state.gridView === 'list');
  grid.innerHTML = segments.map((segment) => {
    const source = currentSource(segment);
    const thumbnail = segment.thumbnailUrl || (segment.thumbnail ? `/api/thumb?project=${encodeURIComponent(state.project.id)}&name=${encodeURIComponent(segment.thumbnail)}` : '');
    const layout = sourceLayout(source, segment);
    return `<article class="segment-card${segment.id === state.activeId ? ' active' : ''}${segment.selected ? '' : ' excluded'}${state.boxSelectedIds.has(segment.id) ? ' box-selected' : ''}" data-id="${segment.id}">
      <div class="segment-thumb">${thumbnail ? `<img loading="lazy" src="${thumbnail}" alt="">` : ''}<button class="segment-star${segment.starred ? ' starred' : ''}" title="${segment.starred ? '已保存到星标素材库' : '星标并自动导出到素材库'}">${segment.starred ? '★' : '☆'}</button><span class="segment-layout ${layout}">${layout === 'triple' ? '横屏 · 三宫格' : '竖屏 · 直用'}</span><span class="segment-index">#${String(segment.index + 1).padStart(2, '0')}</span><span class="duration-chip">${formatTime(segment.duration, true)}</span><button class="segment-check" title="选择或排除">✓</button></div>
      <div class="segment-info"><b>${escapeHtml(segment.label)}</b><small>${escapeHtml(source?.name || '')} · ${formatTime(segment.start)} → ${formatTime(segment.end)}</small></div>
    </article>`;
  }).join('');
  $$('.segment-card').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (state.boxSelectMode) {
        event.preventDefault();
        if (state.suppressSegmentClick) return;
        const id = card.dataset.id;
        if (state.boxSelectedIds.has(id)) state.boxSelectedIds.delete(id); else state.boxSelectedIds.add(id);
        card.classList.toggle('box-selected', state.boxSelectedIds.has(id));
        updateBoxSelectionToolbar();
        return;
      }
      if (event.target.closest('.segment-star')) {
        event.stopPropagation();
        starSegment(card.dataset.id, event.target.closest('.segment-star'));
      } else if (event.target.closest('.segment-check')) {
        event.stopPropagation();
        toggleSegment(card.dataset.id);
      } else activateSegment(card.dataset.id);
    });
  });
  updateBoxSelectionToolbar();
}

function activateSegment(id, autoplay = true) {
  const segment = state.project.segments.find((item) => item.id === id);
  if (!segment) return;
  pauseAllPlayback();
  state.activeId = id;
  const source = currentSource(segment);
  $('#activeLabel').textContent = segment.label;
  $('#activeTime').textContent = `${formatTime(segment.start)} — ${formatTime(segment.end)}`;
  $('#activeDuration').textContent = `${segment.duration.toFixed(2)} 秒`;
  $('#activeSource').textContent = source.name;
  $('#labelInput').disabled = false;
  $('#labelInput').value = segment.label;
  $('#startInput').disabled = false;
  $('#endInput').disabled = false;
  $('#saveBoundary').disabled = false;
  $('#startInput').value = Number(segment.start).toFixed(3);
  $('#endInput').value = Number(segment.end).toFixed(3);
  $('#frameDuration').textContent = `1 帧 = ${(1 / (Number(source.fps) || 30)).toFixed(4)} 秒`;
  const aiTags = segment.ai ? [segment.ai.scene, segment.ai.action, segment.ai.shotType, segment.ai.mood, ...(segment.ai.subjects || []), ...(segment.ai.keywords || [])].filter(Boolean) : [];
  $('#activeAiTags').innerHTML = [...new Set(aiTags)].slice(0, 8).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('');
  $('#saveLabel').disabled = false;
  const video = $('#previewVideo');
  const desired = `/api/video?project=${encodeURIComponent(state.project.id)}&file=${encodeURIComponent(source.id)}`;
  if (!video.src.endsWith(desired)) video.src = desired;
  const seek = () => {
    video.currentTime = segment.start;
    if (autoplay) video.play().catch(() => {});
  };
  if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true });
  video.dataset.end = segment.end;
  $('#previewEmpty').classList.add('hidden');
  renderSegments();
}

function toggleSegment(id) {
  const segment = state.project.segments.find((item) => item.id === id);
  segment.selected = !segment.selected;
  renderSegments();
  updateSelectionSummary();
}

async function starSegment(id, button) {
  const segment = state.project.segments.find((item) => item.id === id);
  if (!segment || button.classList.contains('busy')) return;
  if (segment.starred) return toast('这个镜头已经在星标素材库中');
  button.classList.add('busy');
  button.textContent = '★';
  button.title = '正在无感导出…';
  try {
    await api('/api/library/star', {
      method: 'POST',
      body: JSON.stringify({ projectId: state.project.id, segmentId: id }),
    });
    segment.starred = true;
    if (state.status) state.status.libraryCount = Number(state.status.libraryCount || 0) + 1;
    $('#libraryCount').textContent = Number($('#libraryCount').textContent || 0) + 1;
    renderSegments();
    toast('已星标，并自动精确导出到本地素材库');
  } catch (error) {
    button.classList.remove('busy');
    button.textContent = '☆';
    button.title = '星标并自动导出到素材库';
    toast(`星标导出失败：${error.message}`, true);
  }
}

async function starBoxSelection() {
  const ids = [...state.boxSelectedIds].filter((id) => !state.project?.segments.find((segment) => segment.id === id)?.starred);
  if (!ids.length) return toast('框选的镜头都已经在素材库中');
  const button = $('#starBoxSelection');
  button.disabled = true;
  button.textContent = `正在入库 ${ids.length} 段…`;
  try {
    const result = await api('/api/library/star-batch', {
      method: 'POST',
      body: JSON.stringify({ projectId: state.project.id, segmentIds: ids }),
    });
    const saved = new Set((result.items || []).map((item) => item.segmentId));
    state.project.segments.forEach((segment) => { if (saved.has(segment.id)) segment.starred = true; });
    if (state.status) state.status.libraryCount = Number(state.status.libraryCount || 0) + saved.size;
    $('#libraryCount').textContent = Number($('#libraryCount').textContent || 0) + saved.size;
    clearBoxSelection(true);
    renderSegments();
    const failed = result.failures?.length || 0;
    toast(`已批量星标并入库 ${saved.size} 段${failed ? `，${failed} 段失败` : ''}`, Boolean(failed));
  } catch (error) {
    toast(`批量入库失败：${error.message}`, true);
  } finally {
    button.textContent = '★ 批量入库 ';
    button.append(Object.assign(document.createElement('span'), { textContent: state.boxSelectedIds.size }));
    updateBoxSelectionToolbar();
  }
}

function updateSelectionSummary() {
  const count = state.project?.segments.filter((segment) => segment.selected).length || 0;
  const total = state.project?.segments.length || 0;
  $('#selectedSummary').textContent = count === total ? '已全部选择' : `已选择 ${count}/${total}`;
  $('#exportCount').textContent = `${count} 段`;
  $('#exportButton').disabled = count === 0;
  $('#selectAll').textContent = count === total ? '取消全选' : '全选';
}

async function saveProjectUpdates() {
  if (!state.project) return;
  try {
    state.project = await api('/api/project/save', {
      method: 'POST',
      body: JSON.stringify({ id: state.project.id, segments: state.project.segments.map(({ id, label, selected, starred }) => ({ id, label, selected, starred: Boolean(starred) })) }),
    });
  } catch (error) { toast(error.message, true); }
}

function nudgeBoundary(target, direction) {
  const segment = state.project?.segments.find((item) => item.id === state.activeId);
  const source = segment && currentSource(segment);
  if (!segment || !source) return;
  const input = target === 'start' ? $('#startInput') : $('#endInput');
  const next = Number(input.value) + (direction / (Number(source.fps) || 30));
  input.value = Math.max(0, next).toFixed(3);
  const video = $('#previewVideo');
  video.currentTime = Math.max(0, next);
}

async function saveBoundary() {
  const segment = state.project?.segments.find((item) => item.id === state.activeId);
  if (!segment) return;
  const start = Number($('#startInput').value);
  const end = Number($('#endInput').value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return toast('出点必须晚于入点', true);
  const button = $('#saveBoundary');
  button.disabled = true;
  button.textContent = '正在保存…';
  try {
    state.project = await api('/api/project/segment-boundary', {
      method: 'POST',
      body: JSON.stringify({ id: state.project.id, segmentId: segment.id, start, end }),
    });
    activateSegment(state.activeId, false);
    updateSelectionSummary();
    toast('已按源视频帧率保存新的入点 / 出点');
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = '保存入点 / 出点'; }
}

async function runAiLabels(ids = null, triggerButton = null) {
  if (!state.project) return toast('请先打开一个项目', true);
  const provider = state.aiProvider || state.status?.ai?.provider || 'ollama';
  const model = provider === 'glm' ? state.status?.ai?.glm?.model : ($('#ollamaModel').value || state.status?.ollama?.visionModels?.[0]);
  if (!model) return toast('请先配置可用的视觉模型', true);
  const button = triggerButton || $('#aiLabel');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '正在生成标签…';
  try {
    state.project = await api('/api/project/ai-label', { method: 'POST', body: JSON.stringify({ id: state.project.id, provider, model, ids }) });
    renderProject();
    toast(`${provider === 'glm' ? 'GLM' : 'Ollama'} 已理解 ${ids?.length || state.project.segments.length} 个镜头`);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = original; }
}

async function chooseOutput(event) {
  if (nativeHost) {
    nativeBridge.postMessage('pick-output-folder');
    return;
  }
  try {
    const result = await requestBrowserPicker('folder', event, '正在打开…');
    if (result.paths?.[0]) $('#outputDir').value = result.paths[0];
  } catch (error) { toast(error.message, true); }
}

async function addVideoFolder(folder) {
  try {
    const result = await api('/api/list-folder', { method: 'POST', body: JSON.stringify({ path: folder }) });
    addFiles(result.paths || []);
  } catch (error) { toast(error.message, true); }
}

async function exportSelected() {
  const ids = state.project.segments.filter((segment) => segment.selected).map((segment) => segment.id);
  const button = $('#exportButton');
  const status = $('#exportStatus');
  button.disabled = true;
  button.innerHTML = '正在导出… <span>⌛</span>';
  status.className = 'export-status';
  status.textContent = `正在逐段导出 ${ids.length} 个镜头；窗口可以保持打开，失败片段不会中断其他镜头。`;
  $('#openLastExport').classList.add('hidden');
  setWorkflow(1);
  try {
    await saveProjectUpdates();
    const result = await api('/api/export', {
      method: 'POST',
      body: JSON.stringify({ id: state.project.id, ids, outputDir: $('#outputDir').value.trim(), accurate: state.exportMode === 'accurate' }),
    });
    const failed = result.failures?.length || 0;
    state.lastExportDir = result.outputDir;
    status.className = `export-status ${failed ? 'error' : 'success'}`;
    status.textContent = failed
      ? `完成 ${result.outputs.length}/${result.requested} 段；${failed} 段失败。首个原因：${result.failures[0].label} · ${result.failures[0].error}`
      : `已成功导出 ${result.outputs.length} 段到：${result.outputDir}`;
    $('#openLastExport').classList.remove('hidden');
    toast(failed ? `导出完成，${failed} 段失败` : `已导出 ${result.outputs.length} 个片段` , Boolean(failed));
  } catch (error) {
    status.className = 'export-status error';
    status.textContent = error.message;
    toast(error.message, true);
  }
  finally { button.disabled = false; button.innerHTML = '导出选中镜头 <span>→</span>'; }
}

function openMixDialog(context = 'project') {
  if (context === 'project' && !state.project) return toast('请先完成场景分析，再生成脚本混剪', true);
  if (context === 'library' && !state.library.items?.length) return toast('星标素材库还是空的', true);
  pauseAllPlayback();
  state.mixContext = context;
  state.mixPlan = null;
  $('#mixResult').classList.add('hidden');
  $('#mixContextTitle').textContent = context === 'library' ? '星标素材库混剪' : '脚本文案混剪';
  $('#includeLibrary').checked = context === 'library';
  $('#includeLibrary').disabled = context === 'library';
  $('#labelMixCandidates').classList.toggle('hidden', context === 'library');
  $('#applyMixSelection').classList.toggle('hidden', context === 'library');
  $('#mixDialog').showModal();
}

function renderMixPlan() {
  const plan = state.mixPlan;
  if (!plan) return;
  $('#mixResult').classList.remove('hidden');
  const coverage = Number(plan.semanticCoverage || 0);
  $('#mixSummary').textContent = `${plan.shotCount} 个镜头 · ${plan.duration.toFixed(1)} 秒 · 语义覆盖 ${coverage}/${plan.shotCount}`;
  $('#mixShotList').innerHTML = plan.shots.map((shot) => {
    const thumb = shot.thumbnailUrl || (shot.thumbnail && state.project ? `/api/thumb?project=${encodeURIComponent(state.project.id)}&name=${encodeURIComponent(shot.thumbnail)}` : '');
    return `<article class="mix-shot">
      <span class="mix-order">${String(shot.order).padStart(2, '0')}</span>
      <div class="mix-thumb">${thumb ? `<img src="${thumb}" alt="">` : ''}</div>
      <div class="mix-shot-copy"><b>${escapeHtml(shot.label)}</b><span>${escapeHtml(shot.beat)}</span><small>${escapeHtml(shot.reason)}</small></div>
      <time>${shot.duration.toFixed(2)}s</time>
    </article>`;
  }).join('');
}

async function generateMixPlan() {
  const script = $('#mixScript').value.trim();
  if (!script) return toast('请先粘贴混剪文案', true);
  const button = $('#generateMix');
  button.disabled = true;
  button.textContent = '正在规划叙事镜头…';
  try {
    state.mixPlan = await api('/api/project/script-match', {
      method: 'POST',
      body: JSON.stringify({
        id: state.project?.id,
        libraryOnly: state.mixContext === 'library',
        includeLibrary: state.mixContext !== 'library' && $('#includeLibrary').checked,
        script,
        matchMode: $('#mixMode').value,
        duration: Number($('#mixDuration').value),
        shotCount: Number($('#mixShotCount').value),
      }),
    });
    renderMixPlan();
    toast(`已生成 ${state.mixPlan.shotCount} 镜头叙事方案`);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = '重新生成混剪方案'; }
}

async function exportMixPlan() {
  if (!state.mixPlan) return;
  const button = $('#exportMix');
  button.disabled = true;
  button.textContent = '正在精确渲染粗剪…';
  try {
    const result = await api('/api/project/mix-export', {
      method: 'POST',
      body: JSON.stringify({ id: state.project?.id, libraryOnly: state.mixContext === 'library', planId: state.mixPlan.id, outputDir: $('#outputDir').value.trim() }),
    });
    toast(`粗剪已导出：${result.output}`);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = '导出单文件画面粗剪'; }
}

function setHookPath(file) {
  setHookPaths([file]);
}

function setHookPaths(files, replace = false) {
  pauseAllPlayback();
  const incoming = (files || []).map((file) => String(file || '').trim()).filter(Boolean);
  const values = [...new Set(replace ? incoming : [...state.hookPaths, ...incoming])];
  if (!values.length) return;
  state.hookPaths = values;
  state.hookPath = values[0];
  $('#hookName').textContent = values.length === 1 ? values[0].split(/[\\/]/).pop() : `已选择 ${values.length} 条钩子视频`;
  const existingPaths = new Set((state.project?.hooks || []).map((hook) => hook.path));
  const pending = values.filter((value) => !existingPaths.has(value));
  $('#hookMeta').textContent = state.project ? `${pending.length} 条新钩子等待处理；已有结果不会重复识别` : values.length === 1 ? values[0] : '将与空镜拆分同时调用视觉与叙事逻辑判断';
  $('#analyzeHook').disabled = !state.project || !pending.length;
  if (!state.project) {
    state.hook = null;
    state.hookBatch = null;
    $('#hookWorkbench').classList.add('hidden');
    $('#hookBatchResults').classList.add('hidden');
  }
  renderInitialHookSources();
  renderSources();
  if (state.project && pending.length) scheduleHookAutoAnalysis();
}

function scheduleHookAutoAnalysis() {
  clearTimeout(scheduleHookAutoAnalysis.timer);
  if (!state.project || state.hookAnalysisRunning) return;
  const existingPaths = new Set((state.project.hooks || []).map((hook) => hook.path));
  const pending = state.hookPaths.filter((value) => !existingPaths.has(value));
  if (!pending.length) return;
  const button = $('#analyzeHook');
  button.disabled = true;
  button.textContent = '即将自动识别…';
  scheduleHookAutoAnalysis.timer = setTimeout(() => analyzeHookVideo({ automatic: true }), 120);
}

async function chooseHookVideo(event) {
  pauseAllPlayback();
  if (nativeHost) {
    nativeBridge.postMessage('pick-hook-file');
    return;
  }
  try {
    const result = await requestBrowserPicker('files', event, '正在打开…');
    if (result.paths?.length) setHookPaths(result.paths);
  } catch (error) { toast(error.message, true); }
}

function setHookCut(value, seek = true) {
  if (!state.hook) return;
  const fps = Number(state.hook.info?.fps) || 30;
  const duration = Number(state.hook.info?.duration) || 0;
  state.hookCut = Math.max(1 / fps, Math.min(Number(value) || 0, duration - (1 / fps)));
  $('#hookCut').value = state.hookCut;
  $('#hookCutLabel').textContent = formatTime(state.hookCut);
  const extractedDuration = $('#extractedHookDuration');
  if (extractedDuration) extractedDuration.textContent = `0 → ${formatTime(state.hookCut)} · ${state.hookCut.toFixed(2)} 秒`;
  $('#confirmedHookSummary').textContent = `保留前 ${state.hookCut.toFixed(2)} 秒钩子 · 后段画面与音乐独立设置`;
  $$('#hookCandidates button').forEach((button) => button.classList.toggle('active', Math.abs(Number(button.dataset.cut) - state.hookCut) < 1 / fps));
  if (seek) $('#hookPreview').currentTime = state.hookCut;
  renderHookTimeline();
}

function setHookAutoSaveState(text, mode = '') {
  const node = $('#hookAutoSaveState');
  if (!node) return;
  node.textContent = text;
  node.className = mode;
}

function updateHookReviewControls() {
  const button = $('#continueToCompose');
  if (!button) return;
  const hooks = state.project?.hooks || [];
  if (!state.hook) {
    button.disabled = true;
    button.textContent = '等待选择钩子';
    return;
  }
  const pendingOthers = hooks.some((hook) => hook.id !== state.hook.id && !hook.humanReviewedAt);
  button.disabled = false;
  if (state.hook.humanReviewedAt) button.textContent = pendingOthers ? '前往下一条待审核 →' : '全部已检查，进入步骤三 →';
  else button.textContent = pendingOthers ? '保存本条，检查下一条 →' : '保存本条，进入步骤三 →';
}

async function saveCurrentHookReview(options = {}) {
  if (!state.project || !state.hook) return null;
  const hookId = state.hook.id;
  const cut = state.hookCut;
  const previousCut = Number(state.hook.confirmedCut || 0);
  const version = (state.hookReviewVersions[hookId] || 0) + 1;
  state.hookReviewVersions[hookId] = version;
  setHookAutoSaveState('正在自动保存…', 'saving');
  try {
    const saved = await api('/api/hook/review', {
      method: 'POST',
      body: JSON.stringify({ id: state.project.id, hookId, hookCut: cut }),
    });
    if (state.hookReviewVersions[hookId] !== version) return saved;
    state.project.hooks = (state.project.hooks || []).map((hook) => hook.id === hookId ? saved : hook);
    if (state.hookBatch) {
      state.hookBatch.hooks = state.project.hooks;
      state.hookBatch.autoConfirmed = state.project.hooks.filter((hook) => hook.confirmedCut).length;
      state.hookBatch.needsReview = state.project.hooks.filter((hook) => !hook.humanReviewedAt).length;
    }
    if (previousCut && Math.abs(previousCut - saved.confirmedCut) > 1 / (Number(saved.info?.fps) || 30) / 2) {
      delete state.hookPlans[hookId];
      if (state.project.hookPlans) delete state.project.hookPlans[hookId];
    }
    if (state.hook?.id === hookId) {
      state.hook = saved;
      state.project.hook = saved;
      state.hookCut = saved.confirmedCut;
      setHookAutoSaveState(`已自动保存 · ${formatTime(saved.confirmedCut)}`, 'saved');
    }
    renderHookBatchResults();
    updateHookReviewControls();
    return saved;
  } catch (error) {
    setHookAutoSaveState('自动保存失败', 'error');
    if (!options.silent) toast(error.message, true);
    throw error;
  }
}

function scheduleHookReviewSave() {
  clearTimeout(scheduleHookReviewSave.timer);
  scheduleHookReviewSave.timer = setTimeout(() => saveCurrentHookReview({ silent: true }).catch(() => {}), 320);
}

function replaceMediaSource(media, url) {
  media.pause();
  media.removeAttribute('src');
  media.load();
  media.src = url;
  media.load();
}

function stopMedia(media, unload = true) {
  if (!media) return;
  media.pause();
  media.removeAttribute('data-end');
  if (unload) {
    media.removeAttribute('src');
    media.removeAttribute('data-track-id');
    media.load();
  }
}

function cancelCompositionRender() {
  clearTimeout(markCompositionDirty.previewTimer);
  if (state.previewAbortController) state.previewAbortController.abort();
  state.previewAbortController = null;
  state.previewGenerationToken += 1;
  const button = $('#renderCompositionPreview');
  if (button) {
    button.disabled = false;
    button.textContent = '重新生成当前预览';
  }
}

function stopWorkflowPlayback() {
  $$('video, audio').forEach((media) => stopMedia(media, true));
}

function pauseAllPlayback(except = null) {
  $$('video, audio').forEach((media) => {
    if (media !== except) media.pause();
  });
}

function currentHookPlan() {
  return state.hook ? state.hookPlans[state.hook.id] || null : null;
}

function setCurrentHookPlan(clips, extra = {}) {
  if (!state.hook) return;
  const previous = currentHookPlan() || {};
  const plan = {
    ...previous,
    ...extra,
    hookId: state.hook.id,
    clips,
    mixDuration: Number(extra.mixDuration ?? previous.mixDuration ?? state.project?.workflowConfig?.mixDuration) || 0,
    useHook: (extra.useHook ?? previous.useHook) !== false,
    musicId: extra.musicId ?? previous.musicId ?? state.project?.musicTracks?.[0]?.id ?? '',
    musicStart: Number(extra.musicStart ?? previous.musicStart) || 0,
    musicAuto: Boolean(extra.musicAuto ?? previous.musicAuto),
    musicReuseTaskIds: [...new Set(extra.musicReuseTaskIds ?? previous.musicReuseTaskIds ?? [])],
    musicFadeOut: (extra.musicFadeOut ?? previous.musicFadeOut) !== false,
    updatedAt: new Date().toISOString(),
  };
  state.hookPlans[state.hook.id] = plan;
  state.hookClips = plan.clips;
  if (state.project) state.project.hookPlans = state.hookPlans;
}

async function persistAllHookPlans(silent = true) {
  if (!state.project) return;
  const editVersion = state.compositionEditVersion;
  const plansSnapshot = JSON.parse(JSON.stringify(state.hookPlans));
  try {
    const result = await api('/api/hook/plans/save', {
      method: 'POST',
      body: JSON.stringify({ id: state.project.id, plans: plansSnapshot }),
    });
    if (editVersion === state.compositionEditVersion) {
      state.hookPlans = result.hookPlans || state.hookPlans;
      state.project.hookPlans = state.hookPlans;
      if (state.hook && state.hookPlans[state.hook.id]) state.hookClips = state.hookPlans[state.hook.id].clips || [];
    }
    const status = $('#compositionAutoSave');
    if (status && editVersion === state.compositionEditVersion) status.textContent = '已自动保存并锁定';
  } catch (error) {
    const status = $('#compositionAutoSave');
    if (status) status.textContent = `自动保存失败：${error.message}`;
    if (!silent) toast(error.message, true);
    throw error;
  }
}

function scheduleHookPlanSave() {
  clearTimeout(scheduleHookPlanSave.timer);
  scheduleHookPlanSave.timer = setTimeout(() => persistAllHookPlans(true).catch(() => {}), 280);
}

async function activateHook(hookId, options = {}) {
  const hook = options.compose ? compositionTasks().find((item) => item.id === hookId) : (state.project?.hooks || []).find((item) => item.id === hookId);
  if (!hook) return;
  pauseAllPlayback();
  if (options.compose && state.hook?.id && state.hook.id !== hookId) cancelCompositionRender();
  if (options.compose && state.hook?.id && state.hook.id !== hookId) await persistAllHookPlans(true).catch(() => {});
  const token = ++state.hookActivationToken;
  state.hook = hook;
  if (!hook.isMixOnly) state.project.hook = hook;
  state.hookPath = hook.path || '';
  state.hookCut = hook.confirmedCut || hook.suggestedCut || 0;
  state.hookClips = state.hookPlans[hook.id]?.clips || [];
  if (options.compose) {
    const player = $('#compositionPreview');
    player.pause();
    player.removeAttribute('src');
    player.removeAttribute('data-end');
    player.load();
    $('#compositionPreviewEmpty').classList.remove('hidden');
    $('#compositionClipName').textContent = hook.name;
    $('#compositionClipMeta').textContent = '请选择时间线片段检查，或生成这一条钩子的整片预览。';
  } else renderHookAnalysis();
  renderHookBatchResults();
  renderComposeHookQueue();
  if (!hook.isMixOnly) api('/api/hook/select', { method: 'POST', body: JSON.stringify({ id: state.project.id, hookId }) }).catch(() => {});
  if (options.compose && (hook.confirmedCut || hook.isMixOnly) && !state.hookPlans[hook.id]) {
    await addSelectedToHookTimeline(hook.id);
    if (token !== state.hookActivationToken) return;
  } else if (options.compose) renderHookTimeline();
  if (options.compose && token === state.hookActivationToken) renderCompositionPreview(hook.id, { automatic: true }).catch(() => {});
  if (options.announce !== false) toast(hook.confirmedCut ? `正在调整：${hook.name}` : '这是低置信度结果，请确认切点');
}

function renderHookAnalysis() {
  if (!state.hook) return;
  const duration = Number(state.hook.info.duration);
  $('#hookWorkbench').classList.remove('hidden');
  $('#hookName').textContent = state.hook.name;
  $('#hookMeta').textContent = `${duration.toFixed(2)} 秒 · ${state.hook.info.width}×${state.hook.info.height} · 保留 ${state.hook.info.audioCodec} 原音轨`;
  replaceMediaSource($('#hookPreview'), `/api/hook/video?project=${encodeURIComponent(state.project.id)}&hook=${encodeURIComponent(state.hook.id)}`);
  $('#starCurrentHook').textContent = state.hook.starred ? '★ 已加入钩子星标库' : '☆ 将确认后的钩子加入星标库';
  $('#starCurrentHook').disabled = Boolean(state.hook.starred);
  const confidence = Number(state.hook.classification?.confidence || 0);
  updateHookReviewControls();
  $('#hookCut').max = Math.max(0.001, duration - 1 / (Number(state.hook.info.fps) || 30));
  const cuts = (state.hook.boundaries || []).slice(1, -1).slice(0, 24);
  $('#hookCandidates').innerHTML = cuts.length
    ? cuts.map((cut, index) => `<button data-cut="${cut}">${index === 0 ? '建议 ' : ''}${formatTime(cut)}</button>`).join('')
    : '<small>没有检测到明显硬切，请用滑杆手动确认。</small>';
  $$('#hookCandidates button').forEach((button) => button.addEventListener('click', () => {
    setHookCut(Number(button.dataset.cut));
    saveCurrentHookReview().catch(() => {});
  }));
  setHookCut(state.hookCut || state.hook.suggestedCut || Math.min(1.5, duration * .25), false);
  setHookAutoSaveState(state.hook.humanReviewedAt ? `已自动保存 · ${formatTime(state.hook.confirmedCut)}` : `AI 已标注 · ${Math.round(confidence * 100)}% · 待检查`, state.hook.humanReviewedAt ? 'saved' : '');
}

async function starCurrentHook() {
  if (!state.project || !state.hook) return;
  try {
    const saved = await saveCurrentHookReview();
    await api('/api/library/star-hook', { method: 'POST', body: JSON.stringify({ projectId: state.project.id, hookId: saved.id }) });
    saved.starred = true;
    state.hook = saved;
    state.project.hooks = state.project.hooks.map((item) => item.id === saved.id ? saved : item);
    $('#starCurrentHook').textContent = '★ 已加入钩子星标库';
    $('#starCurrentHook').disabled = true;
    await refreshStatus();
    toast('钩子已保存到星标库，可在其他项目中手动使用');
  } catch (error) { toast(error.message, true); }
}

async function analyzeHookVideo(options = {}) {
  if (!state.project || !(state.hookPaths.length || state.hookPath)) return;
  if (state.hookAnalysisRunning) return;
  const existingPaths = new Set((state.project.hooks || []).map((hook) => hook.path));
  const pendingPaths = (state.hookPaths.length ? state.hookPaths : [state.hookPath]).filter((value) => !existingPaths.has(value));
  if (!pendingPaths.length) return toast('没有新的钩子需要识别');
  const button = $('#analyzeHook');
  state.hookAnalysisRunning = true;
  button.disabled = true;
  button.textContent = options.automatic ? '正在自动识别…' : '正在队列处理…';
  let succeeded = false;
  try {
    const analyzedBatch = await api('/api/hook/batch-analyze', {
      method: 'POST',
      body: JSON.stringify({
        id: state.project.id,
        paths: pendingPaths,
        threshold: 0.16,
        provider: state.aiProvider || state.status?.ai?.provider,
        model: state.aiProvider === 'glm' ? state.status?.ai?.glm?.model : state.status?.ollama?.visionModels?.[0],
      }),
    });
    const incomingPaths = new Set((analyzedBatch.hooks || []).map((hook) => hook.path));
    state.project.hooks = [...(state.project.hooks || []).filter((hook) => !incomingPaths.has(hook.path)), ...(analyzedBatch.hooks || [])];
    state.hookBatch = {
      hooks: state.project.hooks,
      failures: analyzedBatch.failures || [],
      autoConfirmed: state.project.hooks.filter((hook) => hook.confirmedCut).length,
      needsReview: state.project.hooks.filter((hook) => !hook.confirmedCut).length,
    };
    state.hook = analyzedBatch.hooks.find((hook) => !hook.humanReviewedAt) || analyzedBatch.hooks[0] || state.hook || null;
    if (state.hook) {
      state.project.hook = state.hook;
      state.hookCut = state.hook.confirmedCut || state.hook.suggestedCut;
      await activateHook(state.hook.id, { announce: false });
    }
    renderHookBatchResults();
    showWorkflowPage('extract');
    succeeded = true;
    toast(`新增处理完成：当前共 ${state.hookBatch.autoConfirmed} 条自动确认，${state.hookBatch.needsReview} 条需要人工复核`);
  } catch (error) {
    toast(options.automatic ? `自动识别未完成：${error.message}；可点击“加入队列处理”重试` : error.message, true);
  } finally {
    state.hookAnalysisRunning = false;
    const known = new Set((state.project?.hooks || []).map((hook) => hook.path));
    const remaining = state.hookPaths.filter((value) => !known.has(value));
    button.disabled = !remaining.length;
    button.textContent = remaining.length ? '加入队列处理' : '识别已完成';
    if (succeeded && remaining.length) scheduleHookAutoAnalysis();
  }
}

function warmHookMediaCache(hooks) {
  for (const hook of hooks.filter((item) => item.id !== state.hook?.id).slice(0, 3)) {
    const url = `/api/hook/video?project=${encodeURIComponent(state.project.id)}&hook=${encodeURIComponent(hook.id)}`;
    fetch(url, { headers: { Range: 'bytes=0-1048575' }, cache: 'force-cache' }).catch(() => {});
  }
}

function clearHookReviewPanel() {
  state.hook = null;
  state.hookPath = '';
  state.hookCut = 0;
  state.hookClips = [];
  for (const selector of ['#hookPreview']) {
    const media = $(selector);
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
  $('#hookName').textContent = '当前项目没有钩子';
  $('#hookMeta').textContent = '可继续添加新的钩子视频；已删除项目不会影响原始文件';
  $('#hookCandidates').innerHTML = '<small>添加钩子后在这里核验切点。</small>';
  $('#hookCutLabel').textContent = '00:00.000';
  const extractedDuration = $('#extractedHookDuration');
  if (extractedDuration) extractedDuration.textContent = '等待选择钩子';
  setHookAutoSaveState('等待选择钩子');
  updateHookReviewControls();
}

async function deleteHookFromProject(hookId) {
  const hook = (state.project?.hooks || []).find((item) => item.id === hookId);
  if (!hook) return;
  const accepted = confirm(`确定从当前项目移除“${hook.name}”吗？\n\n它将不再进入组合和整体导出；原始视频不会被删除。`);
  if (!accepted) return;
  clearTimeout(scheduleHookReviewSave.timer);
  const wasCurrent = state.hook?.id === hookId;
  if (wasCurrent) await saveCurrentHookReview({ silent: true }).catch(() => {});
  try {
    const result = await api('/api/hook/delete', {
      method: 'POST',
      body: JSON.stringify({ id: state.project.id, hookId }),
    });
    state.project.hooks = result.hooks || [];
    state.project.hook = result.hook || null;
    state.project.hookPlans = result.hookPlans || {};
    state.hookPlans = state.project.hookPlans;
    state.hookPaths = state.project.hooks.map((item) => item.path);
    state.hookPath = state.project.hook?.path || '';
    if (state.hookBatch) {
      state.hookBatch.hooks = state.project.hooks;
      state.hookBatch.autoConfirmed = state.project.hooks.filter((item) => item.confirmedCut).length;
      state.hookBatch.needsReview = state.project.hooks.filter((item) => !item.humanReviewedAt).length;
    }
    if (wasCurrent) {
      if (result.hook) await activateHook(result.hook.id, { announce: false });
      else clearHookReviewPanel();
    } else renderHookBatchResults();
    renderInitialHookSources();
    renderSources();
    toast(`已从项目移除：${hook.name}；原始视频仍保留`);
  } catch (error) { toast(error.message, true); }
}

function renderHookBatchResults() {
  const batch = state.hookBatch;
  // The project array is the live, autosaved source of truth. hookBatch is only
  // the initial analysis summary and must not overwrite review progress.
  const hooks = state.project?.hooks || batch?.hooks || [];
  const failuresList = batch?.failures || [];
  $('#autoHookCount').textContent = hooks.filter((hook) => hook.confirmedCut).length;
  const reviewed = hooks.filter((hook) => hook.humanReviewedAt).length;
  $('#reviewHookCount').textContent = hooks.length - reviewed;
  $('#failedHookCount').textContent = failuresList.length;
  $('#hookReviewProgress').textContent = `${reviewed} / ${hooks.length}`;
  updateHookReviewControls();
  if (!batch && !hooks.length) return;
  const orderedHooks = [...hooks];
  const cards = orderedHooks.map((hook) => {
    const confidence = Math.round(Number(hook.classification?.confidence || 0) * 100);
    const review = !hook.humanReviewedAt;
    const status = hook.humanReviewedAt ? '已检查' : hook.confirmedCut ? `AI 已标注 · ${confidence}%` : `待调整 · ${confidence}%`;
    return `<div class="hook-batch-card${review ? ' review' : ''}${state.hook?.id === hook.id ? ' active' : ''}"><button class="hook-batch-open" data-select-hook="${hook.id}"><div><b>${escapeHtml(hook.name)}</b><small>钩子结束 ${Number(hook.confirmedCut || hook.suggestedCut).toFixed(2)}s · ${escapeHtml(hook.classification?.reason || '场景逻辑判断')}</small></div><em>${status}</em></button><button class="hook-delete" data-delete-hook="${hook.id}" title="从项目移除，不删除原视频">删除</button></div>`;
  });
  const failures = failuresList.map((item) => `<div class="hook-batch-card failed"><div><b>${escapeHtml(String(item.path || '').split(/[\\/]/).pop())}</b><small>${escapeHtml(item.error)}</small></div><em>失败</em></div>`);
  $('#hookBatchResults').innerHTML = [...cards, ...failures].join('');
  $('#hookBatchResults').classList.toggle('hidden', !cards.length && !failures.length);
  $$('[data-select-hook]').forEach((button) => button.addEventListener('click', async () => {
    if (state.hook && state.hook.id !== button.dataset.selectHook) await saveCurrentHookReview().catch(() => {});
    await activateHook(button.dataset.selectHook);
  }));
  $$('[data-delete-hook]').forEach((button) => button.addEventListener('click', () => deleteHookFromProject(button.dataset.deleteHook)));
  warmHookMediaCache(orderedHooks);
}

async function confirmHookAndCompose() {
  if (!state.hook) return;
  const button = $('#continueToCompose');
  button.disabled = true;
  button.textContent = '正在自动保存…';
  try {
    const currentId = state.hook.id;
    if (!state.hook.humanReviewedAt) await saveCurrentHookReview();
    const hooks = state.project.hooks || [];
    const currentIndex = hooks.findIndex((hook) => hook.id === currentId);
    const next = hooks.slice(currentIndex + 1).find((hook) => !hook.humanReviewedAt) || hooks.find((hook) => !hook.humanReviewedAt);
    if (next) await activateHook(next.id, { announce: false });
    else showHookStage('compose');
  } catch (error) { toast(error.message, true); }
  finally {
    updateHookReviewControls();
  }
}

function transitionLabel(type) {
  return type === 'black' ? '黑场' : type === 'dissolve' ? '交叉溶解' : '直切';
}

function markCompositionDirty() {
  state.compositionEditVersion += 1;
  state.compositionPreviewReady = false;
  state.compositionPreviewUrl = '';
  if (state.hook) {
    const plan = currentHookPlan();
    if (plan) {
      plan.previewReady = false;
      plan.confirmed = true;
      plan.updatedAt = new Date().toISOString();
      state.project.hookPlans = state.hookPlans;
      const saveStatus = $('#compositionAutoSave');
      if (saveStatus) saveStatus.textContent = '正在自动保存并锁定…';
      scheduleHookPlanSave();
    }
  }
  renderComposeHookQueue();
  const status = $('#compositionPreviewStatus');
  if (status) status.textContent = '计划已有变动；可逐段检查，或重新生成整条预览。';
  clearTimeout(markCompositionDirty.previewTimer);
  const hookId = state.hook?.id;
  if (hookId && state.workflowPage === 'compose') {
    markCompositionDirty.previewTimer = setTimeout(() => renderCompositionPreview(hookId, { automatic: true }).catch(() => {}), 900);
  }
}

function playCompositionClip(kind, index = -1) {
  if (!state.project || !state.hook) return;
  const video = $('#compositionPreview');
  pauseAllPlayback(video);
  let start = 0;
  let end = Number(state.hookCut) || 0;
  if (kind === 'hook') {
    replaceMediaSource(video, `/api/hook/video?project=${encodeURIComponent(state.project.id)}&hook=${encodeURIComponent(state.hook.id)}`);
    $('#compositionClipName').textContent = state.hook.name;
    $('#compositionClipMeta').textContent = `钩子原画面 · 00:00.000 → ${formatTime(end)} · ${end.toFixed(2)} 秒`;
  } else {
    const clip = state.hookClips[index];
    const segment = clip && state.project.segments.find((item) => item.id === clip.segmentId);
    const source = segment && currentSource(segment);
    if (!clip || !segment || !source) return;
    start = Number(segment.start) || 0;
    end = start + Math.min(Number(clip.duration) || segment.duration, segment.duration);
    replaceMediaSource(video, `/api/video?project=${encodeURIComponent(state.project.id)}&file=${encodeURIComponent(source.id)}`);
    $('#compositionClipName').textContent = `${String(index + 1).padStart(2, '0')} · ${segment.label}`;
    $('#compositionClipMeta').textContent = `${source.name} · ${formatTime(start)} → ${formatTime(end)} · 使用 ${(end - start).toFixed(2)} 秒 · 进入方式：${transitionLabel(clip.transition)}`;
  }
  video.dataset.end = end;
  video.addEventListener('loadedmetadata', () => { video.currentTime = start; video.play().catch(() => {}); }, { once: true });
  $('#compositionPreviewEmpty').classList.add('hidden');
}

async function renderCompositionPreview(requestedHookId = state.hook?.id, options = {}) {
  cancelCompositionRender();
  const hook = compositionTasks().find((item) => item.id === requestedHookId);
  const plan = state.hookPlans[requestedHookId];
  const requiresClips = state.project.workflowConfig?.useBroll !== false;
  if (!hook || !plan || (requiresClips && !plan.clips?.length)) {
    if (!options.automatic) toast('当前成片还没有可预览的组合', true);
    return;
  }
  const token = ++state.previewGenerationToken;
  const controller = new AbortController();
  state.previewAbortController = controller;
  const button = $('#renderCompositionPreview');
  button.disabled = true;
  button.textContent = '正在生成当前预览…';
  if (state.hook?.id === requestedHookId) {
    const player = $('#compositionPreview');
    player.pause();
    player.removeAttribute('src');
    player.removeAttribute('data-end');
    player.load();
    $('#compositionPreviewEmpty').classList.remove('hidden');
    $('#compositionPreviewStatus').textContent = '正在按当前顺序与转场自动渲染这一条低清预览…';
  }
  try {
    const result = await api('/api/hook/preview', {
      method: 'POST',
      body: JSON.stringify({ id: state.project.id, taskId: requestedHookId, hookId: hook.isMixOnly ? '' : hook.id, clips: plan.clips, mixDuration: plan.mixDuration, useHook: plan.useHook !== false, musicId: plan.musicId, musicStart: plan.musicStart, musicReuseTaskIds: plan.musicReuseTaskIds || [], musicFadeOut: plan.musicFadeOut !== false }),
      signal: controller.signal,
    });
    if (token !== state.previewGenerationToken || state.hook?.id !== requestedHookId) return;
    state.compositionPreviewReady = true;
    state.compositionPreviewUrl = result.previewUrl;
    const video = $('#compositionPreview');
    video.removeAttribute('data-end');
    replaceMediaSource(video, state.compositionPreviewUrl);
    $('#compositionPreviewEmpty').classList.add('hidden');
    $('#compositionClipName').textContent = '整条组合预览';
    $('#compositionClipMeta').textContent = `${result.duration.toFixed(2)} 秒 · ${result.clipCount} 个混剪片段 · ${result.useHook ? '包含钩子片段' : '纯混剪从 0 秒开始'}`;
    $('#compositionPreviewStatus').textContent = '整条预览已更新；确认无误后可直接导出。';
    const savedPlan = state.hookPlans[requestedHookId];
    if (savedPlan) {
      savedPlan.previewReady = true;
      savedPlan.updatedAt = new Date().toISOString();
      scheduleHookPlanSave();
      renderComposeHookQueue();
    }
    video.play().catch(() => {});
  } catch (error) {
    if (controller.signal.aborted || error.name === 'AbortError') return;
    if (token === state.previewGenerationToken && state.hook?.id === requestedHookId) {
      $('#compositionPreviewStatus').textContent = error.message;
      toast(error.message, true);
    }
  } finally {
    if (state.previewAbortController === controller) state.previewAbortController = null;
    if (token === state.previewGenerationToken) {
      button.disabled = false;
      button.textContent = '重新生成当前预览';
    }
  }
}

function estimatedHookCoverage() {
  let value = currentHookPlan()?.useHook === false ? 0 : Number(state.hookCut) || 0;
  for (const clip of state.hookClips) {
    const segment = state.project?.segments.find((item) => item.id === clip.segmentId);
    if (!segment) continue;
    value += Math.max(0, Number(clip.duration || segment.duration) - (clip.transition === 'black' ? .14 : clip.transition === 'dissolve' ? .24 : 0));
  }
  return value;
}

function estimatedMixCoverage() {
  let value = 0;
  for (const clip of state.hookClips) value += Math.max(0, Number(clip.duration) - (clip.transition === 'black' ? .14 : clip.transition === 'dissolve' ? .24 : 0));
  return value;
}

function compositionTasks() {
  if (!state.project) return [];
  const config = state.project.workflowConfig || {};
  if (config.useHooks !== false) return (state.project.hooks || []).filter((hook) => hook.confirmedCut && hook.humanReviewedAt);
  return Array.from({ length: Math.max(1, Number(config.outputCount) || 1) }, (_, index) => ({
    id: `mix_${index + 1}`, name: `纯混剪 ${String(index + 1).padStart(2, '0')}`, isMixOnly: true,
    confirmedCut: 0, humanReviewedAt: new Date().toISOString(), info: { duration: Number(config.mixDuration) || 15, width: 1080, height: 1920 },
  }));
}

function confirmedHooks() {
  return compositionTasks();
}

function renderComposeHookQueue() {
  const hooks = confirmedHooks();
  const currentIndex = hooks.findIndex((hook) => hook.id === state.hook?.id);
  $('#composeHookProgress').textContent = currentIndex >= 0 ? `${currentIndex + 1} / ${hooks.length}` : `0 / ${hooks.length}`;
  $('#previousComposeHook').disabled = currentIndex <= 0;
  $('#nextComposeHook').disabled = currentIndex < 0 || currentIndex >= hooks.length - 1;
  $('#composeHookQueue').innerHTML = hooks.map((hook, index) => {
    const plan = state.hookPlans[hook.id];
    const count = plan?.clips?.length || 0;
    const ready = Boolean(plan?.previewReady);
    const locked = Boolean(plan?.confirmed);
    const mixOnly = hook.isMixOnly || plan?.useHook === false;
    return `<button class="compose-hook-card${hook.id === state.hook?.id ? ' active' : ''}" data-compose-hook="${hook.id}"><span>${String(index + 1).padStart(2, '0')}</span><div><b>${escapeHtml(hook.name)}</b><small>${mixOnly ? '纯混剪 · ' : ''}${count ? `${count} 个片段${locked ? ' · 已自动保存锁定' : ready ? ' · 预览已生成' : ' · 待检查'}` : state.project.workflowConfig?.useBroll ? '尚未生成组合' : '可直接导出'}</small></div><em>${hook.id === state.hook?.id ? '正在调整' : '打开'}</em></button>`;
  }).join('');
  $$('[data-compose-hook]').forEach((button) => button.addEventListener('click', () => activateHook(button.dataset.composeHook, { compose: true })));
}

function navigateComposeHook(direction) {
  const hooks = confirmedHooks();
  const index = hooks.findIndex((hook) => hook.id === state.hook?.id);
  const next = hooks[index + direction];
  if (next) activateHook(next.id, { compose: true });
}

function reorderTimelineClip(from, to) {
  if (from < 0 || to < 0 || from === to || !state.hookClips[from]) return false;
  const [moved] = state.hookClips.splice(from, 1);
  state.hookClips.splice(to, 0, moved);
  state.draggedClipIndex = -1;
  markCompositionDirty();
  renderHookTimeline();
  return true;
}

function renderHookTimeline() {
  if (!state.hook || !state.project) return;
  const plan = currentHookPlan() || {};
  const mixDuration = state.project.workflowConfig?.useBroll === false ? 0 : Math.max(1, Number(plan.mixDuration ?? state.project.workflowConfig?.mixDuration) || 15);
  const coverage = estimatedMixCoverage();
  const remaining = Math.max(0, mixDuration - coverage);
  $('#timelineCoverage').textContent = remaining > .034
    ? `混剪画面已覆盖 ${Math.min(coverage, mixDuration).toFixed(2)} / ${mixDuration.toFixed(2)} 秒 · 还差 ${remaining.toFixed(2)} 秒`
    : mixDuration ? `已达到 ${mixDuration.toFixed(2)} 秒目标 · 超出部分导出时裁掉` : `仅导出钩子 · 无需混剪画面`;
  $('#timelineCoverage').style.color = remaining > .034 ? '#e6b85c' : '#67e5ec';
  const useHook = plan.useHook !== false;
  const hookCard = state.hook.isMixOnly ? '' : `<article class="timeline-clip hook${useHook ? '' : ' hook-disabled'}" data-preview-hook><label class="hook-use-toggle"><input id="compositionUseHook" type="checkbox"${useHook ? ' checked' : ''}><span>使用钩子</span></label><div class="timeline-thumb hook-thumb"><span>HOOK</span><i>▶</i></div><span class="timeline-clip-tag">${useHook ? '钩子片段' : '纯混剪'}</span><b>${escapeHtml(state.hook.name)}</b><small>${useHook ? `0 → ${state.hookCut.toFixed(2)}s` : '关闭钩子 · 从 0 秒开始'}</small></article>`;
  const clips = state.hookClips.map((clip, index) => {
    const segment = state.project.segments.find((item) => item.id === clip.segmentId);
    if (!segment) return '';
    const source = currentSource(segment);
    const layout = sourceLayout(source, segment);
    const thumbnail = segment.thumbnailUrl || (segment.thumbnail ? `/api/thumb?project=${encodeURIComponent(state.project.id)}&name=${encodeURIComponent(segment.thumbnail)}` : '');
    return `<article class="timeline-clip" data-timeline-index="${index}" data-segment-id="${segment.id}" draggable="true">
      <div class="timeline-drag-handle" draggable="true" title="拖动调整顺序">⠿ 拖动排序</div>
      <button class="timeline-thumb" data-preview-clip="${index}" style="${thumbnail ? `background-image:url('${thumbnail}')` : ''}"><i>▶</i></button>
      <span class="timeline-clip-tag">画面 ${String(index + 1).padStart(2, '0')}<em class="timeline-layout ${layout}">${layout === 'triple' ? '三宫格' : '竖屏'}</em></span><b>${escapeHtml(segment.label)}</b><small>${clip.auto ? '自动铺设' : '人工选择'}</small>
      <small class="timeline-source">${escapeHtml(source?.name || '')} · ${formatTime(segment.start)}</small>
      <input class="clip-duration" data-clip-duration="${index}" type="number" min="0.04" max="${Number(segment.duration).toFixed(3)}" step="0.05" value="${Number(clip.duration || segment.duration).toFixed(2)}" title="实际使用时长（秒）">
      <select data-transition="${index}" aria-label="进入这个片段的转场">
        <option value="cut"${clip.transition === 'cut' ? ' selected' : ''}>直切</option>
        <option value="black"${clip.transition === 'black' ? ' selected' : ''}>黑场</option>
        <option value="dissolve"${clip.transition === 'dissolve' ? ' selected' : ''}>交叉溶解</option>
      </select>
      <div class="timeline-actions"><button data-replace="${index}" title="替换画面或在此处加入多条">换</button><button data-remove="${index}" title="移除">×</button></div>
    </article>`;
  }).join('');
  $('#hookTimeline').innerHTML = hookCard + clips;
  $('[data-preview-hook]')?.addEventListener('click', (event) => { if (!event.target.closest('select,input,label') && useHook) playCompositionClip('hook'); });
  $('#compositionUseHook')?.addEventListener('change', (event) => {
    const enabled = event.currentTarget.checked;
    const savedPlan = currentHookPlan();
    if (!savedPlan) setCurrentHookPlan([...state.hookClips], { useHook: enabled, confirmed: true });
    else {
      state.hookPlans[state.hook.id] = { ...savedPlan, useHook: enabled, clips: savedPlan.clips || state.hookClips };
      state.project.hookPlans = state.hookPlans;
      state.hookClips = state.hookPlans[state.hook.id].clips;
    }
    $('#confirmedHookSummary').textContent = enabled
      ? `保留前 ${state.hookCut.toFixed(2)} 秒钩子 · 后段画面与音乐独立设置`
      : '纯混剪模式 · 从第 0 秒开始渲染与导出';
    markCompositionDirty();
    renderHookTimeline();
    toast(enabled ? '已启用钩子片段' : '已关闭钩子，将从第 0 秒输出纯混剪');
  });
  $$('[data-preview-clip]').forEach((button) => button.addEventListener('click', () => playCompositionClip('segment', Number(button.dataset.previewClip))));
  $$('[data-transition]').forEach((select) => select.addEventListener('change', () => {
    state.hookClips[Number(select.dataset.transition)].transition = select.value;
    markCompositionDirty();
    renderHookTimeline();
  }));
  $$('[data-clip-duration]').forEach((input) => input.addEventListener('change', () => {
    const index = Number(input.dataset.clipDuration);
    const segment = state.project.segments.find((item) => item.id === state.hookClips[index]?.segmentId);
    state.hookClips[index].duration = Math.max(1 / 30, Math.min(Number(input.value) || 0, Number(segment?.duration) || 0));
    markCompositionDirty(); renderHookTimeline();
  }));
  $$('[data-timeline-index]').forEach((card) => {
    const handle = card.querySelector('.timeline-drag-handle');
    handle?.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const from = Number(card.dataset.timelineIndex);
      state.draggedClipIndex = from;
      card.classList.add('dragging');
      const move = (pointerEvent) => {
        const target = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest('[data-timeline-index]');
        $$('[data-timeline-index]').forEach((item) => item.classList.toggle('drag-over', item === target && item !== card));
      };
      const up = (pointerEvent) => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        const target = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)?.closest('[data-timeline-index]');
        const to = Number(target?.dataset.timelineIndex ?? -1);
        $$('[data-timeline-index]').forEach((item) => item.classList.remove('dragging', 'drag-over'));
        if (!reorderTimelineClip(from, to)) state.draggedClipIndex = -1;
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up, { once: true });
    });
    card.addEventListener('dragstart', (event) => {
      state.draggedClipIndex = Number(card.dataset.timelineIndex);
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', card.dataset.timelineIndex);
    });
    card.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      const from = state.draggedClipIndex;
      const to = Number(card.dataset.timelineIndex);
      reorderTimelineClip(from, to);
    });
    card.addEventListener('dragend', () => {
      state.draggedClipIndex = -1;
      $$('[data-timeline-index]').forEach((item) => item.classList.remove('dragging', 'drag-over'));
    });
  });
  $$('[data-remove]').forEach((button) => button.addEventListener('click', () => {
    state.hookClips.splice(Number(button.dataset.remove), 1);
    markCompositionDirty();
    renderHookTimeline();
  }));
  $$('[data-replace]').forEach((button) => button.addEventListener('click', () => openClipPicker('replace', Number(button.dataset.replace))));
  $('#compositionMixDuration').value = mixDuration || state.project.workflowConfig?.mixDuration || 15;
  $('#compositionMixDuration').disabled = !state.project.workflowConfig?.useBroll;
  $$('[data-duration-preset]').forEach((button) => {
    button.disabled = !state.project.workflowConfig?.useBroll;
    button.classList.toggle('active', Math.abs(Number(button.dataset.durationPreset) - mixDuration) < .01);
  });
  const fadeToggle = $('#compositionMusicFade');
  fadeToggle.checked = plan.musicFadeOut !== false;
  fadeToggle.disabled = !state.project.workflowConfig?.useBroll || !state.project.workflowConfig?.useMusic || !(state.project.musicTracks || []).length;
  $('#addSelectedToTimeline').classList.toggle('hidden', !state.project.workflowConfig?.useBroll);
  $('#openClipPicker').classList.toggle('hidden', !state.project.workflowConfig?.useBroll);
  renderCompositionMusic();
  if ($('#clipPickerDialog').open) renderClipPicker();
  renderComposeHookQueue();
}

function usedSegmentIdsForOtherTasks() {
  const used = new Set();
  for (const [taskId, plan] of Object.entries(state.hookPlans || {})) {
    if (taskId === state.hook?.id || !plan?.confirmed) continue;
    for (const clip of plan.clips || []) used.add(clip.segmentId);
  }
  return used;
}

function reactivateCompositionSegment(segmentId) {
  const used = usedSegmentIdsForOtherTasks();
  const current = new Set(state.hookClips.map((clip) => clip.segmentId));
  const replaceTargetId = state.hookClips[state.replacingClipIndex]?.segmentId;
  if (current.has(segmentId) && segmentId !== replaceTargetId) {
    toast('这个片段已在当前成片中使用，不能重复添加', true);
    return false;
  }
  if (!used.has(segmentId)) {
    return false;
  }
  const plan = currentHookPlan();
  if (!plan) return false;
  if (!(plan.segmentReuseIds || []).includes(segmentId)) {
    plan.segmentReuseIds = [...new Set([...(plan.segmentReuseIds || []), segmentId])];
    markCompositionDirty();
  }
  state.clipPickerSelection.add(segmentId);
  renderClipPicker();
  requestAnimationFrame(() => {
    const card = $(`[data-choose-clip="${CSS.escape(segmentId)}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    card.classList.add('just-reactivated');
    setTimeout(() => card.classList.remove('just-reactivated'), 900);
  });
  toast('已重新启用并移入可用素材区');
  return true;
}

function openClipPicker(mode = 'add', index = -1) {
  if (!state.project || !state.hook || state.project.workflowConfig?.useBroll === false) return;
  state.clipPickerMode = mode;
  state.clipPickerSource = 'project';
  state.replacingClipIndex = mode === 'replace' ? index : -1;
  state.clipPickerSelection.clear();
  $('#clipPickerTitle').textContent = mode === 'replace' ? `替换画面 ${String(index + 1).padStart(2, '0')}` : '批量添加素材';
  $('#applyClipPickerSelection').textContent = mode === 'replace' ? '替换并插入选中素材' : '添加选中素材';
  stopMedia($('#clipPickerPreview'), true);
  $('.clip-picker-preview').classList.remove('has-media');
  $('#clipPickerPreviewName').textContent = '选择素材查看画面';
  $('#clipPickerPreviewMeta').textContent = '点击右侧素材即可预览并加入选择。';
  renderClipPicker();
  const dialog = $('#clipPickerDialog');
  if (!dialog.open) dialog.showModal();
  api('/api/library').then((library) => {
    state.library = library;
    if (dialog.open) renderClipPicker();
  }).catch((error) => {
    if (dialog.open) toast(`星标素材库读取失败：${error.message}`, true);
  });
}

function closeClipPicker() {
  state.replacingClipIndex = -1;
  state.clipPickerSelection.clear();
  stopMedia($('#clipPickerPreview'), true);
  const dialog = $('#clipPickerDialog');
  if (dialog.open) dialog.close();
}

function previewClipChoice(segment) {
  const source = currentSource(segment);
  if (!source) return;
  const video = $('#clipPickerPreview');
  const start = Number(segment.start) || 0;
  const end = Number(segment.end) || start + Number(segment.duration) || start;
  pauseAllPlayback(video);
  $('.clip-picker-preview').classList.add('has-media');
  replaceMediaSource(video, `/api/video?project=${encodeURIComponent(state.project.id)}&file=${encodeURIComponent(source.id)}`);
  video.dataset.end = end;
  video.addEventListener('loadedmetadata', () => {
    video.currentTime = start;
    video.play().catch(() => {});
  }, { once: true });
  $('#clipPickerPreviewName').textContent = segment.label;
  $('#clipPickerPreviewMeta').textContent = `${source.name} · ${formatTime(start)} → ${formatTime(end)} · ${Number(segment.duration).toFixed(2)} 秒`;
}

function previewLibraryClipChoice(item) {
  if (!item?.hasClip) return;
  const video = $('#clipPickerPreview');
  const end = Number(item.duration) || 0;
  pauseAllPlayback(video);
  $('.clip-picker-preview').classList.add('has-media');
  replaceMediaSource(video, `/api/library/video?id=${encodeURIComponent(item.id)}`);
  video.dataset.end = end;
  video.addEventListener('loadedmetadata', () => {
    video.currentTime = 0;
    video.play().catch(() => {});
  }, { once: true });
  $('#clipPickerPreviewName').textContent = item.label || item.sourceName || '星标素材';
  $('#clipPickerPreviewMeta').textContent = `星标素材库 · ${item.sourceName || '本地素材'} · ${end.toFixed(2)} 秒`;
}

function libraryClipSelectionKey(item) {
  const existing = state.project?.segments.find((segment) => segment.libraryId === item.id);
  return existing?.id || `library:${item.id}`;
}

function renderClipPicker() {
  if (!state.project || !state.hook) return;
  $('#clipPickerDialog').classList.toggle('library-source', state.clipPickerSource === 'library');
  const used = usedSegmentIdsForOtherTasks();
  const current = new Set(state.hookClips.map((clip) => clip.segmentId));
  const plan = currentHookPlan() || {};
  const reactivated = new Set(plan.segmentReuseIds || []);
  const replaceTargetId = state.hookClips[state.replacingClipIndex]?.segmentId;
  const unavailable = (segment) => (used.has(segment.id) && !reactivated.has(segment.id)) || (current.has(segment.id) && segment.id !== replaceTargetId);
  const libraryItems = (state.library.items || []).filter((item) => (item.type || 'broll') === 'broll');
  $('#projectClipPickerCount').textContent = state.project.segments.length;
  $('#libraryClipPickerCount').textContent = libraryItems.length;
  $$('[data-clip-source]').forEach((button) => {
    const active = button.dataset.clipSource === state.clipPickerSource;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  if (state.clipPickerSource === 'library') {
    $('#clipPickerHint').textContent = '这里仅显示星标素材库；选中后会自动加入当前项目，并插入成片时间线。';
    $('#clipPickerGrid').innerHTML = libraryItems.length ? libraryItems.map((item) => {
      const existing = state.project.segments.find((segment) => segment.libraryId === item.id);
      const key = libraryClipSelectionKey(item);
      const disabled = !item.hasClip || (existing && unavailable(existing));
      const selected = state.clipPickerSelection.has(key);
      const reusable = Boolean(existing && used.has(existing.id) && !reactivated.has(existing.id) && (!current.has(existing.id) || existing.id === replaceTargetId));
      const status = !item.hasClip ? '源文件不可用' : reusable ? '已被其他成片使用 · 双击重新激活' : existing && current.has(existing.id) && existing.id !== replaceTargetId ? '当前成片已使用' : existing ? '已加入本次项目' : '可直接加入成片';
      return `<article class="clip-choice library-choice${disabled ? ' used' : ''}${reusable ? ' reusable' : ''}${existing && reactivated.has(existing.id) ? ' reactivated' : ''}${existing && current.has(existing.id) ? ' current' : ''}${selected ? ' selected' : ''}" data-choose-library="${item.id}" aria-disabled="${disabled}" title="${escapeHtml(status)}">${item.hasThumbnail ? `<img loading="lazy" src="/api/library/thumb?id=${encodeURIComponent(item.id)}" alt="">` : '<div class="timeline-thumb"></div>'}${reusable ? '<span class="clip-choice-reuse-hint">已被使用 · 双击启用</span>' : ''}<span class="clip-choice-check">${selected ? '✓' : '+'}</span><span class="clip-choice-star library-star" title="星标素材">★</span><b>${escapeHtml(item.label || '星标素材')}</b><small>${escapeHtml(item.sourceName || '')} · ${Number(item.duration || 0).toFixed(2)} 秒 · ${status}</small></article>`;
    }).join('') : '<div class="clip-picker-empty"><b>星标素材库还是空的</b><span>先在镜头卡片上点击星标，之后就能从这里跨项目复用。</span></div>';
    $$('[data-choose-library]').forEach((card) => card.addEventListener('click', () => {
      const item = libraryItems.find((entry) => entry.id === card.dataset.chooseLibrary);
      if (!item) return;
      previewLibraryClipChoice(item);
      const existing = state.project.segments.find((segment) => segment.libraryId === item.id);
      if (!item.hasClip) return toast('这个星标素材的本地文件不可用', true);
      if (existing && unavailable(existing)) {
        toast(card.classList.contains('reusable') ? '这个片段已被其他成片使用；双击可为当前成片重新启用' : '这个片段已在当前成片中使用，不能重复添加', true);
        return;
      }
      const key = libraryClipSelectionKey(item);
      if (state.clipPickerSelection.has(key)) state.clipPickerSelection.delete(key); else state.clipPickerSelection.add(key);
      renderClipPicker();
    }));
    $$('[data-choose-library]').forEach((card) => card.addEventListener('dblclick', () => {
      const item = libraryItems.find((entry) => entry.id === card.dataset.chooseLibrary);
      const existing = item && state.project.segments.find((segment) => segment.libraryId === item.id);
      if (existing && card.classList.contains('reusable')) reactivateCompositionSegment(existing.id);
    }));
    $('#clipPickerSelectionCount').textContent = `已选 ${state.clipPickerSelection.size} 条`;
    $('#applyClipPickerSelection').disabled = state.clipPickerSelection.size === 0;
    return;
  }

  const ordered = [...state.project.segments].sort((left, right) => {
    const leftUnavailable = unavailable(left);
    const rightUnavailable = unavailable(right);
    if (leftUnavailable !== rightUnavailable) return leftUnavailable ? 1 : -1;
    return Number(left.index || 0) - Number(right.index || 0);
  });
  $('#clipPickerHint').textContent = state.clipPickerMode === 'replace'
    ? `先选中的素材会替换第 ${state.replacingClipIndex + 1} 个画面，其余选中素材将紧跟其后插入。`
    : '点击可预览并勾选多条素材；其他成片已用片段沉底置灰，双击可为当前成片重新激活。';
  $('#clipPickerGrid').innerHTML = ordered.map((segment) => {
    const source = currentSource(segment);
    const thumbnail = segment.thumbnailUrl || (segment.thumbnail ? `/api/thumb?project=${encodeURIComponent(state.project.id)}&name=${encodeURIComponent(segment.thumbnail)}` : '');
    const disabled = unavailable(segment);
    const selected = state.clipPickerSelection.has(segment.id);
    const reusable = used.has(segment.id) && !reactivated.has(segment.id) && (!current.has(segment.id) || segment.id === replaceTargetId);
    const status = reactivated.has(segment.id) && used.has(segment.id) ? '已为当前成片重新激活' : used.has(segment.id) ? '已被其他成片使用 · 双击重新激活' : current.has(segment.id) && segment.id !== replaceTargetId ? '当前成片已使用' : '';
    const title = reusable ? '已被其他成片使用；双击重新启用' : status;
    return `<article class="clip-choice${disabled ? ' used' : ''}${reusable ? ' reusable' : ''}${reactivated.has(segment.id) ? ' reactivated' : ''}${current.has(segment.id) ? ' current' : ''}${selected ? ' selected' : ''}" data-choose-clip="${segment.id}" aria-disabled="${disabled}" title="${escapeHtml(title)}">${thumbnail ? `<img loading="lazy" src="${thumbnail}" alt="">` : '<div class="timeline-thumb"></div>'}${reusable ? '<span class="clip-choice-reuse-hint">已被使用 · 双击启用</span>' : ''}<span class="clip-choice-check">${selected ? '✓' : '+'}</span><button class="clip-choice-star" data-star-choice="${segment.id}" title="加入星标库">${segment.starred ? '★' : '☆'}</button><b>${escapeHtml(segment.label)}</b><small>${escapeHtml(source?.name || '')} · ${Number(segment.duration).toFixed(2)} 秒${status ? ` · ${status}` : ''}</small></article>`;
  }).join('');
  $('#clipPickerSelectionCount').textContent = `已选 ${state.clipPickerSelection.size} 条`;
  $('#applyClipPickerSelection').disabled = state.clipPickerSelection.size === 0;
  $$('[data-choose-clip]').forEach((card) => card.addEventListener('click', (event) => {
    if (event.target.closest('[data-star-choice]')) return;
    const segment = state.project.segments.find((item) => item.id === card.dataset.chooseClip);
    if (!segment) return;
    previewClipChoice(segment);
    if (card.classList.contains('used')) {
      toast(card.classList.contains('reusable') ? '这个片段已被其他成片使用；双击可为当前成片重新启用' : '这个片段已在当前成片中使用，不能重复添加', true);
      return;
    }
    if (state.clipPickerSelection.has(segment.id)) state.clipPickerSelection.delete(segment.id);
    else state.clipPickerSelection.add(segment.id);
    renderClipPicker();
  }));
  $$('[data-star-choice]').forEach((button) => button.addEventListener('click', (event) => {
    event.stopPropagation();
    starSegment(button.dataset.starChoice, button).then(() => renderClipPicker());
  }));
}

async function applyClipPickerSelection() {
  if (!state.clipPickerSelection.size) return;
  const button = $('#applyClipPickerSelection');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = '正在加入素材…';
  const selection = [...state.clipPickerSelection];
  const libraryIds = selection.filter((key) => key.startsWith('library:')).map((key) => key.slice(8));
  try {
    if (libraryIds.length) {
      await persistAllHookPlans(true);
      const result = await api('/api/project/append-library', {
        method: 'POST',
        body: JSON.stringify({ id: state.project.id, libraryItemIds: libraryIds }),
      });
      state.project = result.project;
      state.hookPlans = state.project.hookPlans || state.hookPlans;
      state.project.hookPlans = state.hookPlans;
      if (state.hook && state.hookPlans[state.hook.id]) state.hookClips = state.hookPlans[state.hook.id].clips || state.hookClips;
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = originalLabel;
    toast(error.message, true);
    return;
  }
  const segmentIds = selection.map((key) => key.startsWith('library:') ? `lib_segment_${key.slice(8)}` : key);
  const clips = segmentIds.map((segmentId) => {
    const segment = state.project.segments.find((item) => item.id === segmentId);
    return segment && { segmentId, duration: Math.min(Number(segment.duration), 3.2), transition: 'cut', auto: false, layout: sourceLayout(currentSource(segment), segment) };
  }).filter(Boolean);
  if (!clips.length) {
    button.disabled = false;
    button.textContent = originalLabel;
    return;
  }
  if (state.clipPickerMode === 'replace' && state.replacingClipIndex >= 0) {
    state.hookClips.splice(state.replacingClipIndex, 1, ...clips);
  } else {
    state.hookClips.push(...clips);
  }
  const count = clips.length;
  closeClipPicker();
  markCompositionDirty();
  renderHookTimeline();
  toast(state.clipPickerMode === 'replace' ? `已替换并加入 ${count} 个画面` : `已加入 ${count} 个画面`);
}

function selectedCompositionMusic() {
  const tracks = state.project?.musicTracks || [];
  const plan = currentHookPlan() || {};
  return tracks.find((track) => track.id === plan.musicId) || tracks[0] || null;
}

function compositionMusicId(plan) {
  return String(plan?.musicId || state.project?.musicTracks?.[0]?.id || '');
}

function usedCompositionMusicRanges(trackId) {
  const currentTaskId = state.hook?.id || '';
  const currentPlan = currentHookPlan() || {};
  const allowed = new Set(currentPlan.musicReuseTaskIds || []);
  const tasks = new Map(compositionTasks().map((task) => [task.id, task]));
  const ranges = [];
  for (const [taskId, plan] of Object.entries(state.hookPlans || {})) {
    if (taskId === currentTaskId || !plan?.confirmed || compositionMusicId(plan) !== trackId) continue;
    const duration = Math.max(0, Number(plan.mixDuration) || 0);
    if (!duration) continue;
    const start = Math.max(0, Number(plan.musicStart) || 0);
    ranges.push({ taskId, start, end: start + duration, reactivated: allowed.has(taskId), name: tasks.get(taskId)?.name || taskId });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function mergeCompositionMusicRanges(ranges, limit = Infinity) {
  const merged = [];
  for (const range of ranges) {
    const start = Math.max(0, Math.min(Number(range.start) || 0, limit));
    const end = Math.max(start, Math.min(Number(range.end) || 0, limit));
    const previous = merged[merged.length - 1];
    if (previous && start <= previous.end + .001) previous.end = Math.max(previous.end, end);
    else merged.push({ start, end });
  }
  return merged;
}

function compositionMusicConflicts(trackId, start, duration) {
  const end = start + duration;
  return usedCompositionMusicRanges(trackId).filter((range) => !range.reactivated && range.start < end - .001 && range.end > start + .001);
}

function availableCompositionMusicStart(trackId, duration, preferred = 0) {
  const track = (state.project?.musicTracks || []).find((item) => item.id === trackId);
  if (!track || Number(track.duration) < duration) return null;
  const occupied = mergeCompositionMusicRanges(usedCompositionMusicRanges(trackId).filter((range) => !range.reactivated), Number(track.duration));
  const gaps = [];
  let cursor = 0;
  for (const range of occupied) {
    if (range.start - cursor >= duration) gaps.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (Number(track.duration) - cursor >= duration) gaps.push({ start: cursor, end: Number(track.duration) });
  if (!gaps.length) return null;
  const candidates = gaps.map((gap) => Math.max(gap.start, Math.min(preferred, gap.end - duration)));
  return candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred))[0];
}

function notifyMusicConflict() {
  if (Date.now() - state.lastMusicConflictToast < 900) return;
  state.lastMusicConflictToast = Date.now();
  toast('这段音乐已被其他成片使用；双击灰色区间可重新激活', true);
}

function adjustCompositionMusicAfterDurationChange() {
  const plan = currentHookPlan();
  const track = selectedCompositionMusic();
  if (!plan || !track) return;
  const duration = Math.max(1, Number(plan.mixDuration) || 15);
  const start = Math.min(Number(plan.musicStart) || 0, Math.max(0, Number(track.duration) - duration));
  if (!compositionMusicConflicts(track.id, start, duration).length) {
    plan.musicStart = start;
    return;
  }
  const available = availableCompositionMusicStart(track.id, duration, start);
  if (available !== null) {
    plan.musicStart = available;
    plan.musicAuto = true;
    toast(`时长变化后已自动移到未使用音乐：${formatTime(available, true)}`);
  } else notifyMusicConflict();
}

function pauseVideoPlayback(except = null) {
  $$('video').forEach((video) => { if (video !== except) video.pause(); });
}

function drawMusicWaveform() {
  const canvas = $('#musicWaveformCanvas');
  const container = $('#musicWaveform');
  const track = selectedCompositionMusic();
  const plan = currentHookPlan();
  if (!canvas || !container || !track || !plan) return;
  const waveform = Array.isArray(track.waveform) ? track.waveform : [];
  $('#musicWaveformLoading').classList.toggle('hidden', waveform.length >= 48);
  const bounds = container.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(bounds.width * ratio);
  canvas.height = Math.round(bounds.height * ratio);
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  const width = bounds.width;
  const height = bounds.height;
  context.clearRect(0, 0, width, height);
  const duration = Math.max(0.01, Number(track.duration) || 0.01);
  const mixDuration = Math.max(0, Number(plan.mixDuration) || 0);
  const start = Math.max(0, Math.min(Number(plan.musicStart) || 0, Math.max(0, duration - mixDuration)));
  const end = Math.min(duration, start + mixDuration);
  const startX = start / duration * width;
  const endX = end / duration * width;
  const usedRanges = usedCompositionMusicRanges(track.id);
  const unavailableRanges = [];
  for (const range of usedRanges.filter((item) => !item.reactivated)) {
    const previous = unavailableRanges[unavailableRanges.length - 1];
    if (previous && range.start <= previous.end + .001) {
      previous.end = Math.max(previous.end, range.end);
      previous.names.push(range.name);
    } else unavailableRanges.push({ start: range.start, end: range.end, names: [range.name] });
  }
  const reuseLayer = $('#musicReuseRanges');
  const reuseSignature = `${track.id}:${unavailableRanges.map((range) => `${range.start.toFixed(3)}-${range.end.toFixed(3)}-${range.names.join(',')}`).join('|')}`;
  if (reuseLayer.dataset.signature !== reuseSignature) {
    reuseLayer.dataset.signature = reuseSignature;
    reuseLayer.innerHTML = unavailableRanges.map((range) => {
      const left = Math.max(0, range.start / duration * 100);
      const right = Math.min(100, range.end / duration * 100);
      const names = [...new Set(range.names)].join('、');
      return `<button type="button" class="music-reuse-range" data-music-reuse-start="${range.start}" style="left:${left}%;width:${Math.max(.35, right - left)}%" title="已被 ${escapeHtml(names)} 使用；双击重新启用">双击启用</button>`;
    }).join('');
  }
  usedRanges.forEach((range) => {
    const x = Math.max(0, range.start / duration * width);
    const rangeWidth = Math.max(2, (Math.min(duration, range.end) - range.start) / duration * width);
    context.fillStyle = range.reactivated ? 'rgba(0,200,215,.12)' : 'rgba(148,154,166,.24)';
    context.fillRect(x, 0, rangeWidth, height);
  });
  context.fillStyle = 'rgba(154,164,187,.12)';
  context.fillRect(startX, 0, Math.max(2, endX - startX), height);
  if (waveform.length) {
    const barWidth = Math.max(1, width / waveform.length * .68);
    waveform.forEach((value, index) => {
      const x = index / waveform.length * width;
      const sampleTime = index / waveform.length * duration;
      const amplitude = Math.max(2, Number(value) * (height - 16));
      const unavailable = usedRanges.some((range) => !range.reactivated && sampleTime >= range.start && sampleTime <= range.end);
      context.fillStyle = sampleTime >= start && sampleTime <= end ? '#9aa4bb' : unavailable ? '#252a33' : '#343a48';
      context.fillRect(x, (height - amplitude) / 2, barWidth, amplitude);
    });
  }
  context.font = '8px sans-serif';
  usedRanges.forEach((range) => {
    const x = Math.max(0, range.start / duration * width);
    const rangeWidth = Math.max(2, (Math.min(duration, range.end) - range.start) / duration * width);
    if (rangeWidth < 34) return;
    context.fillStyle = range.reactivated ? '#67e5ec' : '#8b929d';
    context.fillText(range.reactivated ? '已激活' : '已占用', x + 4, 11, Math.max(0, rangeWidth - 8));
  });
  context.strokeStyle = 'rgba(255,255,255,.13)';
  context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
  context.strokeStyle = '#67e5ec';
  context.lineWidth = 2;
  context.beginPath(); context.moveTo(startX, 0); context.lineTo(startX, height); context.stroke();
  context.strokeStyle = '#a89cf6';
  context.beginPath(); context.moveTo(endX, 0); context.lineTo(endX, height); context.stroke();
  const audio = $('#compositionMusicPreview');
  if (audio && Number.isFinite(audio.currentTime) && audio.currentTime > 0) {
    const playX = Math.min(width, audio.currentTime / duration * width);
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(playX, 0); context.lineTo(playX, height); context.stroke();
  }
  const unavailableCount = usedRanges.filter((range) => !range.reactivated).length;
  $('#musicWaveformSelection').textContent = `${formatTime(start, true)} → ${formatTime(end, true)} · ${mixDuration.toFixed(1)} 秒${unavailableCount ? ` · ${unavailableCount} 段已占用` : ''}`;
  container.setAttribute('aria-valuemin', '0');
  container.setAttribute('aria-valuemax', String(Math.max(0, duration - mixDuration)));
  container.setAttribute('aria-valuenow', String(start));
}

async function ensureMusicWaveform(track) {
  if (!track || (Array.isArray(track.waveform) && track.waveform.length >= 48) || state.musicWaveformLoading.has(track.id)) return;
  state.musicWaveformLoading.add(track.id);
  $('#musicWaveformLoading').classList.remove('hidden');
  try {
    const result = await api(`/api/music/waveform?project=${encodeURIComponent(state.project.id)}&track=${encodeURIComponent(track.id)}`);
    track.waveform = result.waveform || [];
    drawMusicWaveform();
  } catch (error) { $('#musicWaveformLoading').textContent = error.message; }
  finally { state.musicWaveformLoading.delete(track.id); }
}

function setCompositionMusicStart(value, persist = true, options = {}) {
  const plan = currentHookPlan();
  const track = selectedCompositionMusic();
  if (!plan || !track) return;
  pauseVideoPlayback();
  const maxStart = Math.max(0, Number(track.duration) - Number(plan.mixDuration || 0));
  const nextStart = Math.max(0, Math.min(Number(value) || 0, maxStart));
  const conflicts = compositionMusicConflicts(track.id, nextStart, Number(plan.mixDuration) || 0);
  if (conflicts.length && !options.reactivate) {
    $('#compositionMusicStart').value = Number(plan.musicStart) || 0;
    $('#compositionMusicStartLabel').textContent = formatTime(Number(plan.musicStart) || 0, true);
    drawMusicWaveform();
    if (options.notify !== false) notifyMusicConflict();
    return false;
  }
  if (options.reactivate && conflicts.length) {
    plan.musicReuseTaskIds = [...new Set([...(plan.musicReuseTaskIds || []), ...conflicts.map((range) => range.taskId)])];
    toast('已为当前成片重新激活这段音乐');
  }
  plan.musicStart = nextStart;
  if (persist) plan.musicAuto = false;
  $('#compositionMusicStart').value = plan.musicStart;
  $('#compositionMusicStartLabel').textContent = formatTime(plan.musicStart, true);
  const preview = $('#compositionMusicPreview');
  if (preview.src) {
    try { preview.currentTime = plan.musicStart; } catch {}
  }
  drawMusicWaveform();
  if (persist) markCompositionDirty();
  return true;
}

function musicStartFromWaveformEvent(event) {
  const track = selectedCompositionMusic();
  if (!track) return 0;
  const bounds = $('#musicWaveform').getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
  return ratio * Number(track.duration);
}

function setMusicStartFromWaveform(event, options = {}) {
  return setCompositionMusicStart(musicStartFromWaveformEvent(event), true, options);
}

function previewSelectedMusic() {
  const audio = $('#compositionMusicPreview');
  const plan = currentHookPlan();
  if (!audio?.src || !plan) return;
  pauseVideoPlayback();
  const seekAndPlay = () => {
    try { audio.currentTime = Number(plan.musicStart) || 0; } catch {}
    audio.play().catch(() => {});
  };
  if (audio.readyState >= 1) seekAndPlay();
  else audio.addEventListener('loadedmetadata', seekAndPlay, { once: true });
}

function renderCompositionMusic() {
  const tracks = state.project?.musicTracks || [];
  const plan = currentHookPlan() || {};
  $('#musicTrackEditor').classList.toggle('hidden', !state.project?.workflowConfig?.useMusic || !tracks.length || !state.project?.workflowConfig?.useBroll);
  if (!tracks.length) return;
  const selected = tracks.find((track) => track.id === plan.musicId) || tracks[0];
  if (!plan.musicId) plan.musicId = selected.id;
  $('#compositionMusic').innerHTML = tracks.map((track) => {
    const usedSeconds = mergeCompositionMusicRanges(usedCompositionMusicRanges(track.id), Number(track.duration)).reduce((sum, range) => sum + range.end - range.start, 0);
    return `<option value="${track.id}"${track.id === selected.id ? ' selected' : ''}>${escapeHtml(track.name)} · ${formatTime(track.duration, true)}${usedSeconds ? ` · 已用 ${usedSeconds.toFixed(1)}s` : ''}</option>`;
  }).join('');
  const mixDuration = Number(plan.mixDuration ?? state.project.workflowConfig?.mixDuration) || 15;
  const maxStart = Math.max(0, Number(selected.duration) - mixDuration);
  plan.musicStart = Math.min(Number(plan.musicStart) || 0, maxStart);
  $('#compositionMusicStart').max = maxStart;
  $('#compositionMusicStart').value = plan.musicStart;
  $('#compositionMusicStartLabel').textContent = formatTime(plan.musicStart, true);
  const audio = $('#compositionMusicPreview');
  const url = `/api/music/audio?project=${encodeURIComponent(state.project.id)}&track=${encodeURIComponent(selected.id)}`;
  if (audio.dataset.trackId !== selected.id || !audio.getAttribute('src')) {
    audio.dataset.trackId = selected.id;
    replaceMediaSource(audio, url);
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = plan.musicStart; drawMusicWaveform(); }, { once: true });
  }
  drawMusicWaveform();
  ensureMusicWaveform(selected);
}

function updateCompositionMusic() {
  setCompositionMusicStart(Number($('#compositionMusicStart').value) || 0, true);
}

async function addSelectedToHookTimeline(requestedHookId = state.hook?.id) {
  const requestedHook = compositionTasks().find((hook) => hook.id === requestedHookId);
  if (!requestedHook || (!requestedHook.isMixOnly && !requestedHook.confirmedCut)) return toast('请先完成钩子识别', true);
  const button = $('#addSelectedToTimeline');
  button.disabled = true;
  button.textContent = '正在计算…';
  try {
    const plan = await api('/api/hook/auto-compose', {
      method: 'POST',
      body: JSON.stringify({ id: state.project.id, taskId: requestedHookId, hookId: requestedHook.isMixOnly ? '' : requestedHookId, mixDuration: Number($('#compositionMixDuration')?.value) || state.project.workflowConfig?.mixDuration || 15 }),
    });
    state.hookPlans[requestedHookId] = { ...plan, clips: plan.clips || [], previewReady: false };
    state.project.hookPlans = state.hookPlans;
    if (state.hook?.id === requestedHookId) {
      state.hookClips = state.hookPlans[requestedHookId].clips;
      markCompositionDirty();
      renderHookTimeline();
    } else renderComposeHookQueue();
    toast(`已重新铺设 ${plan.clips.length} 个画面；已排除其他确认成片占用的片段`);
  } catch (error) {
    if (state.hook?.id === requestedHookId && !state.hookPlans[requestedHookId]) {
      setCurrentHookPlan([], { mixDuration: Number($('#compositionMixDuration')?.value) || state.project.workflowConfig?.mixDuration || 15, previewReady: false, confirmed: true });
      renderHookTimeline();
    }
    toast(error.message, true);
  }
  finally { button.disabled = false; button.textContent = '重新自动铺满'; }
}

function showHookStage(stage) {
  showWorkflowPage(stage);
}

function showWorkflowPage(page) {
  if (page !== 'intake' && !state.project) return toast('请先建立项目', true);
  const allHooks = state.project?.hooks || [];
  const config = state.project?.workflowConfig || {};
  if (page === 'extract' && config.useHooks === false) page = 'compose';
  if (page === 'compose' && config.useHooks !== false && (!allHooks.length || allHooks.some((hook) => !hook.humanReviewedAt))) return toast('请先在步骤二逐条检查完所有钩子', true);
  if (state.workflowPage !== page) {
    cancelCompositionRender();
    stopWorkflowPlayback();
  }
  state.workflowPage = page;
  $('#intakeWorkbench').classList.toggle('hidden', page !== 'intake');
  $('#analysisLoading').classList.add('hidden');
  $('#resultsLayout').classList.toggle('hidden', page !== 'scene');
  $('#hookExtractStage').classList.toggle('hidden', page !== 'extract');
  $('#hookComposeStage').classList.toggle('hidden', page !== 'compose');
  if (page === 'scene') {
    $('#pageTitle').textContent = state.project.name;
    setWorkflow(0);
    renderProject();
  } else if (page === 'extract') {
    $('#pageTitle').textContent = '钩子识别与切点确认';
    setWorkflow(1);
    renderHookBatchResults();
    const target = allHooks.find((hook) => !hook.humanReviewedAt) || state.hook || allHooks[0];
    if (target && target.id !== state.hook?.id) activateHook(target.id, { announce: false });
    else if (target) renderHookAnalysis();
    $('#hookWorkbench').classList.remove('hidden');
  } else if (page === 'compose') {
    $('#pageTitle').textContent = '成片编排与导出';
    setWorkflow(2);
    const tasks = compositionTasks();
    const target = tasks.find((item) => item.id === state.hook?.id) || tasks[0];
    $('#backToExtract').classList.toggle('hidden', config.useHooks === false);
    renderComposeHookQueue();
    if (target) activateHook(target.id, { compose: true, announce: false });
  } else {
    $('#pageTitle').textContent = '自动剪辑工作流';
    setWorkflow(0);
  }
  $('#workspace').scrollTo({ top: 0, behavior: 'smooth' });
}

function openHookStudio(stage = 'extract') {
  if (!state.project) return toast('请先完成项目设置', true);
  if (state.project.workflowConfig?.useHooks === false) stage = 'compose';
  state.hook = stage === 'extract'
    ? (state.project.hooks || []).find((hook) => !hook.humanReviewedAt) || state.project.hook || state.hook
    : state.project.hook || state.hook;
  if (state.hook) {
    state.hookPath = state.hook.path;
    state.hookCut = state.hookCut || state.hook.confirmedCut || state.hook.suggestedCut;
    renderHookAnalysis();
  }
  if (state.project.hooks?.length) {
    state.hookBatch = {
      hooks: state.project.hooks,
      failures: [],
      autoConfirmed: state.project.hooks.filter((hook) => hook.confirmedCut).length,
      needsReview: state.project.hooks.filter((hook) => !hook.confirmedCut).length,
    };
    renderHookBatchResults();
  }
  showWorkflowPage(stage);
}

function renderHookExportResults(outputs = [], failures = []) {
  const panel = $('#hookExportResults');
  const rows = [
    ...outputs.map((item) => `<div class="hook-export-result-row"><div><b>${escapeHtml(item.hookName || '钩子成片')}</b><small>${escapeHtml(item.output)}</small></div><em>${Number(item.shortfall) > 1 / 30 ? `短 ${Number(item.shortfall).toFixed(1)}s` : '导出成功'}</em></div>`),
    ...failures.map((item) => `<div class="hook-export-result-row failed"><div><b>${escapeHtml(item.name || '钩子')}</b><small>${escapeHtml(item.error)}</small></div><em>失败</em></div>`),
  ];
  $('#hookExportResultTitle').textContent = failures.length ? `已导出 ${outputs.length} 条，${failures.length} 条失败` : `${outputs.length} 条视频全部导出成功`;
  $('#hookExportResultList').innerHTML = rows.join('');
  panel.classList.remove('hidden');
}

function applyExportHookPlans(hookPlans) {
  if (!hookPlans || !state.project) return;
  state.hookPlans = hookPlans;
  state.project.hookPlans = hookPlans;
  if (state.hook && hookPlans[state.hook.id]) state.hookClips = hookPlans[state.hook.id].clips || [];
  renderHookTimeline();
}

function confirmShortDurationExport(shortages) {
  const dialog = $('#shortDurationDialog');
  $('#shortDurationList').innerHTML = shortages.map((item) => `<div class="short-duration-item"><div><b>${escapeHtml(item.name)}</b><small>目标 ${Number(item.targetDuration).toFixed(1)}s · 实际 ${Number(item.actualDuration).toFixed(1)}s</small></div><em>缺少 ${Number(item.missingDuration).toFixed(1)}s</em></div>`).join('');
  if (dialog.open) dialog.close();
  dialog.showModal();
  return new Promise((resolve) => { state.shortDurationResolver = resolve; });
}

function settleShortDurationExport(confirmed) {
  const resolve = state.shortDurationResolver;
  state.shortDurationResolver = null;
  if ($('#shortDurationDialog').open) $('#shortDurationDialog').close();
  if (resolve) resolve(confirmed);
}

function renderBatchExportProgress(job) {
  const panel = $('#hookExportProgress');
  const total = Math.max(0, Number(job.total) || 0);
  const completed = Math.max(0, Math.min(total, Number(job.completed) || 0));
  const percent = Math.max(0, Math.min(100, Number(job.overall) || (total ? Math.round((completed / total) * 100) : 0)));
  const phase = job.phase || '准备导出';
  panel.classList.remove('hidden', 'complete', 'failed');
  panel.classList.toggle('complete', job.state === 'complete' && !job.result?.confirmationRequired);
  panel.classList.toggle('failed', job.state === 'failed');
  $('#hookExportProgressTitle').textContent = phase;
  $('#hookExportProgressCount').textContent = `${completed} / ${total} 条`;
  $('#hookExportProgressPercent').textContent = `${percent}%`;
  $('#hookExportProgressBar').value = percent;
  $('#hookExportProgressBar').textContent = `${percent}%`;
  $('#hookExportProgressCurrent').textContent = job.currentName
    ? `当前 ${Math.max(1, Number(job.currentIndex) || completed + 1)} / ${total} · ${job.currentName}`
    : job.state === 'complete' ? '批量任务已结束' : '正在建立导出任务…';
  $('#hookExportProgressStats').textContent = `成功 ${Number(job.succeeded) || 0} · 失败 ${Number(job.failed) || 0}`;
}

async function runBatchExportJob(options) {
  const started = await api('/api/hook/batch-export/start', {
    method: 'POST',
    body: JSON.stringify({ id: state.project.id, outputDir: $('#hookOutputDir').value.trim(), ...options }),
  });
  let job = started.job || { state: 'processing', phase: '准备导出', total: compositionTasks().length, completed: 0, overall: 0 };
  renderBatchExportProgress(job);
  while (job.state === 'processing') {
    await new Promise((resolve) => setTimeout(resolve, 450));
    job = await api(`/api/hook/batch-export/status?job=${encodeURIComponent(started.jobId)}`);
    renderBatchExportProgress(job);
  }
  if (job.state === 'failed') throw new Error(job.error || '批量导出失败');
  return job.result;
}

async function exportAllHooks() {
  $('#hookExportResults').classList.add('hidden');
  const button = $('#batchExportHooks');
  const status = $('#hookExportStatus');
  button.disabled = true;
  button.textContent = '正在批量导出…';
  status.className = 'export-status';
  status.textContent = '正在按自动保存的方案批量导出；跨成片素材将严格去重…';
  try {
    await persistAllHookPlans(false);
    let result = await runBatchExportJob({});
    applyExportHookPlans(result.hookPlans);
    if (result.confirmationRequired) {
      status.textContent = `有 ${result.shortages.length} 条成片时长不足，等待确认…`;
      button.textContent = '等待确认…';
      const confirmed = await confirmShortDurationExport(result.shortages);
      if (!confirmed) {
        status.textContent = '已取消导出，可以继续添加或延长画面。';
        $('#hookExportProgress').classList.add('hidden');
        return;
      }
      button.textContent = '正在按实际时长导出…';
      status.textContent = '已确认短时长导出，正在按实际可用画面生成…';
      result = await runBatchExportJob({ allowShortDuration: true });
      applyExportHookPlans(result.hookPlans);
    }
    const failed = result.failures?.length || 0;
    const shortened = (result.outputs || []).filter((item) => Number(item.shortfall) > 1 / 30).length;
    status.className = `export-status ${failed ? 'error' : 'success'}`;
    status.textContent = `批量完成 ${result.outputs.length}/${result.requested} 条${shortened ? `；${shortened} 条按实际时长导出` : ''}${failed ? `；${failed} 条失败：${result.failures[0].error}` : ''}`;
    if (result.outputs[0]?.outputDir) state.lastExportDir = result.outputs[0].outputDir;
    renderHookExportResults(result.outputs || [], result.failures || []);
    toast(`已自动组合并导出 ${result.outputs.length} 条成片${shortened ? `，其中 ${shortened} 条时长较短` : ''}`, Boolean(failed));
  } catch (error) {
    status.className = 'export-status error';
    status.textContent = error.message;
    toast(error.message, true);
  } finally { button.disabled = false; button.textContent = '整体导出全部成片'; }
}

function downloadCsv() {
  if (!state.project) return;
  const rows = state.project.segments.filter((segment) => segment.selected).map((segment) => `${segment.start},${segment.end},"${String(segment.label).replace(/"/g, '""')}"`);
  const blob = new Blob([`\ufeff${rows.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${state.project.name.replace(/[\\/:*?"<>|]/g, '_')}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast('CSV 已生成，可导入 LosslessCut');
}

async function openProject(id) {
  try {
    cancelCompositionRender();
    stopWorkflowPlayback();
    $('#hookExportResults').classList.add('hidden');
    state.project = await api(`/api/project/${encodeURIComponent(id)}`);
    state.files = state.project.files.map((file) => file.path);
    state.musicPaths = (state.project.musicTracks || []).map((track) => track.path);
    state.intakeOptions = {
      useBroll: state.project.workflowConfig?.useBroll !== false,
      useHooks: state.project.workflowConfig?.useHooks !== false,
      useMusic: Boolean(state.project.workflowConfig?.useMusic),
    };
    $('#mixSegmentDuration').value = state.project.workflowConfig?.mixDuration || 15;
    $('#mixOutputCount').value = state.project.workflowConfig?.outputCount || 1;
    updateIntakeMode();
    state.activeId = null;
    state.hook = state.project.hook || null;
    state.hookPaths = (state.project.hooks || []).map((hook) => hook.path);
    state.hookPath = state.hook?.path || '';
    state.hookCut = state.hook?.confirmedCut || state.hook?.suggestedCut || 0;
    state.hookPlans = state.project.hookPlans || {};
    state.hookClips = state.hook ? (state.hookPlans[state.hook.id]?.clips || []) : [];
    state.hookBatch = state.project.hooks?.length ? {
      hooks: state.project.hooks,
      failures: [],
      autoConfirmed: state.project.hooks.filter((hook) => hook.confirmedCut).length,
      needsReview: state.project.hooks.filter((hook) => !hook.confirmedCut).length,
    } : null;
    state.compositionPreviewReady = false;
    $('#importPanel').classList.add('hidden');
    $('#sourcePanel').classList.add('hidden');
    $('#intakeWorkbench').classList.add('hidden');
    closeDrawer();
    renderProject();
    renderInitialHookSources();
    renderInitialMusicSources();
    renderHookBatchResults();
    showWorkflowPage('scene');
  } catch (error) { toast(error.message, true); }
}

function resetProject(showToast = true) {
  cancelCompositionRender();
  stopWorkflowPlayback();
  state.files = [];
  state.musicPaths = [];
  state.intakeOptions = { useBroll: true, useHooks: true, useMusic: false };
  state.intakeLibraryIds = { broll: new Set(), hook: new Set() };
  state.project = null;
  state.activeId = null;
  state.hook = null;
  state.hookPath = '';
  state.hookPaths = [];
  state.hookBatch = null;
  state.hookAnalysisRunning = false;
  state.hookCut = 0;
  state.hookClips = [];
  state.hookPlans = {};
  state.workflowPage = 'intake';
  state.compositionPreviewReady = false;
  state.compositionPreviewUrl = '';
  state.compositionEditVersion = 0;
  state.boxSelectMode = false;
  state.boxSelectedIds.clear();
  state.replacingClipIndex = -1;
  state.clipPickerMode = 'add';
  state.clipPickerSource = 'project';
  state.clipPickerSelection.clear();
  state.draggedClipIndex = -1;
  $('#hookExportResults').classList.add('hidden');
  $('#hookExportResultList').innerHTML = '';
  $('#pageTitle').textContent = '自动剪辑工作流';
  $('#resultsLayout').classList.add('hidden');
  $('#hookExtractStage').classList.add('hidden');
  $('#hookComposeStage').classList.add('hidden');
  $('#analysisLoading').classList.add('hidden');
  $('#sourcePanel').classList.add('hidden');
  $('#intakeWorkbench').classList.remove('hidden');
  $('#settingsPanel').classList.remove('hidden');
  $('#importPanel').classList.remove('hidden');
  $('#previewVideo').removeAttribute('src');
  renderSources();
  renderInitialHookSources();
  renderInitialMusicSources();
  updateIntakeMode();
  setWorkflow(0);
  if (showToast === true) toast('已进入新项目；旧项目仍保存在顶部“本地项目”中');
}

async function deleteProject(id) {
  const row = document.querySelector(`.project-row[data-id="${CSS.escape(id)}"]`);
  const name = row?.querySelector('b')?.textContent || '这个项目';
  if (!confirm(`确定删除“${name}”吗？\n\n只删除项目记录和缩略图，不会删除原始视频；已星标导出的素材也会保留。`)) return;
  try {
    await api('/api/project/delete', { method: 'POST', body: JSON.stringify({ id }) });
    if (state.project?.id === id) resetProject(false);
    await refreshProjects();
    toast(`已删除本地项目：${name}`);
  } catch (error) { toast(error.message, true); }
}

function openDrawer() { pauseAllPlayback(); $('#drawerBackdrop').classList.remove('hidden'); $('#projectDrawer').classList.remove('hidden'); refreshProjects(); }
function closeDrawer() { pauseAllPlayback(); $('#drawerBackdrop').classList.add('hidden'); $('#projectDrawer').classList.add('hidden'); }

async function openPath(target = '') {
  try {
    await api('/api/open-path', { method: 'POST', body: JSON.stringify({ path: target }) });
  } catch (error) { toast(error.message, true); }
}

function renderLibrary() {
  const allItems = state.library.items || [];
  const items = allItems.filter((item) => (item.type || 'broll') === state.libraryType);
  const selected = state.intakeLibraryIds[state.libraryType];
  $('#libraryCount').textContent = allItems.length;
  $('#libraryDialogCount').textContent = allItems.length;
  $('#librarySelectionSummary').textContent = state.libraryPickMode ? `已选 ${selected.size} 项` : `${items.length} 项`;
  $('#applyLibrarySelection').classList.toggle('hidden', !state.libraryPickMode);
  $('#libraryGrid').innerHTML = items.length ? items.map((item) => `
    <article class="library-card${state.libraryPickMode ? ' selectable' : ''}${selected.has(item.id) ? ' selected' : ''}" data-id="${item.id}">
      <div class="library-card-thumb" data-play="${item.id}">${item.hasThumbnail ? `<img loading="lazy" src="/api/library/thumb?id=${encodeURIComponent(item.id)}" alt="">` : ''}<span>${Number(item.duration || 0).toFixed(2)}s · ▶</span></div>
      <div class="library-card-body"><small class="library-kind">${item.type === 'hook' ? '钩子' : '混剪素材'}${state.libraryPickMode ? ' · 点击卡片选择' : ''}</small><small>${escapeHtml(item.sourceName || '')} · ${new Date(item.createdAt).toLocaleDateString('zh-CN')}</small><div class="library-rename"><input value="${escapeHtml(item.label)}" aria-label="素材名称"><button data-rename="${item.id}">保存名称</button></div></div>
    </article>`).join('') : `<div class="library-empty">还没有星标${state.libraryType === 'hook' ? '钩子' : '混剪素材'}。</div>`;
  $$('.library-card.selectable').forEach((card) => card.addEventListener('click', (event) => {
    if (event.target.closest('.library-rename')) return;
    if (selected.has(card.dataset.id)) selected.delete(card.dataset.id); else selected.add(card.dataset.id);
    renderLibrary(); renderSources();
  }));
  $$('[data-play]').forEach((node) => node.addEventListener('click', () => {
    const preview = $('#libraryPreview');
    pauseAllPlayback(preview);
    preview.src = `/api/library/video?id=${encodeURIComponent(node.dataset.play)}`;
    preview.classList.remove('hidden');
    preview.play().catch(() => {});
  }));
  $$('[data-rename]').forEach((button) => button.addEventListener('click', async () => {
    const input = button.closest('.library-rename').querySelector('input');
    try {
      await api('/api/library/rename', { method: 'POST', body: JSON.stringify({ id: button.dataset.rename, label: input.value.trim() }) });
      const item = state.library.items.find((entry) => entry.id === button.dataset.rename);
      if (item) item.label = input.value.trim();
      toast('素材名称已保存');
    } catch (error) { toast(error.message, true); }
  }));
}

async function openLibrary(preservePickMode = false) {
  try {
    pauseAllPlayback();
    if (!preservePickMode) state.libraryPickMode = '';
    state.library = await api('/api/library');
    renderLibrary();
    $('#libraryDialog').showModal();
  } catch (error) { toast(error.message, true); }
}

async function openLibraryForIntake(type) {
  state.libraryPickMode = type;
  state.libraryType = type;
  await openLibrary(true);
  $$('[data-library-type]').forEach((button) => button.classList.toggle('active', button.dataset.libraryType === type));
  renderLibrary();
}

if (nativeHost) {
  nativeBridge.onMessage((payload) => {
    const message = payload || {};
    const paths = Array.isArray(message.paths) ? message.paths : [];
    if (message.type === 'files-picked' || message.type === 'files-dropped') {
      addFiles(paths);
      if (message.type === 'files-dropped' && paths.length) toast(`已拖入 ${paths.length} 个本地文件`);
    } else if (message.type === 'video-folder-picked' && paths[0]) addVideoFolder(paths[0]);
    else if (message.type === 'output-folder-picked' && paths[0]) $('#outputDir').value = paths[0];
    else if (message.type === 'hook-file-picked' && paths.length) setHookPaths(paths);
    else if (message.type === 'music-files-picked' && paths.length) {
      for (const path of paths) if (!state.musicPaths.includes(path)) state.musicPaths.push(path);
      renderInitialMusicSources();
      renderSources();
    } else if (message.type === 'menu-command') {
      const targetByCommand = {
        'new-project': '#newProject',
        'pick-files': '#pickFiles',
        'open-projects': '#openProjectsTop',
        'open-library': '#openLibrary',
        'toggle-sidebar': '#sidebarToggle',
        'show-help': '#helpButton',
        'ai-settings': '#aiSettingsButton',
      };
      const selector = targetByCommand[message.command];
      const target = selector ? $(selector) : null;
      if (target) target.click();
    }
  });
}

function droppedBrowserPaths(event) {
  const direct = [...(event.dataTransfer?.files || [])].map((file) => file.path || window.hoMixNative?.getPathForFile?.(file) || window.sceneSiftNative?.getPathForFile?.(file)).filter(Boolean);
  if (direct.length) return direct;
  const text = event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || '';
  return text.split(/\r?\n/).map((item) => item.trim()).filter((item) => item && !item.startsWith('#')).map((item) => {
    if (!item.toLowerCase().startsWith('file:///')) return '';
    try {
      const decoded = decodeURIComponent(item.slice(8));
      return /^\/?[a-zA-Z]:/.test(decoded) ? decoded.replace(/^\/?([a-zA-Z]:)/, '$1').replace(/\//g, '\\') : `/${decoded.replace(/^\/+/, '')}`;
    } catch { return ''; }
  }).filter(Boolean);
}

document.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  const paths = droppedBrowserPaths(event);
  if (paths.length) addFiles(paths);
  else if (!nativeHost) toast('已阻止浏览器跳转；请使用“添加视频”的原生选择器', true);
});

function syncBoxSelectedCards() {
  $$('.segment-card').forEach((card) => card.classList.toggle('box-selected', state.boxSelectedIds.has(card.dataset.id)));
  updateBoxSelectionToolbar();
}

$('#segmentGrid').addEventListener('pointerdown', (event) => {
  if (!state.boxSelectMode || event.button !== 0) return;
  event.preventDefault();
  const targetCard = event.target.closest('.segment-card');
  const marquee = document.createElement('div');
  marquee.className = 'selection-marquee';
  document.body.append(marquee);
  state.boxDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    targetId: targetCard?.dataset.id || '',
    base: event.ctrlKey ? new Set(state.boxSelectedIds) : new Set(),
    marquee,
    moved: false,
  };
  $('#segmentGrid').setPointerCapture?.(event.pointerId);
});

document.addEventListener('pointermove', (event) => {
  const drag = state.boxDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  const left = Math.min(drag.startX, event.clientX);
  const top = Math.min(drag.startY, event.clientY);
  const right = Math.max(drag.startX, event.clientX);
  const bottom = Math.max(drag.startY, event.clientY);
  drag.moved ||= Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 4;
  Object.assign(drag.marquee.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
  if (!drag.moved) return;
  const selected = new Set(drag.base);
  $$('.segment-card').forEach((card) => {
    const rect = card.getBoundingClientRect();
    if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top) selected.add(card.dataset.id);
  });
  state.boxSelectedIds = selected;
  syncBoxSelectedCards();
});

document.addEventListener('pointerup', (event) => {
  const drag = state.boxDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.moved && drag.targetId) {
    const selected = new Set(drag.base);
    if (state.boxSelectedIds.has(drag.targetId) && event.ctrlKey) selected.delete(drag.targetId); else selected.add(drag.targetId);
    state.boxSelectedIds = selected;
  }
  drag.marquee.remove();
  state.boxDrag = null;
  state.suppressSegmentClick = true;
  setTimeout(() => { state.suppressSegmentClick = false; }, 0);
  syncBoxSelectedCards();
});

window.addEventListener('blur', () => pauseAllPlayback());
document.addEventListener('visibilitychange', () => { if (document.hidden) pauseAllPlayback(); });

$('#pickFiles').addEventListener('click', chooseFiles);
$('#pickInitialHooks').addEventListener('click', chooseHookVideo);
$('#pickInitialMusic').addEventListener('click', chooseMusic);
$('#pickBrollLibrary').addEventListener('click', () => openLibraryForIntake('broll'));
$('#pickHookLibrary').addEventListener('click', () => openLibraryForIntake('hook'));
$$('[data-content-toggle]').forEach((input) => input.addEventListener('change', () => {
  const keys = { broll: 'useBroll', hooks: 'useHooks', music: 'useMusic' };
  state.intakeOptions[keys[input.dataset.contentToggle]] = input.checked;
  updateIntakeMode();
}));
$('#addMore').addEventListener('click', chooseFiles);
$('#pickFolder').addEventListener('click', chooseFolderVideos);
$('#addFolder').addEventListener('click', chooseFolderVideos);
$('#clearFiles').addEventListener('click', () => { state.files = []; renderSources(); });
$('#enterPath').addEventListener('click', () => {
  const value = prompt('粘贴视频的完整路径；多个路径请每行一个：');
  if (value) addFiles(value.split(/\r?\n/));
});
$('#threshold').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  const label = value <= .22 ? '细分' : value >= .38 ? '长段' : '连贯';
  $('#thresholdOutput').textContent = `${label} · ${value.toFixed(2)}`;
});
$('#aiPreset').addEventListener('click', () => {
  if ($('#aiPreset').disabled) { $('#aiDialog').showModal(); return; }
  state.aiPreset = !state.aiPreset;
  $('#aiPreset').classList.toggle('active', state.aiPreset);
  $('#aiPreset').previousElementSibling.classList.toggle('active', !state.aiPreset);
  $('#aiFeature')?.classList.toggle('active', state.aiPreset);
  const aiFeatureStatus = $('#aiFeature em');
  if (aiFeatureStatus) aiFeatureStatus.textContent = state.aiPreset ? '✓' : '＋';
});
$('#analyzeButton').addEventListener('click', analyze);
$('#segmentSearch').addEventListener('input', renderSegments);
$$('.view-toggle button').forEach((button) => button.addEventListener('click', () => {
  $$('.view-toggle button').forEach((item) => item.classList.toggle('active', item === button));
  state.gridView = button.dataset.view;
  renderSegments();
}));
$('#selectAll').addEventListener('click', () => {
  const allSelected = state.project.segments.every((segment) => segment.selected);
  state.project.segments.forEach((segment) => { segment.selected = !allSelected; });
  renderSegments(); updateSelectionSummary(); saveProjectUpdates();
});
$('#boxSelectSegments').addEventListener('click', () => {
  if (state.boxSelectMode) clearBoxSelection(true);
  else { state.boxSelectMode = true; clearBoxSelection(false); }
  renderSegments();
});
$('#starBoxSelection').addEventListener('click', starBoxSelection);
$('#clearBoxSelection').addEventListener('click', () => { clearBoxSelection(true); renderSegments(); });
$('#batchLabel').addEventListener('click', () => {
  const prefix = prompt('输入标签前缀，将自动添加序号：', '镜头');
  if (prefix === null) return;
  let index = 1;
  state.project.segments.filter((segment) => segment.selected).forEach((segment) => { segment.label = `${prefix} ${String(index++).padStart(2, '0')}`; });
  renderProject(); saveProjectUpdates();
});
$('#aiLabel').addEventListener('click', runAiLabels);
$('#scriptMix').addEventListener('click', () => openMixDialog('project'));
$('#downloadCsv').addEventListener('click', downloadCsv);
$('#saveLabel').addEventListener('click', () => {
  const segment = state.project.segments.find((item) => item.id === state.activeId);
  const label = $('#labelInput').value.trim();
  if (!segment || !label) return;
  segment.label = label;
  $('#activeLabel').textContent = label;
  renderSegments(); saveProjectUpdates(); toast('标签已保存');
});
$$('[data-nudge]').forEach((button) => button.addEventListener('click', () => {
  const [target, direction] = button.dataset.nudge.split(':');
  nudgeBoundary(target, Number(direction));
}));
$('#saveBoundary').addEventListener('click', saveBoundary);
$('#labelInput').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#saveLabel').click(); });
$('#previewVideo').addEventListener('timeupdate', (event) => {
  const end = Number(event.currentTarget.dataset.end);
  if (end && event.currentTarget.currentTime >= end) event.currentTarget.pause();
});
$('#pickOutput').addEventListener('click', chooseOutput);
$('#openLastExport').addEventListener('click', () => openPath(state.lastExportDir));
$$('.export-mode button').forEach((button) => button.addEventListener('click', () => {
  $$('.export-mode button').forEach((item) => item.classList.toggle('active', item === button));
  state.exportMode = button.dataset.mode;
}));
$('#exportButton').addEventListener('click', exportSelected);
$('#newProject').addEventListener('click', () => resetProject(true));
$('#openProjects').addEventListener('click', openDrawer);
$('#openProjectsTop').addEventListener('click', openDrawer);
$('#closeDrawer').addEventListener('click', closeDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);
$('#helpButton').addEventListener('click', () => { pauseAllPlayback(); $('#helpDialog').showModal(); });
function openAiSettings() {
  pauseAllPlayback();
  $('#glmApiKey').value = '';
  $('#aiDialog').showModal();
  $('#ollamaSetupState').textContent = '正在检测 Ollama…';
  refreshStatus(true);
}
function syncAiProviderFields() {
  const glm = $('#aiProvider').value === 'glm';
  $('#glmModelRow').classList.toggle('hidden', !glm);
  $('#glmKeyRow').classList.toggle('hidden', !glm);
  $('#ollamaModelRow').classList.toggle('hidden', glm);
  $('#ollamaSetup').classList.toggle('hidden', glm);
}
$('#aiSettingsButton').addEventListener('click', openAiSettings);
$('#engineSettings').addEventListener('click', openAiSettings);
$('#aiProvider').addEventListener('change', syncAiProviderFields);
$('#startOllama').addEventListener('click', async () => {
  const button = $('#startOllama');
  button.disabled = true; button.textContent = '正在启动…';
  try { await api('/api/ollama/start', { method: 'POST', body: '{}' }); await refreshStatus(true); toast('Ollama 已与 HoMix 自动连接'); }
  catch (error) { toast(error.message, true); }
  finally { button.textContent = '启动/重新检测'; if (!state.status?.ollama?.available) button.disabled = false; }
});
$('#pullOllamaModel').addEventListener('click', async () => {
  const model = $('#ollamaInstallModel').value.trim();
  if (!model) return toast('请输入视觉模型名称', true);
  const button = $('#pullOllamaModel');
  button.disabled = true; button.textContent = '正在下载模型…';
  try {
    await api('/api/ollama/pull', { method: 'POST', body: JSON.stringify({ model }) });
    state.aiProvider = 'ollama';
    await api('/api/ai/config', { method: 'POST', body: JSON.stringify({ provider: 'ollama' }) });
    await refreshStatus(true);
    $('#aiProvider').value = 'ollama'; syncAiProviderFields();
    toast(`${model} 已安装并设为本地视觉模型`);
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = '安装视觉模型'; }
});
$('#aiFeature')?.addEventListener('click', () => {
  const ready = state.aiProvider === 'glm'
    ? Boolean(state.status?.ai?.glm?.configured)
    : Boolean(state.status?.ollama?.available && state.status?.ollama?.visionModels?.length);
  if (!ready) return openAiSettings();
  state.aiPreset = !state.aiPreset;
  $('#aiPreset').classList.toggle('active', state.aiPreset);
  $('#aiPreset').previousElementSibling.classList.toggle('active', !state.aiPreset);
  $('#aiFeature')?.classList.toggle('active', state.aiPreset);
  const status = $('#aiFeature em');
  if (status) status.textContent = state.aiPreset ? '✓' : '＋';
});
$('#hookStudio').addEventListener('click', () => {
  try { openHookStudio('extract'); }
  catch (error) {
    console.error(error);
    toast(`无法进入下一步：${error.message || '界面加载失败'}`, true);
  }
});
$('#pickHook').addEventListener('click', chooseHookVideo);
$('#analyzeHook').addEventListener('click', analyzeHookVideo);
$('#hookCut').addEventListener('input', (event) => setHookCut(Number(event.target.value), false));
$('#hookCut').addEventListener('change', (event) => { setHookCut(Number(event.target.value), true); scheduleHookReviewSave(); });
$('#continueToCompose').addEventListener('click', confirmHookAndCompose);
$('#starCurrentHook').addEventListener('click', starCurrentHook);
$('#backToExtract').addEventListener('click', () => showHookStage('extract'));
$$('[data-hook-stage]').forEach((button) => button.addEventListener('click', () => showHookStage(button.dataset.hookStage)));
$('#addSelectedToTimeline').addEventListener('click', () => addSelectedToHookTimeline());
$('#openClipPicker').addEventListener('click', () => openClipPicker('add'));
$('#closeClipPicker').addEventListener('click', closeClipPicker);
$('#clearClipPickerSelection').addEventListener('click', () => { state.clipPickerSelection.clear(); renderClipPicker(); });
$('#applyClipPickerSelection').addEventListener('click', applyClipPickerSelection);
$$('[data-clip-source]').forEach((button) => button.addEventListener('click', () => {
  state.clipPickerSource = button.dataset.clipSource;
  renderClipPicker();
}));
$('#clipPickerDialog').addEventListener('close', () => {
  state.replacingClipIndex = -1;
  state.clipPickerSelection.clear();
  stopMedia($('#clipPickerPreview'), true);
});
$('#clipPickerPreview').addEventListener('timeupdate', (event) => {
  const end = Number(event.currentTarget.dataset.end);
  if (end && event.currentTarget.currentTime >= end) event.currentTarget.pause();
});
$('#clipPickerGrid').addEventListener('dblclick', (event) => {
  if (event.target.closest('[data-star-choice]')) return;
  const card = event.target.closest('[data-choose-clip]');
  if (!card) return;
  event.preventDefault();
  event.stopPropagation();
  reactivateCompositionSegment(card.dataset.chooseClip);
});
$('#compositionMixDuration').addEventListener('change', () => {
  const plan = currentHookPlan(); if (!plan) return;
  plan.mixDuration = Math.max(1, Number($('#compositionMixDuration').value) || 15);
  adjustCompositionMusicAfterDurationChange();
  markCompositionDirty(); renderHookTimeline();
});
$$('[data-duration-preset]').forEach((button) => button.addEventListener('click', () => {
  const plan = currentHookPlan(); if (!plan) return;
  plan.mixDuration = Number(button.dataset.durationPreset) || 15;
  $('#compositionMixDuration').value = plan.mixDuration;
  adjustCompositionMusicAfterDurationChange();
  markCompositionDirty(); renderHookTimeline();
}));
$('#compositionMusicFade').addEventListener('change', (event) => {
  const plan = currentHookPlan(); if (!plan) return;
  plan.musicFadeOut = event.currentTarget.checked;
  markCompositionDirty();
});
$('#compositionMusic').addEventListener('change', () => {
  pauseAllPlayback();
  const plan = currentHookPlan();
  if (plan) {
    plan.musicId = $('#compositionMusic').value;
    plan.musicReuseTaskIds = [];
    plan.musicAuto = false;
    const available = availableCompositionMusicStart(plan.musicId, Number(plan.mixDuration) || 15, 0);
    plan.musicStart = available ?? 0;
    if (available === null) notifyMusicConflict();
    markCompositionDirty(); renderCompositionMusic();
  }
});
$('#compositionMusicStart').addEventListener('input', updateCompositionMusic);
$('#compositionMusicStart').addEventListener('change', renderHookTimeline);
$('#musicWaveform').addEventListener('pointerdown', (event) => {
  state.musicWaveformDragging = setMusicStartFromWaveform(event);
  if (state.musicWaveformDragging) try { $('#musicWaveform').setPointerCapture(event.pointerId); } catch {}
});
$('#musicWaveform').addEventListener('pointermove', (event) => {
  const track = selectedCompositionMusic();
  const plan = currentHookPlan();
  const hoverStart = musicStartFromWaveformEvent(event);
  $('#musicWaveform').classList.toggle('over-used', Boolean(track && plan && compositionMusicConflicts(track.id, Math.min(hoverStart, Math.max(0, Number(track.duration) - Number(plan.mixDuration || 0))), Number(plan.mixDuration) || 0).length));
  if (state.musicWaveformDragging) setMusicStartFromWaveform(event, { notify: false });
});
$('#musicWaveform').addEventListener('pointerup', () => { const changed = state.musicWaveformDragging; state.musicWaveformDragging = false; if (changed) previewSelectedMusic(); });
$('#musicWaveform').addEventListener('pointercancel', () => { state.musicWaveformDragging = false; });
$('#musicWaveform').addEventListener('pointerleave', () => $('#musicWaveform').classList.remove('over-used'));
$('#musicReuseRanges').addEventListener('pointerdown', (event) => event.stopPropagation());
$('#musicReuseRanges').addEventListener('pointerup', (event) => event.stopPropagation());
$('#musicReuseRanges').addEventListener('click', (event) => {
  const range = event.target.closest('[data-music-reuse-start]');
  if (!range) return;
  event.preventDefault();
  event.stopPropagation();
  notifyMusicConflict();
});
$('#musicReuseRanges').addEventListener('dblclick', (event) => {
  const range = event.target.closest('[data-music-reuse-start]');
  if (!range) return;
  event.preventDefault();
  event.stopPropagation();
  if (setCompositionMusicStart(Number(range.dataset.musicReuseStart) || 0, true, { reactivate: true })) previewSelectedMusic();
});
$('#musicWaveform').addEventListener('dblclick', (event) => {
  event.preventDefault();
  if (setMusicStartFromWaveform(event, { reactivate: true })) previewSelectedMusic();
});
$('#musicWaveform').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const plan = currentHookPlan();
  if (!plan) return;
  const step = event.shiftKey ? 5 : .5;
  setCompositionMusicStart((Number(plan.musicStart) || 0) + (event.key === 'ArrowRight' ? step : -step), true);
});
$('#compositionMusicPreview').addEventListener('play', (event) => {
  pauseAllPlayback(event.currentTarget);
  const plan = currentHookPlan();
  const end = Number(plan?.musicStart || 0) + Number(plan?.mixDuration || 0);
  if (event.currentTarget.currentTime < Number(plan?.musicStart || 0) || event.currentTarget.currentTime >= end) event.currentTarget.currentTime = Number(plan?.musicStart || 0);
  drawMusicWaveform();
});
$('#compositionMusicPreview').addEventListener('seeking', pauseVideoPlayback);
$('#compositionMusicPreview').addEventListener('timeupdate', (event) => {
  const plan = currentHookPlan();
  const end = Number(plan?.musicStart || 0) + Number(plan?.mixDuration || 0);
  if (end && event.currentTarget.currentTime >= end) event.currentTarget.pause();
  drawMusicWaveform();
});
$('#compositionMusicPreview').addEventListener('pause', drawMusicWaveform);
new ResizeObserver(drawMusicWaveform).observe($('#musicWaveform'));
$('#cancelShortDurationExport').addEventListener('click', () => settleShortDurationExport(false));
$('#confirmShortDurationExport').addEventListener('click', () => settleShortDurationExport(true));
$('#shortDurationDialog').addEventListener('cancel', (event) => { event.preventDefault(); settleShortDurationExport(false); });
$('#shortDurationDialog').addEventListener('close', () => {
  if (!state.shortDurationResolver) return;
  const resolve = state.shortDurationResolver;
  state.shortDurationResolver = null;
  resolve(false);
});
$('#batchExportHooks').addEventListener('click', exportAllHooks);
$('#previousComposeHook').addEventListener('click', () => navigateComposeHook(-1));
$('#nextComposeHook').addEventListener('click', () => navigateComposeHook(1));
$('#openHookExportFolder').addEventListener('click', () => openPath(state.lastExportDir));
$('#renderCompositionPreview').addEventListener('click', () => renderCompositionPreview());
$('#compositionPreview').addEventListener('timeupdate', (event) => {
  const end = Number(event.currentTarget.dataset.end);
  if (end && event.currentTarget.currentTime >= end) event.currentTarget.pause();
});
$$('video').forEach((video) => video.addEventListener('play', (event) => pauseAllPlayback(event.currentTarget)));
$$('[data-workflow-page]').forEach((button) => button.addEventListener('click', () => showWorkflowPage(button.dataset.workflowPage)));
$$('.feature-card.upcoming').forEach((button) => button.addEventListener('click', () => toast(`${button.querySelector('b').textContent}将在下一阶段开放`)));
$('#saveAiSettings').addEventListener('click', async () => {
  const provider = $('#aiProvider').value;
  const body = { provider, glmModel: $('#glmModel').value.trim() };
  const key = $('#glmApiKey').value.trim();
  if (key) body.glmApiKey = key;
  try {
    await api('/api/ai/config', { method: 'POST', body: JSON.stringify(body) });
    state.aiProvider = provider;
    await refreshStatus(provider === 'ollama');
    $('#aiDialog').close();
    toast(`${provider === 'glm' ? 'GLM' : 'Ollama'} 已设为视觉引擎`);
  } catch (error) { toast(error.message, true); }
});
$('#generateMix').addEventListener('click', generateMixPlan);
$('#labelMixCandidates').addEventListener('click', async () => {
  const ids = state.project?.segments.filter((segment) => !segment.ai).map((segment) => segment.id) || [];
  if (!ids.length) return toast('全部镜头都已完成视觉理解');
  await runAiLabels(ids, $('#labelMixCandidates'));
});
$('#exportMix').addEventListener('click', exportMixPlan);
$('#mixMode').addEventListener('change', () => {
  const batch = $('#mixMode').value === 'lines';
  $('#mixShotCount').disabled = batch;
  $('#mixModeHint').textContent = batch
    ? '逐行批量：每行匹配一个已理解镜头；片头/片尾位置受限，并跨历史方案去重。'
    : '整篇故事：只使用已理解镜头，按开场、推进、高潮、收束排列，并避免倒序。';
});
$('#openLibrary').addEventListener('click', () => openLibrary(false));
$('#openLibraryFolder').addEventListener('click', () => openPath(state.library.directory));
$$('[data-library-type]').forEach((button) => button.addEventListener('click', () => { if (state.libraryPickMode && button.dataset.libraryType !== state.libraryPickMode) return toast('本次请选择对应类型的星标内容', true); state.libraryType = button.dataset.libraryType; $$('[data-library-type]').forEach((item) => item.classList.toggle('active', item === button)); renderLibrary(); }));
$('#applyLibrarySelection').addEventListener('click', () => { $('#libraryDialog').close(); renderSources(); toast(`已手动加入 ${state.intakeLibraryIds[state.libraryPickMode].size} 项星标内容`); });
$('#libraryDialog').addEventListener('close', () => {
  const preview = $('#libraryPreview');
  preview.pause();
  preview.removeAttribute('src');
  preview.classList.add('hidden');
});
$('#applyMixSelection').addEventListener('click', () => {
  if (!state.mixPlan || !state.project) return;
  const selected = new Set(state.mixPlan.shots.map((shot) => shot.segmentId));
  state.project.segments.forEach((segment) => { segment.selected = selected.has(segment.id); });
  renderSegments(); updateSelectionSummary(); saveProjectUpdates();
  $('#mixDialog').close();
  toast(`已按故事顺序选中 ${selected.size} 个镜头`);
});
$$('.nav-item[data-view]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.view !== 'studio') toast('该模块将在后续版本开放');
}));

function setSidebarCollapsed(collapsed, persist = true) {
  const shell = $('.app-shell');
  const toggle = $('#sidebarToggle');
  shell.classList.toggle('sidebar-collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
  toggle.title = collapsed ? '展开侧边栏' : '收起侧边栏';
  if (persist) {
    try { localStorage.setItem('homix.sidebarCollapsed', collapsed ? '1' : '0'); } catch {}
  }
}

$('#sidebarToggle').addEventListener('click', () => setSidebarCollapsed(!$('.app-shell').classList.contains('sidebar-collapsed')));
try {
  const sidebarSetting = localStorage.getItem('homix.sidebarCollapsed') ?? localStorage.getItem('scenesift.sidebarCollapsed');
  setSidebarCollapsed(sidebarSetting === '1', false);
} catch { setSidebarCollapsed(false, false); }

const initialParams = new URLSearchParams(location.search);
const initialProject = initialParams.get('project');
const initialStage = initialParams.get('stage');
renderInitialMusicSources();
updateIntakeMode();
Promise.all([refreshStatus(), refreshProjects()]).then(async () => {
  if (initialProject) await openProject(initialProject);
  if (initialProject && ['extract', 'compose'].includes(initialStage)) showWorkflowPage(initialStage);
});
