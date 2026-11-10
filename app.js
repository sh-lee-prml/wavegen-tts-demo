(() => {
  'use strict';
  const metricKeys = ['wer', 'sim', 'utmos'];
  const isScore = (value) => typeof value === 'number' && Number.isFinite(value);

  // Remember the catalog as well as the selection so new imports start visible.
  function restoreSelection(modelIds, preferences) {
    if (!Array.isArray(preferences?.selectedModels) || !Array.isArray(preferences?.knownModels)) return new Set(modelIds);
    const known = new Set(preferences.knownModels);
    const selectedIds = new Set(preferences.selectedModels);
    return new Set(modelIds.filter((id) => selectedIds.has(id) || !known.has(id)));
  }

  function initialView(modelIds, preferences) {
    return { visibleModels: restoreSelection(modelIds, preferences), rankingMetric: 'default', rankingScope: 'overall' };
  }

  function chooseRandomSample(catalog, previousId, random = Math.random) {
    const candidates = catalog.length > 1 ? catalog.filter((sample) => sample.id !== previousId) : catalog;
    return candidates[Math.floor(random() * candidates.length)];
  }

  function readSharedView(href, catalog, modelCatalog) {
    const params = new URLSearchParams(new URL(href).hash.slice(1));
    const sample = catalog.find((entry) => entry.id === params.get('sample'));
    if (!sample) return null;
    const requested = (params.get('models') || '').split(',');
    const known = modelCatalog.filter((model) => requested.includes(model.id)).map((model) => model.id);
    const visibleModels = !params.has('models') || (params.get('models') !== '' && !known.length)
      ? new Set(modelCatalog.map((model) => model.id)) : new Set(known);
    const selectedRuns = Object.fromEntries(modelCatalog.flatMap((model) => {
      const run = model.runs.find((entry) => entry.id === params.get(`run.${model.id}`));
      return run ? [[model.id, run.id]] : [];
    }));
    return { sample, visibleModels, selectedRuns,
      rankingMetric: [...metricKeys, 'default'].includes(params.get('metric')) ? params.get('metric') : 'default',
      rankingScope: params.get('scope') === 'sample' ? 'sample' : 'overall' };
  }

  function buildSampleLink(href, sampleId, modelIds, selectedRuns, rankingMetric, rankingScope) {
    const url = new URL(href); url.search = ''; url.hash = '';
    const params = new URLSearchParams();
    params.set('sample', sampleId); params.set('models', modelIds.join(','));
    for (const id of modelIds) if (typeof selectedRuns[id] === 'string') params.set(`run.${id}`, selectedRuns[id]);
    params.set('metric', rankingMetric); params.set('scope', rankingScope);
    url.hash = params.toString(); return url.href;
  }

  function describeAsrError(segment) {
    if (segment.type === 'substitution') return `Substitution. ASR: ${segment.text}. Expected: ${segment.reference}.`;
    if (segment.type === 'insertion') return `Insertion. Extra ASR word: ${segment.text}. No corresponding word in the target text.`;
    if (segment.type === 'deletion') return `Omission. Expected: ${segment.text}. Missing from the ASR transcript.`;
    return '';
  }

  function rankModels(catalog, selectedIds, metric, readMetrics) {
    const rows = catalog.map((model, index) => ({ model, index, metrics: readMetrics(model) || {}, rank: null }))
      .filter(({ model }) => selectedIds.has(model.id));
    if (!metricKeys.includes(metric)) return rows;
    rows.sort((a, b) => {
      const aValue = a.metrics[metric]; const bValue = b.metrics[metric];
      const aValid = isScore(aValue); const bValid = isScore(bValue);
      if (aValid !== bValid) return aValid ? -1 : 1;
      if (!aValid) return a.index - b.index;
      return (metric === 'wer' ? aValue - bValue : bValue - aValue) || a.index - b.index;
    });
    rows.forEach((row, index) => {
      if (isScore(row.metrics[metric])) row.rank = index > 0 && row.metrics[metric] === rows[index - 1].metrics[metric] ? rows[index - 1].rank : index + 1;
    });
    return rows;
  }

  function getMetrics(model, runId, sample, scope) {
    if (scope === 'sample') return sample?.tracks?.[model.id]?.[runId]?.metrics || {};
    const run = model.runs.find((candidate) => candidate.id === runId);
    if (run?.metrics) return run.metrics;
    return model.runs.length === 1 || runId === model.defaultRun ? model.metrics || {} : {};
  }

  // Match the English WER evaluator: delete ASCII/zhon punctuation, lowercase,
  // then split whitespace. Keep source offsets so display text stays unchanged.
  const asrPunctuation = new Set('＂＃＄％＆＇（）＊＋，－／：；＜＝＞＠［＼］＾＿｀｛｜｝～｟｠｢｣､　、〃〈〉《》「」『』【】〔〕〖〗〘〙〚〛〜〝〞〟〰〾〿–—‘’‛“”„‟…‧﹏﹑﹔·．！？｡。');
  for (const [start, end] of [[33, 47], [58, 64], [91, 96], [123, 126]]) {
    for (let code = start; code <= end; code++) asrPunctuation.add(String.fromCharCode(code));
  }

  function asrTokens(text) {
    const tokens = []; let start = null; let end = 0; let normalized = ''; let offset = 0;
    const finish = () => {
      if (normalized) tokens.push({ text: text.slice(start, end), normalized, start, end });
      start = null; normalized = '';
    };
    for (const character of text) {
      const next = offset + character.length;
      if (asrPunctuation.has(character)) { if (start !== null) end = next; }
      else if (/\s/u.test(character)) finish();
      else { if (start === null) start = offset; end = next; normalized += character.toLowerCase(); }
      offset = next;
    }
    finish(); return tokens;
  }

  function diffAsrTranscript(reference, hypothesis) {
    if (typeof reference !== 'string' || typeof hypothesis !== 'string') throw new TypeError('ASR comparison requires two strings');
    const expected = asrTokens(reference); const actual = asrTokens(hypothesis);
    const rows = expected.length + 1; const columns = actual.length + 1;
    const costs = Array.from({ length: rows }, () => new Uint32Array(columns));
    for (let i = expected.length; i >= 0; i--) {
      for (let j = actual.length; j >= 0; j--) {
        if (i === expected.length) costs[i][j] = actual.length - j;
        else if (j === actual.length) costs[i][j] = expected.length - i;
        else costs[i][j] = expected[i].normalized === actual[j].normalized ? costs[i + 1][j + 1] : 1 + Math.min(costs[i + 1][j + 1], costs[i + 1][j], costs[i][j + 1]);
      }
    }
    const segments = []; let i = 0; let j = 0; let cursor = 0;
    const appendActual = (type, referenceText) => {
      const token = actual[j];
      if (token.start > cursor) segments.push({ type: 'text', text: hypothesis.slice(cursor, token.start) });
      segments.push({ type, text: token.text, ...(referenceText === undefined ? {} : { reference: referenceText }) });
      cursor = token.end; j++;
    };
    // Equal words first, then substitution/deletion/insertion resolves ties
    // consistently and keeps the earliest occurrence of repeated words matched.
    while (i < expected.length || j < actual.length) {
      if (i < expected.length && j < actual.length && expected[i].normalized === actual[j].normalized) { appendActual('match'); i++; }
      else if (i < expected.length && j < actual.length && costs[i][j] === costs[i + 1][j + 1] + 1) { appendActual('substitution', expected[i].text); i++; }
      else if (i < expected.length && costs[i][j] === costs[i + 1][j] + 1) { segments.push({ type: 'deletion', text: expected[i].text }); i++; }
      else appendActual('insertion');
    }
    if (cursor < hypothesis.length) segments.push({ type: 'text', text: hypothesis.slice(cursor) });
    return { segments, cost: costs[0][0], referenceWordCount: expected.length, hypothesisWordCount: actual.length };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { restoreSelection, rankModels, getMetrics, initialView, chooseRandomSample, diffAsrTranscript, readSharedView, buildSampleLink, describeAsrError };
  if (typeof document === 'undefined') return;
  const $ = (id) => document.getElementById(id);
  const data = window.DEMO_CATALOG;
  if (!data || !Array.isArray(data.samples) || !Array.isArray(data.models) || !data.models.length || !data.samples.length) {
    $('workspace').hidden = true;
    $('fatal-error').hidden = false;
    $('comparison-setup').hidden = true;
    $('fatal-error').textContent = 'The audio collection could not be loaded. Keep the catalog, sample files, and audio folder together.';
    return;
  }

  if (location.protocol === 'file:' || !window.DemoMediaStore) {
    $('workspace').hidden = true; $('comparison-setup').hidden = true;
    $('fatal-error').hidden = false;
    $('fatal-error').textContent = location.protocol === 'file:' ? 'Serve this folder over HTTP(S) to load samples. See README.md for local preview instructions.' : 'The audio loader could not be loaded. Refresh the page to try again.';
    return;
  }
  const mediaStore = window.DemoMediaStore.create({ baseURL: new URL('.', location.href).href, contentVersion: data.contentVersion });

  const samples = data.samples;
  const models = data.models.filter((model) => Array.isArray(model.runs) && model.runs.length);
  const modelIds = models.map((model) => model.id);
  const storageScope = ':' + encodeURIComponent(new URL('.', location.href).pathname);
  const preferencesKey = 'tts-comparison-view-v1' + storageScope;
  let preferences = null;
  try { preferences = JSON.parse(localStorage.getItem(preferencesKey) || 'null'); } catch (_) {}
  let { visibleModels, rankingMetric, rankingScope } = initialView(modelIds, preferences);
  const sharedView = readSharedView(location.href, samples, models);
  if (sharedView) ({ visibleModels, rankingMetric, rankingScope } = sharedView);
  const accents = ['#4564d9', '#14877d', '#865cc4', '#b77932', '#267d9c', '#6c833e', '#b25c83', '#8f6952', '#9f5961', '#527078'];
  const knownAccents = { wavtts: '#4564d9', wavegen: '#14877d', wavegenpretrained: '#387953', wavegenvloss: '#526ca6', smd: '#865cc4', qwen3tts: '#b77932', voxcpm2: '#267d9c', e2tts: '#6c833e', f5tts: '#b25c83', ming3tts05b: '#8f6952', drama3: '#9f5961', mossttslocal17b: '#527078' };
  const modelAccents = new Map(models.map((model, index) => [model.id, knownAccents[model.id] || accents[index % accents.length]]));
  $('model-grid').style.setProperty('--model-columns', String(Math.min(3, models.length)));
  document.title = 'WaveGen - Zero-shot TTS Benchmark';
  const pageSize = 8;
  const storageKey = 'soundroom-listening-notes-v1' + storageScope;
  let saved = { notes: {}, favorites: [] };
  let storageAvailable = true;
  try { const previous = JSON.parse(localStorage.getItem(storageKey) || 'null'); if (previous && typeof previous === 'object') saved = { notes: previous.notes && typeof previous.notes === 'object' ? previous.notes : {}, favorites: Array.isArray(previous.favorites) ? previous.favorites : [] }; } catch (_) { storageAvailable = false; }
  let favorites = new Set(saved.favorites);
  const lastSampleKey = 'tts-comparison-last-sample-v1' + storageScope;
  let previousSampleId = null;
  try { previousSampleId = localStorage.getItem(lastSampleKey); } catch (_) {}
  let selected = sharedView?.sample || chooseRandomSample(samples, previousSampleId);
  let selectedDetail = null;
  let selectionVersion = 0;
  let sampleLoading = true;
  let page = 0;
  let query = '';
  let favoritesOnly = false;
  let speed = 1;
  let toastTimeout;
  const cards = new Map();
  const modelCheckboxes = new Map();
  const selectedRuns = Object.fromEntries(models.map((model) => [model.id, model.runs.some((run) => run.id === model.defaultRun) ? model.defaultRun : model.runs[0].id]));
  if (sharedView) Object.assign(selectedRuns, sharedView.selectedRuns);
  const number = (value) => Number(value || 0).toLocaleString('en-US');
  const elapsed = (value) => { const seconds = Math.max(0, Math.floor(Number(value) || 0)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
  const readableBytes = (value) => Number(value) >= 1000 ** 3 ? `${(value / 1000 ** 3).toFixed(2)} GB` : `${(Number(value || 0) / 1000 ** 2).toFixed(1)} MB`;
  const formatMetric = (value, key) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    if (key !== 'wer') return value.toFixed(3);
    // Truncate displayed WER percentages; ranking and stored scores retain full precision.
    const hundredths = value * 10000;
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(hundredths)) * 4;
    return `${(Math.trunc(hundredths + tolerance) / 100).toFixed(2)}%`;
  };
  const metricTitle = (value, key) => isScore(value) ? `${key.toUpperCase()}: ${key === 'wer' ? `${value * 100}%` : value}` : 'Score unavailable';
  const playbackIcon = '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5Z"/></svg>';
  const pauseIcon = '<svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 2h4v12H3zm6 0h4v12H9Z"/></svg>';

  function toast(message) { clearTimeout(toastTimeout); $('toast').textContent = message; $('toast').hidden = false; toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 3500); }
  const mobilePicker = window.matchMedia?.('(max-width: 620px)');
  let pickerOpen = false;
  function syncPicker() {
    const expanded = !mobilePicker?.matches || pickerOpen;
    $('sample-picker-toggle').setAttribute('aria-expanded', String(expanded));
    $('sample-picker-toggle').textContent = expanded ? 'Close samples' : 'Choose sample';
    $('sample-picker-content').hidden = !expanded;
    $('sample-library').classList.toggle('is-collapsed', !expanded);
  }
  function closePicker() {
    if (!mobilePicker?.matches) return;
    pickerOpen = false; syncPicker(); $('sample-picker-toggle').focus();
  }
  $('sample-picker-toggle').addEventListener('click', () => {
    pickerOpen = !pickerOpen; syncPicker();
    if (pickerOpen) $('search').focus();
  });
  $('sample-picker-content').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && mobilePicker?.matches) { event.preventDefault(); closePicker(); }
  });
  mobilePicker?.addEventListener('change', () => {
    if (mobilePicker.matches && $('sample-picker-content').contains(document.activeElement)) pickerOpen = true;
    syncPicker();
  });
  syncPicker();

  $('copy-sample-link').addEventListener('click', async () => {
    const link = buildSampleLink(location.href, selected.id, modelIds.filter((id) => visibleModels.has(id)), selectedRuns, rankingMetric, rankingScope);
    $('sample-link-fallback').hidden = true;
    try {
      if (!window.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await window.navigator.clipboard.writeText(link); toast('Sample link copied.');
    } catch (_) {
      $('sample-link-value').value = link; $('sample-link-fallback').hidden = false;
      $('sample-link-value').focus(); $('sample-link-value').select();
      toast('Copy the sample link below.');
    }
  });
  $('sample-link-value').addEventListener('click', () => $('sample-link-value').select());
  function closeShareFallback() { $('sample-link-fallback').hidden = true; $('copy-sample-link').focus(); }
  $('sample-link-close').addEventListener('click', closeShareFallback);
  $('sample-link-fallback').addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); closeShareFallback(); } });
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify({ notes: saved.notes, favorites: [...favorites] })); storageAvailable = true; }
    catch (_) { storageAvailable = false; }
    $('note-status').textContent = storageAvailable ? 'Saved' : 'Could not save';
  }
  function filteredSamples() { const term = query.toLocaleLowerCase(); return samples.filter((sample) => (!favoritesOnly || favorites.has(sample.id)) && (!term || `${sample.id} ${sample.text || ''}`.toLocaleLowerCase().includes(term))); }
  function currentTrack(modelId) { return modelId === 'prompt' ? selectedDetail?.promptAudio : selectedDetail?.tracks?.[modelId]?.[selectedRuns[modelId]]; }
  function pauseCard(card) {
    card.playToken = (card.playToken || 0) + 1; card.loading = false;
    card.loadController?.abort(); card.loadController = null;
    card.audio.pause(); updatePlayState(card);
  }
  function stopAll(except) { cards.forEach((card) => { if (card.audio !== except) pauseCard(card); }); }
  function resetCardAudio(card) {
    pauseCard(card); card.pendingSeek = 0;
    card.audio.removeAttribute('src'); card.audio.load();
    if (card.blobUrl) mediaStore.releaseAudio(card.blobUrl);
    card.blobUrl = null;
  }

  $('sample-total').textContent = number(data.sampleCount || samples.length);
  $('model-total').textContent = number(models.length);
  $('audio-total').textContent = number(data.totalFiles);
  $('run-total').textContent = number(models.reduce((sum, model) => sum + model.runs.length, 0));
  $('dataset-label').textContent = data.dataset || 'Seed-TTS test · EN';
  $('collection-summary').textContent = data.promptCount ? `${number(data.generatedFiles)} generated files · ${number(data.promptCount)} reference files · ${readableBytes(data.totalBytes)}` : `${number(data.totalFiles)} audio files · ${readableBytes(data.totalBytes)}`;
  if (!storageAvailable) $('note-status').textContent = 'Autosave unavailable · export your notes';

  function persistView() {
    try { localStorage.setItem(preferencesKey, JSON.stringify({ selectedModels: [...visibleModels], knownModels: modelIds })); }
    catch (_) { toast('This browser could not save your view preferences.'); }
  }

  function appendNfeBadge(parent, model, run) {
    if (!Number.isFinite(run?.nfe) || run.nfe <= 0) return;
    const badge = document.createElement('span'); badge.className = 'nfe-badge';
    badge.textContent = `NFE ${run.nfe}`; parent.append(badge);
  }

  function shortRunLabel(model, run) {
    return (run?.label || '').split('·').map((part) => part.trim())
      .filter((part) => part && !/\b(?:NFE|CFG|Seed|Euler)\b|Scheduled K3/i.test(part)).join(' · ');
  }

  function displayRunDescription(run) {
    const detail = run?.detail || run?.label || '';
    try {
      const settings = JSON.parse(detail);
      return JSON.stringify(Object.fromEntries(Object.entries(settings)
        .filter(([key, value]) => !/seed|cfg/i.test(key) && !/euler|scheduled k3/i.test(String(value)))));
    } catch (_) {
      const parts = detail.includes(' · ') ? detail.split(' · ') : detail.split('_');
      return parts.filter((part) => !/seed|cfg|euler|scheduled k3|first 3 calls text-only null/i.test(part)).join(' · ');
    }
  }

  function createModelSelection() {
    models.forEach((model) => {
      const label = document.createElement('label'); label.className = 'model-chip';
      label.style.setProperty('--accent', modelAccents.get(model.id));
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = model.id;
      input.id = `model-select-${model.id}`; input.checked = visibleModels.has(model.id);
      const check = document.createElement('span'); check.className = 'chip-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.textContent = model.name;
      label.append(input, check, name);
      appendNfeBadge(label, model, model.runs.find((run) => run.id === selectedRuns[model.id]));
      $('model-selection').append(label); modelCheckboxes.set(model.id, input);
      input.addEventListener('change', () => {
        if (input.checked) visibleModels.add(model.id); else visibleModels.delete(model.id);
        persistView(); renderComparison();
      });
    });
  }

  function renderComparison() {
    if (!$('sample-link-fallback').hidden) {
      const currentLink = buildSampleLink(location.href, selected.id, modelIds.filter((id) => visibleModels.has(id)), selectedRuns, rankingMetric, rankingScope);
      if ($('sample-link-value').value !== currentLink) $('sample-link-fallback').hidden = true;
    }
    const rows = rankModels(models, visibleModels, rankingMetric, (model) => getMetrics(model, selectedRuns[model.id], selectedDetail, rankingScope));
    const isRanked = rankingMetric !== 'default';
    const scopeLabel = rankingScope === 'sample' ? 'Current sample' : 'Overall';
    const orderLabel = isRanked ? `${rankingMetric.toUpperCase()} ${rankingMetric === 'wer' ? '↑ low to high' : '↓ high to low'}` : 'Default model order';
    $('ranking-metric').value = rankingMetric; $('ranking-scope').value = rankingScope;
    $('selection-count').textContent = `${rows.length} of ${models.length} selected`;
    $('models-all').disabled = rows.length === models.length; $('models-clear').disabled = rows.length === 0;
    $('rank-column').textContent = isRanked ? 'Rank' : 'Order';
    $('ranking-context').hidden = rankingScope !== 'sample';
    $('ranking-context').textContent = rankingScope === 'sample' ? `Sample ${number(samples.indexOf(selected) + 1)}` : '';
    $('ranking-caption').textContent = `${scopeLabel} model rankings, ${orderLabel}`;
    $('card-order').textContent = `${scopeLabel} · ${isRanked ? `${rankingMetric.toUpperCase()} rank` : 'model order'}`;
    $('ranking-footnote').textContent = isRanked ? 'Ranks use the selected models. Ties share a rank; unavailable scores appear last.' : '';
    metricKeys.forEach((key) => {
      const header = $(`metric-${key}`);
      if (key === rankingMetric) header.setAttribute('aria-sort', key === 'wer' ? 'ascending' : 'descending');
      else header.removeAttribute('aria-sort');
    });
    models.forEach((model) => {
      modelCheckboxes.get(model.id).checked = visibleModels.has(model.id);
      const card = cards.get(model.id);
      if (card) { card.element.hidden = !visibleModels.has(model.id); if (card.element.hidden && (card.loading || !card.audio.paused)) pauseCard(card); }
    });
    $('metrics-section').hidden = false;
    $('empty-models').hidden = rows.length > 0;
    $('model-grid').style.setProperty('--model-columns', String(Math.max(1, Math.min(3, rows.length))));
    $('model-grid').style.setProperty('--model-columns-medium', String(Math.max(1, Math.min(2, rows.length))));
    $('metrics-table-body').replaceChildren();
    if (!rows.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td');
      cell.colSpan = 6; cell.className = 'empty-ranking'; cell.textContent = 'Select a model to view its ranking.'; row.append(cell); $('metrics-table-body').append(row);
    }
    rows.forEach(({ model, metrics, rank }, index) => {
      const row = document.createElement('tr');
      row.dataset.modelId = model.id; row.style.setProperty('--accent', modelAccents.get(model.id));
      const position = document.createElement('td'); position.className = 'rank-cell'; position.textContent = isRanked ? (rank === null ? '—' : String(rank).padStart(2, '0')) : String(index + 1).padStart(2, '0'); row.append(position);
      const name = document.createElement('th'); name.scope = 'row';
      const label = document.createElement('span'); label.className = `metric-model-label ${model.id}`; label.textContent = model.name; name.append(label);
      const run = model.runs.find((candidate) => candidate.id === selectedRuns[model.id]);
      appendNfeBadge(label, model, run);
      const runLabel = shortRunLabel(model, run);
      if (runLabel) { const config = document.createElement('span'); config.className = 'table-config'; config.textContent = runLabel; name.append(config); }
      row.append(name);
      metricKeys.forEach((key) => { const cell = document.createElement('td'); cell.textContent = formatMetric(metrics[key], key); cell.title = metricTitle(metrics[key], key); cell.classList.toggle('active-metric', key === rankingMetric); row.append(cell); });
      const count = document.createElement('td'); count.className = 'metric-count-column'; count.textContent = rankingScope === 'sample' ? (metricKeys.some((key) => isScore(metrics[key])) ? '1' : '—') : Number.isFinite(metrics.sampleCount) ? number(metrics.sampleCount) : '—'; row.append(count);
      $('metrics-table-body').append(row);
      const card = cards.get(model.id);
      if (card) {
        card.rank.textContent = isRanked ? (rank === null ? '—' : `#${rank}`) : String(index + 1).padStart(2, '0');
        card.rank.title = isRanked ? `${scopeLabel} ${rankingMetric.toUpperCase()} rank among selected models${rank === null ? ': unavailable' : `: ${rank}`}` : 'Default model order';
        card.rank.setAttribute('aria-label', card.rank.title);
        $('model-grid').append(card.element);
      }
    });
  }

  function closeAsrError(card, restoreFocus = false) {
    const active = card.activeAsrWord;
    if (active) active.setAttribute('aria-expanded', 'false');
    card.activeAsrWord = null; card.asrErrorPanel.hidden = true;
    if (restoreFocus && active) active.focus();
  }

  function renderSampleMetrics(card, track) {
    card.metricSection.hidden = !selectedDetail;
    ['wer', 'sim', 'utmos'].forEach((key) => { card.metricValues[key].textContent = formatMetric(track?.metrics?.[key], key); card.metricValues[key].title = metricTitle(track?.metrics?.[key], key); });
    const asrText = track?.metrics?.asrText;
    closeAsrError(card);
    card.asrText.replaceChildren();
    card.asrText.classList.toggle('asr-unavailable', typeof asrText !== 'string');
    if (typeof asrText !== 'string') { card.asrText.textContent = 'Unavailable'; return; }
    const diff = diffAsrTranscript(selected.text || '', asrText);
    for (const segment of diff.segments) {
      const description = describeAsrError(segment);
      const word = document.createElement(description ? 'button' : 'span');
      if (description) {
        word.type = 'button'; word.className = 'asr-word-error'; word.title = description;
        word.setAttribute('aria-label', `${description} Show error details.`);
        word.setAttribute('aria-expanded', 'false'); word.setAttribute('aria-controls', card.asrErrorPanel.id);
        word.addEventListener('click', () => {
          const wasOpen = card.activeAsrWord === word;
          closeAsrError(card);
          if (!wasOpen) {
            card.activeAsrWord = word; word.setAttribute('aria-expanded', 'true');
            card.asrErrorText.textContent = description; card.asrErrorPanel.hidden = false;
          }
        });
      }
      if (segment.type === 'deletion') {
        const missing = document.createElement('del'); missing.className = 'asr-word-missing'; missing.textContent = segment.text; word.append(missing);
      } else word.textContent = segment.text;
      card.asrText.append(word);
    }
    if (!diff.segments.length) card.asrText.textContent = '(Empty transcript)';
  }

  function renderList() {
    const filtered = filteredSamples();
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.max(0, Math.min(page, pageCount - 1));
    $('library-count').textContent = number(filtered.length);
    $('favorite-count').textContent = number(samples.filter((sample) => favorites.has(sample.id)).length);
    $('sample-list').replaceChildren();
    filtered.slice(page * pageSize, page * pageSize + pageSize).forEach((sample) => {
      const item = document.createElement('button');
      item.type = 'button'; item.className = `sample-item${sample.id === selected.id ? ' selected' : ''}`;
      item.setAttribute('aria-pressed', String(sample.id === selected.id));
      item.title = `${sample.id}\n${sample.text || ''}`;
      const heading = document.createElement('span'); heading.className = 'sample-item-heading';
      const id = document.createElement('span'); id.className = 'sample-item-id'; id.textContent = `${String(samples.indexOf(sample) + 1).padStart(4, '0')} · ${sample.id.split('-').at(-1).replace('common_voice_en_', '')}`;
      heading.append(id);
      if (favorites.has(sample.id)) { const star = document.createElement('span'); star.className = 'sample-item-star'; star.textContent = '★'; star.setAttribute('aria-label', 'Favorite sample'); heading.append(star); }
      const preview = document.createElement('span'); preview.className = 'sample-preview'; preview.textContent = sample.text || 'No transcript available';
      item.append(heading, preview); item.addEventListener('click', () => { closePicker(); selectSample(sample, false); });
      $('sample-list').append(item);
    });
    $('empty-list').hidden = filtered.length > 0;
    $('page-info').textContent = `${page + 1} / ${pageCount}`;
    $('page-prev').disabled = page === 0;
    $('page-next').disabled = page >= pageCount - 1;
    updateNavigation();
  }

  function updateNavigation() {
    const filtered = filteredSamples();
    const index = filtered.findIndex((sample) => sample.id === selected.id);
    $('sample-prev').disabled = !filtered.length || index <= 0;
    $('sample-next').disabled = !filtered.length || index === filtered.length - 1;
    $('random-sample').disabled = !filtered.length;
    $('selected-position').textContent = index >= 0 ? `${number(index + 1)} / ${number(filtered.length)}` : 'Outside current filter';
  }

  function renderWaveform(card, track) {
    const peaks = Array.isArray(track?.peaks) ? track.peaks.filter((peak) => Number.isFinite(Number(peak))).map((peak) => Math.max(0, Math.min(1, Math.abs(Number(peak))))) : [];
    card.waveform.replaceChildren();
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'waveform-svg'); svg.setAttribute('viewBox', '0 0 320 60'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
    const clipId = `clip-${card.model.id}`;
    const defs = document.createElementNS(ns, 'defs'); const clip = document.createElementNS(ns, 'clipPath'); clip.id = clipId;
    const clipRect = document.createElementNS(ns, 'rect'); clipRect.setAttribute('width', '0'); clipRect.setAttribute('height', '60'); clip.append(clipRect); defs.append(clip); svg.append(defs); card.clipRect = clipRect;
    if (peaks.length) {
      const back = document.createElementNS(ns, 'g'); back.setAttribute('class', 'waveform-back');
      const front = document.createElementNS(ns, 'g'); front.setAttribute('class', 'waveform-front'); front.setAttribute('clip-path', `url(#${clipId})`);
      const bars = Math.min(80, peaks.length);
      for (let i = 0; i < bars; i++) {
        const start = Math.floor(i * peaks.length / bars); const end = Math.max(start + 1, Math.floor((i + 1) * peaks.length / bars));
        const peak = Math.max(...peaks.slice(start, end)); const height = Math.max(2, peak * 54); const x = 2 + i * 316 / Math.max(1, bars - 1);
        const line = document.createElementNS(ns, 'line'); line.setAttribute('x1', String(x)); line.setAttribute('x2', String(x)); line.setAttribute('y1', String(30 - height / 2)); line.setAttribute('y2', String(30 + height / 2)); back.append(line); front.append(line.cloneNode());
      }
      svg.append(back, front);
    } else { const placeholder = document.createElement('span'); placeholder.className = 'waveform-empty'; placeholder.textContent = track ? 'No waveform preview' : 'No audio for this configuration'; card.waveform.append(placeholder); }
    card.waveform.append(svg);
    const head = document.createElement('span'); head.className = 'waveform-playhead'; head.setAttribute('aria-hidden', 'true'); card.waveform.append(head); card.playhead = head;
    const seek = document.createElement('input'); seek.className = 'waveform-seek'; seek.type = 'range'; seek.min = '0'; seek.max = '1000'; seek.step = '1'; seek.value = '0'; seek.setAttribute('aria-label', `${card.model.name} playback position`); seek.disabled = !track;
    seek.addEventListener('input', () => {
      const duration = Number.isFinite(card.audio.duration) ? card.audio.duration : Number(track?.duration || 0);
      if (duration > 0) {
        card.pendingSeek = duration * Number(seek.value) / 1000;
        if (card.blobUrl && card.audio.readyState > 0) { try { card.audio.currentTime = card.pendingSeek; } catch (_) {} }
        updateProgress(card);
      }
    });
    card.waveform.append(seek); card.seek = seek;
  }

  function updateProgress(card) {
    const track = currentTrack(card.model.id);
    const duration = Number.isFinite(card.audio.duration) ? card.audio.duration : Number(track?.duration || 0);
    const currentTime = card.blobUrl && card.audio.readyState > 0 ? Number(card.audio.currentTime || 0) : Number(card.pendingSeek || 0);
    const fraction = duration > 0 ? Math.min(1, currentTime / duration) : 0;
    card.currentTime.textContent = elapsed(currentTime);
    card.duration.textContent = elapsed(duration);
    if (card.seek) { card.seek.value = String(Math.round(fraction * 1000)); card.seek.setAttribute('aria-valuetext', `${elapsed(currentTime)} / ${elapsed(duration)}`); }
    if (card.clipRect) card.clipRect.setAttribute('width', String(fraction * 320));
    if (card.playhead) card.playhead.style.left = `${fraction * 100}%`;
  }

  function updatePlayState(card) {
    const isPlaying = !card.audio.paused;
    card.play.innerHTML = `${isPlaying ? pauseIcon : playbackIcon}<span>${card.loading ? 'Loading…' : isPlaying ? 'Pause' : 'Play'}</span>`;
    card.play.setAttribute('aria-label', `${card.loading ? 'Cancel loading' : isPlaying ? 'Pause' : 'Play'} ${card.model.name}`);
    card.play.setAttribute('aria-busy', String(Boolean(card.loading)));
    card.element.classList.toggle('is-playing', isPlaying);
  }

  function loadCard(card) {
    if (card.model.id === 'prompt') { loadPrompt(card); return; }
    const track = currentTrack(card.model.id);
    const run = card.model.runs.find((candidate) => candidate.id === selectedRuns[card.model.id]);
    resetCardAudio(card);
    card.error.hidden = true;
    card.runDescription.textContent = displayRunDescription(run);
    card.runDescription.title = card.runDescription.textContent;
    card.select.value = selectedRuns[card.model.id];
    card.select.title = shortRunLabel(card.model, run);
    card.runSummary.textContent = shortRunLabel(card.model, run);
    card.element.querySelector('.nfe-badge')?.remove();
    appendNfeBadge(card.element.querySelector('.model-name'), card.model, run);
    card.play.disabled = !track?.src;
    card.download.setAttribute('aria-disabled', String(!track?.src));
    if (track?.src) {
      card.audio.playbackRate = speed;
      card.download.href = track.src;
      card.download.download = `${selected.id}_${card.model.name}_${run?.id || ''}.wav`;
      const sr = Number(track.sampleRate || 0); const srLabel = sr ? `${Number((sr / 1000).toFixed(1))} kHz` : 'WAV';
      card.specs.textContent = `${srLabel} · ${track.channels === 1 ? 'Mono' : track.channels === 2 ? 'Stereo' : track.channels ? `${track.channels} ch` : 'Audio'}`;
      card.footerLabel.textContent = run?.nfe ? `NFE ${run.nfe} · LOCAL FILE` : 'LOCAL FILE';
    } else {
      card.download.removeAttribute('href');
      card.specs.textContent = ''; card.footerLabel.textContent = 'UNAVAILABLE';
      card.error.textContent = 'Audio is unavailable for this sample and configuration.'; card.error.hidden = sampleLoading || !selectedDetail;
    }
    renderSampleMetrics(card, track);
    renderWaveform(card, track);
    updateProgress(card); updatePlayState(card);
  }

  function createCard(model, index) {
    const element = document.createElement('article'); element.className = `model-card ${model.id}`; element.setAttribute('aria-label', `${model.name} audio`);
    element.dataset.modelId = model.id; element.style.setProperty('--accent', modelAccents.get(model.id));
    element.innerHTML = `<div class="model-top"><div class="model-title-line"><h3 class="model-name"><span class="name-text"></span></h3><span class="card-rank"></span></div><div class="model-config-line"><span class="model-checkpoint"></span><span class="run-summary"></span></div><select class="run-select" id="run-${model.id}"></select></div><div class="waveform-wrap"></div><div class="audio-time-row"><span class="current-time">0:00</span><span class="duration">0:00</span></div><div class="audio-controls"><button type="button" class="play-button"></button><span class="audio-specs"></span></div><p class="card-error" role="status" hidden></p><div class="model-footer"><span class="footer-label" hidden></span><details class="config-details"><summary>Configuration</summary><p class="run-description"></p></details><a class="download-link"><svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4"/></svg>WAV</a></div>`;
    const card = { element, model, audio: new Audio(), select: element.querySelector('.run-select'), runDescription: element.querySelector('.run-description'), play: element.querySelector('.play-button'), waveform: element.querySelector('.waveform-wrap'), currentTime: element.querySelector('.current-time'), duration: element.querySelector('.duration'), specs: element.querySelector('.audio-specs'), footerLabel: element.querySelector('.footer-label'), download: element.querySelector('.download-link'), error: element.querySelector('.card-error') };
    card.rank = element.querySelector('.card-rank');
    const metricSection = document.createElement('section'); metricSection.className = 'sample-metrics'; metricSection.setAttribute('aria-label', `${model.name} current sample metrics`);
    metricSection.innerHTML = '<div class="sample-metrics-label">Current sample</div><div class="metric-triplet"><div><span>WER ↓</span><strong data-metric="wer">—</strong></div><div><span>SIM ↑</span><strong data-metric="sim">—</strong></div><div><span>UTMOS ↑</span><strong data-metric="utmos">—</strong></div></div><div class="asr-details"><div class="asr-label">ASR transcript</div><p></p></div>';
    element.insertBefore(metricSection, element.querySelector('.model-footer'));
    card.metricSection = metricSection;
    card.metricValues = Object.fromEntries(['wer', 'sim', 'utmos'].map((key) => [key, metricSection.querySelector(`[data-metric="${key}"]`)]));
    card.asrDetails = metricSection.querySelector('.asr-details'); card.asrText = card.asrDetails.querySelector('p');
    card.asrErrorPanel = document.createElement('div'); card.asrErrorPanel.className = 'asr-error-detail'; card.asrErrorPanel.id = `asr-error-${model.id}`; card.asrErrorPanel.hidden = true;
    card.asrErrorText = document.createElement('span'); card.asrErrorText.setAttribute('role', 'status'); card.asrErrorText.setAttribute('aria-live', 'polite');
    const closeError = document.createElement('button'); closeError.type = 'button'; closeError.className = 'asr-error-close'; closeError.textContent = 'Close'; closeError.setAttribute('aria-label', `Close ${model.name} ASR error details`);
    closeError.addEventListener('click', () => closeAsrError(card, true));
    card.asrErrorPanel.append(card.asrErrorText, closeError); card.asrDetails.append(card.asrErrorPanel);
    card.asrDetails.addEventListener('keydown', (event) => { if (event.key === 'Escape' && card.activeAsrWord) { event.preventDefault(); closeAsrError(card, true); } });
    element.querySelector('.name-text').textContent = model.name;
    element.querySelector('.model-checkpoint').textContent = model.modelSize || '';
    element.querySelector('.model-checkpoint').hidden = !model.modelSize;
    card.select.setAttribute('aria-label', `${model.name} generation configuration`);
    card.select.disabled = model.runs.length < 2;
    card.select.hidden = model.runs.length < 2;
    card.runSummary = element.querySelector('.run-summary');
    card.runSummary.hidden = model.runs.length > 1;
    model.runs.forEach((run, runIndex) => { const option = document.createElement('option'); option.value = run.id; option.textContent = [run?.nfe ? `NFE ${run.nfe}` : '', shortRunLabel(model, run)].filter(Boolean).join(' · ') || `Configuration ${runIndex + 1}`; card.select.append(option); });
    card.select.addEventListener('change', () => { selectedRuns[model.id] = card.select.value; loadCard(card); renderComparison(); });
    card.download.setAttribute('aria-label', `Download current ${model.name} audio`);
    wireAudio(card);
    cards.set(model.id, card); $('model-grid').append(element); loadCard(card);
  }

  function wireAudio(card) {
    const model = card.model;
    card.audio.preload = 'none';
    card.audio.addEventListener('play', () => { stopAll(card.audio); updatePlayState(card); });
    card.audio.addEventListener('pause', () => updatePlayState(card));
    card.audio.addEventListener('ended', () => updatePlayState(card));
    card.audio.addEventListener('timeupdate', () => updateProgress(card));
    card.audio.addEventListener('loadedmetadata', () => {
      if (card.pendingSeek > 0) { try { card.audio.currentTime = card.pendingSeek; } catch (_) {} }
      updateProgress(card);
    });
    card.audio.addEventListener('error', () => { if (card.blobUrl) { card.error.textContent = 'Audio could not be loaded. Press Play to try again.'; card.error.hidden = false; updatePlayState(card); } });
    card.play.addEventListener('click', async () => {
      if (card.loading || !card.audio.paused) { pauseCard(card); return; }
      const track = currentTrack(model.id);
      if (!track?.src) return;
      stopAll(card.audio); card.error.hidden = true;
      const token = card.playToken = (card.playToken || 0) + 1;
      const controller = new AbortController(); card.loadController = controller;
      try {
        if (!card.blobUrl) {
          card.loading = true; updatePlayState(card);
          const audio = await mediaStore.loadAudio(track, { signal: controller.signal });
          if (token !== card.playToken || track !== currentTrack(model.id) || card.element.hidden) { mediaStore.releaseAudio(audio.url); return; }
          card.blobUrl = audio.url; card.audio.src = audio.url;
          card.audio.playbackRate = speed;
        }
        card.loading = false; updatePlayState(card);
        await card.audio.play();
      } catch (error) {
        if (token === card.playToken && error.name !== 'AbortError') {
          card.error.textContent = error.name === 'NotAllowedError' ? 'Audio is ready. Press Play to start.' : 'Audio could not be loaded. Press Play to try again.';
          card.error.hidden = false;
          if (error.name !== 'NotAllowedError' && card.blobUrl) {
            card.audio.removeAttribute('src'); card.audio.load();
            mediaStore.releaseAudio(card.blobUrl); card.blobUrl = null;
          }
        }
      } finally {
        if (card.loadController === controller) card.loadController = null;
        if (token === card.playToken) { card.loading = false; updatePlayState(card); }
      }
    });
  }

  function createPromptCard() {
    const element = $('prompt-player');
    element.innerHTML = '<div class="prompt-top"><h3>Reference prompt</h3><span class="prompt-specs"></span></div><div class="prompt-playback"><button type="button" class="play-button"></button><div class="prompt-wave-body"><div class="waveform-wrap"></div><div class="audio-time-row"><span class="current-time">0:00</span><span class="duration">0:00</span></div></div><a class="download-link" aria-label="Download reference prompt audio"><svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4"/></svg><span>WAV</span></a></div><p class="card-error" role="status" hidden></p>';
    element.append($('prompt-details'));
    const card = { element, model: { id: 'prompt', name: 'reference prompt' }, audio: new Audio(), play: element.querySelector('.play-button'), waveform: element.querySelector('.waveform-wrap'), currentTime: element.querySelector('.current-time'), duration: element.querySelector('.duration'), specs: element.querySelector('.prompt-specs'), download: element.querySelector('.download-link'), error: element.querySelector('.card-error') };
    wireAudio(card); cards.set('prompt', card); loadPrompt(card);
  }

  function loadPrompt(card) {
    const track = selectedDetail?.promptAudio;
    resetCardAudio(card); card.error.hidden = true;
    card.element.hidden = !track?.src;
    card.play.disabled = !track?.src;
    card.download.setAttribute('aria-disabled', String(!track?.src));
    if (track?.src) {
      card.audio.playbackRate = speed;
      card.download.href = track.src; card.download.download = `${selected.id}_prompt.wav`;
      const sr = Number(track.sampleRate || 0);
      card.specs.textContent = `${sr ? `${Number((sr / 1000).toFixed(1))} kHz` : 'WAV'} · ${track.channels === 1 ? 'Mono' : track.channels === 2 ? 'Stereo' : 'Audio'}`;
    } else { card.download.removeAttribute('href'); card.specs.textContent = ''; }
    renderWaveform(card, track); updateProgress(card); updatePlayState(card);
  }

  async function selectSample(sample, reveal = true) {
    const version = ++selectionVersion;
    stopAll(); selected = sample; selectedDetail = null; sampleLoading = true;
    $('sample-status').hidden = false; $('sample-status-text').textContent = 'Loading sample…'; $('sample-retry').hidden = true;
    $('model-grid').setAttribute('aria-busy', 'true');
    try { localStorage.setItem(lastSampleKey, sample.id); } catch (_) {}
    if (reveal) { const index = filteredSamples().findIndex((candidate) => candidate.id === sample.id); if (index >= 0) page = Math.floor(index / pageSize); }
    $('selected-id').textContent = sample.id;
    $('picker-summary').textContent = sample.text || sample.id;
    $('language-badge').textContent = (sample.language || 'en').toUpperCase();
    $('transcript').textContent = sample.text || 'No transcript is available for this sample.';
    $('prompt-details').hidden = true;
    $('prompt-text').textContent = '';
    $('prompt-details').open = false;
    $('favorite-toggle').textContent = favorites.has(sample.id) ? '★' : '☆';
    $('favorite-toggle').setAttribute('aria-pressed', String(favorites.has(sample.id)));
    $('favorite-toggle').setAttribute('aria-label', favorites.has(sample.id) ? 'Remove current sample from favorites' : 'Add current sample to favorites');
    $('listening-note').value = saved.notes[sample.id] || '';
    cards.forEach(loadCard); renderList(); renderComparison();
    try {
      const detail = await mediaStore.loadSample(sample);
      if (version !== selectionVersion) return;
      if (detail.id !== selected.id || !detail.tracks) throw new Error('Sample does not match the catalog');
      selectedDetail = detail; sampleLoading = false;
      $('prompt-details').hidden = !detail.promptText; $('prompt-text').textContent = detail.promptText || '';
      $('sample-status').hidden = true; $('model-grid').setAttribute('aria-busy', 'false');
      cards.forEach(loadCard); renderComparison();
    } catch (_) {
      if (version !== selectionVersion) return;
      sampleLoading = false; $('model-grid').setAttribute('aria-busy', 'false');
      $('sample-status-text').textContent = 'This sample could not be loaded.'; $('sample-retry').hidden = false;
    }
  }

  $('sample-retry').addEventListener('click', () => selectSample(selected, false));
  window.addEventListener('pagehide', () => cards.forEach(resetCardAudio));

  $('search').addEventListener('input', (event) => { query = event.target.value.trim(); page = 0; renderList(); });
  $('show-all').addEventListener('click', () => setFilter(false));
  $('show-favorites').addEventListener('click', () => setFilter(true));
  function setFilter(value) { favoritesOnly = value; page = 0; $('show-all').classList.toggle('active', !value); $('show-favorites').classList.toggle('active', value); $('show-all').setAttribute('aria-pressed', String(!value)); $('show-favorites').setAttribute('aria-pressed', String(value)); renderList(); }
  $('page-prev').addEventListener('click', () => { page--; renderList(); });
  $('page-next').addEventListener('click', () => { page++; renderList(); });
  $('sample-prev').addEventListener('click', () => navigate(-1));
  $('sample-next').addEventListener('click', () => navigate(1));
  function navigate(direction) { const filtered = filteredSamples(); const index = filtered.findIndex((sample) => sample.id === selected.id); const target = index < 0 ? filtered[0] : filtered[index + direction]; if (target) selectSample(target); }
  $('random-sample').addEventListener('click', () => { const next = chooseRandomSample(filteredSamples(), selected.id); if (next) selectSample(next); });
  $('playback-speed').addEventListener('change', (event) => { speed = Number(event.target.value); cards.forEach((card) => { card.audio.playbackRate = speed; }); });
  $('favorite-toggle').addEventListener('click', () => { if (favorites.has(selected.id)) favorites.delete(selected.id); else favorites.add(selected.id); persist(); $('favorite-toggle').textContent = favorites.has(selected.id) ? '★' : '☆'; $('favorite-toggle').setAttribute('aria-pressed', String(favorites.has(selected.id))); $('favorite-toggle').setAttribute('aria-label', favorites.has(selected.id) ? 'Remove current sample from favorites' : 'Add current sample to favorites'); renderList(); });
  $('listening-note').addEventListener('input', (event) => { if (event.target.value) saved.notes[selected.id] = event.target.value; else delete saved.notes[selected.id]; persist(); });
  $('export-notes').addEventListener('click', () => {
    const annotations = samples.filter((sample) => favorites.has(sample.id) || saved.notes[sample.id]).map((sample) => ({ id: sample.id, text: sample.text || '', favorite: favorites.has(sample.id), note: saved.notes[sample.id] || '' }));
    if (!annotations.length) { toast('Add a favorite or a listening note before exporting.'); return; }
    const blob = new Blob([JSON.stringify({ collection: models.map((model) => model.name).join(' × '), exportedAt: new Date().toISOString(), annotations }, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'soundroom-listening-notes.json'; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast(`Exported annotations for ${annotations.length} ${annotations.length === 1 ? 'sample' : 'samples'}.`);
  });
  function selectAllModels() { visibleModels = new Set(modelIds); persistView(); renderComparison(); }
  $('models-all').addEventListener('click', selectAllModels);
  $('empty-models-all').addEventListener('click', selectAllModels);
  $('models-clear').addEventListener('click', () => { visibleModels.clear(); persistView(); renderComparison(); });
  $('comparison-reset').addEventListener('click', () => { ({ visibleModels, rankingMetric, rankingScope } = initialView(modelIds)); persistView(); renderComparison(); });
  $('ranking-metric').addEventListener('change', (event) => { rankingMetric = event.target.value; persistView(); renderComparison(); });
  $('ranking-scope').addEventListener('change', (event) => { rankingScope = event.target.value; persistView(); renderComparison(); });
  window.addEventListener('hashchange', () => {
    const view = readSharedView(location.href, samples, models);
    if (!view) return;
    ({ visibleModels, rankingMetric, rankingScope } = view);
    models.forEach((model) => { selectedRuns[model.id] = view.selectedRuns[model.id] || (model.runs.some((run) => run.id === model.defaultRun) ? model.defaultRun : model.runs[0].id); });
    query = ''; $('search').value = ''; setFilter(false); closePicker(); selectSample(view.sample);
  });
  createModelSelection();
  createPromptCard();
  models.forEach(createCard);
  selectSample(selected);
})();
