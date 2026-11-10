(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DemoMediaStore = api;
}(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const DETAIL_MEMORY_LIMIT = 100;
  const DETAIL_DISK_LIMIT = 150;
  const AUDIO_DISK_LIMIT = 64;
  const AUDIO_BYTE_LIMIT = 64 * 1024 * 1024;
  const SIZE_HEADER = 'x-demo-cache-bytes';
  const USED_HEADER = 'x-demo-cache-used';
  let lastCacheUse = 0;
  // Instances for the same demo share a cache-operation queue in this page.
  const cacheQueues = new Map();

  function create(options = {}) {
    const base = new URL(options.baseURL || '.', root.location?.href);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      throw new TypeError('The demo requires an HTTP(S) base URL.');
    }
    base.search = '';
    base.hash = '';
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const scope = 'tts-demo-media-v1:' + encodeURIComponent(base.href);
    const version = String(options.contentVersion || 'unversioned');
    const fetchFile = options.fetchFn || root.fetch?.bind(root);
    if (typeof fetchFile !== 'function') throw new TypeError('Fetch is unavailable.');
    let storage;
    try {
      storage = Object.prototype.hasOwnProperty.call(options, 'cacheStorage') ? options.cacheStorage : root.caches;
    } catch (_) { storage = null; }
    const details = new Map();
    const audioPending = new Map();
    const objectURLs = new Set();

    function assetURL(source) {
      if (typeof source !== 'string' || !source.trim()) throw new TypeError('A media path is required.');
      const url = new URL(source, base);
      const decoded = decodeURIComponent(url.pathname);
      const basePath = decodeURIComponent(base.pathname);
      if (url.origin !== base.origin || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          !url.pathname.startsWith(base.pathname) || !decoded.startsWith(basePath) ||
          decoded.includes('\\') || decoded.split('/').some((part) => part === '.' || part === '..')) {
        throw new TypeError('Media must be inside this demo directory.');
      }
      url.hash = '';
      return url;
    }

    function serialCache(kind, operation) {
      if (!storage || typeof storage.open !== 'function') return Promise.resolve(null);
      const name = scope + ':' + kind;
      const previous = cacheQueues.get(name) || Promise.resolve();
      const current = previous.then(async () => operation(await storage.open(name))).catch(() => null);
      const settled = current.then(() => undefined);
      cacheQueues.set(name, settled);
      settled.then(() => { if (cacheQueues.get(name) === settled) cacheQueues.delete(name); });
      return current;
    }

    async function prune(cache, kind) {
      const keys = await cache.keys();
      const limit = kind === 'audio' ? AUDIO_DISK_LIMIT : DETAIL_DISK_LIMIT;
      let bytes = 0;
      const entries = [];
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const response = await cache.match(key);
        let size = Number(response?.headers.get(SIZE_HEADER));
        if (!response || kind !== 'audio') size = 0;
        else if (!response.headers.has(SIZE_HEADER) || !Number.isFinite(size) || size < 0) size = (await response.blob()).size;
        const used = Number(response?.headers.get(USED_HEADER)) || 0;
        entries.push({ key, size, used, index });
        bytes += size;
      }
      entries.sort((a, b) => a.used - b.used || a.index - b.index);
      let remaining = keys.length;
      for (let index = 0; index < keys.length && (remaining > limit || bytes > AUDIO_BYTE_LIMIT); index += 1) {
        await cache.delete(entries[index].key);
        remaining -= 1;
        if (kind === 'audio') bytes -= entries[index].size;
      }
    }

    function validResponse(response) {
      return response && response.status === 200 && !response.headers.has('content-range');
    }

    async function readCached(kind, url, decode, signal) {
      if (!storage || typeof storage.open !== 'function') return null;
      // Reads bypass the maintenance queue. A slow write must not hold up Play.
      try {
        const cache = await storage.open(scope + ':' + kind);
        throwIfAborted(signal);
        const response = await cache.match(url);
        throwIfAborted(signal);
        if (!validResponse(response)) {
          if (response) void serialCache(kind, (target) => target.delete(url));
          return null;
        }
        let value;
        try { value = await decode(response.clone()); }
        catch (_) { void serialCache(kind, (target) => target.delete(url)); return null; }
        throwIfAborted(signal);
        // Replacing an entry atomically avoids a delete/reinsert cache-miss window.
        // Explicit recency metadata also survives a page reload.
        const headers = new Headers(response.headers);
        headers.set(USED_HEADER, String(lastCacheUse = Math.max(Date.now(), lastCacheUse + 1)));
        const refreshed = new Response(response.body, { status: 200, headers });
        void serialCache(kind, async (target) => { await target.put(url, refreshed); await prune(target, kind); });
        return { value, cacheSource: 'cache' };
      } catch (error) {
        throwIfAborted(signal);
        return null;
      }
    }

    async function saveCached(kind, url, blob, contentType) {
      if (kind === 'audio' && blob.size > AUDIO_BYTE_LIMIT) return;
      const used = String(lastCacheUse = Math.max(Date.now(), lastCacheUse + 1));
      await serialCache(kind, async (cache) => {
        const response = new Response(blob, { status: 200, headers: {
          'content-type': contentType || blob.type || 'application/octet-stream',
          [SIZE_HEADER]: String(blob.size), [USED_HEADER]: used
        } });
        await cache.put(url, response);
        await prune(cache, kind);
      });
    }

    function abortError() {
      if (typeof root.DOMException === 'function') return new root.DOMException('Audio loading was cancelled.', 'AbortError');
      const error = new Error('Audio loading was cancelled.'); error.name = 'AbortError'; return error;
    }

    function throwIfAborted(signal) { if (signal?.aborted) throw abortError(); }

    async function fetchFull(url, signal) {
      throwIfAborted(signal);
      const response = await fetchFile(url, { credentials: 'same-origin', redirect: 'error', ...(signal ? { signal } : {}) });
      throwIfAborted(signal);
      if (!validResponse(response)) throw new Error('Could not load the complete media file (HTTP ' + response?.status + ').');
      return response;
    }

    async function decodeSample(response, expectedId) {
      const value = await response.json();
      const isObject = (candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate);
      if (!isObject(value) || value.id !== expectedId || !isObject(value.tracks) ||
          (Object.prototype.hasOwnProperty.call(value, 'promptAudio') && !isObject(value.promptAudio))) {
        throw new Error('Invalid sample detail.');
      }
      return value;
    }

    async function decodeAudio(response) {
      const blob = await response.blob();
      if (!blob.size) throw new Error('The audio file is empty.');
      return blob;
    }

    async function fetchSample(url, expectedId) {
      const decode = (response) => decodeSample(response, expectedId);
      const cached = await readCached('details', url, decode);
      if (cached) return cached.value;
      const response = await fetchFull(url);
      // Consume and validate the complete body before writing it to Cache Storage.
      const blob = await response.blob();
      const value = await decode(new Response(blob));
      await saveCached('details', url, blob, 'application/json');
      return value;
    }

    function loadSample(entry) {
      let url;
      try {
        if (typeof entry?.id !== 'string' || !entry.id) throw new TypeError('A sample ID is required.');
        url = assetURL(entry.detail).href;
      }
      catch (error) { return Promise.reject(error); }
      const key = entry.id + '\u0000' + url;
      if (details.has(key)) {
        const existing = details.get(key);
        details.delete(key);
        details.set(key, existing);
        return existing;
      }
      const pending = fetchSample(url, entry.id).catch((error) => {
        if (details.get(key) === pending) details.delete(key);
        throw error;
      });
      details.set(key, pending);
      while (details.size > DETAIL_MEMORY_LIMIT) details.delete(details.keys().next().value);
      return pending;
    }

    async function fetchAudio(url, signal) {
      throwIfAborted(signal);
      const cached = await readCached('audio', url, decodeAudio, signal);
      throwIfAborted(signal);
      if (cached) return cached;
      const response = await fetchFull(url, signal);
      const blob = await decodeAudio(response);
      throwIfAborted(signal);
      void saveCached('audio', url, blob, response.headers.get('content-type'));
      return { value: blob, cacheSource: 'network' };
    }

    async function loadAudio(track, { signal } = {}) {
      throwIfAborted(signal);
      const source = assetURL(track?.src);
      const hash = track?.sha256;
      if (hash != null && !/^[a-f0-9]{64}$/i.test(hash)) throw new TypeError('Invalid audio SHA-256.');
      source.searchParams.set('v', hash ? hash.toLowerCase() : version);
      const url = source.href;
      let pending = audioPending.get(url);
      if (!pending) {
        pending = { controller: new root.AbortController(), consumers: new Set(), settled: false };
        audioPending.set(url, pending);
        const complete = () => {
          pending.settled = true;
          if (audioPending.get(url) === pending) audioPending.delete(url);
        };
        pending.promise = Promise.resolve().then(() => fetchAudio(url, pending.controller.signal));
        pending.promise.then(complete, complete);
      }
      return new Promise((resolve, reject) => {
        const consumer = {};
        let finished = false;
        pending.consumers.add(consumer);
        const leave = () => {
          signal?.removeEventListener('abort', cancel);
          pending.consumers.delete(consumer);
          if (!pending.settled && pending.consumers.size === 0) {
            if (audioPending.get(url) === pending) audioPending.delete(url);
            pending.controller.abort();
          }
        };
        const cancel = () => {
          if (finished) return;
          finished = true; leave(); reject(abortError());
        };
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        pending.promise.then((loaded) => {
          if (finished) return;
          if (signal?.aborted) { cancel(); return; }
          finished = true; leave();
          // Every active caller owns a distinct URL; cancelled callers get none.
          try {
            const objectURL = root.URL.createObjectURL(loaded.value);
            objectURLs.add(objectURL);
            resolve({ url: objectURL, cacheSource: loaded.cacheSource });
          } catch (error) { reject(error); }
        }, (error) => {
          if (finished) return;
          finished = true; leave(); reject(error);
        });
      });
    }

    function releaseAudio(url) {
      if (!objectURLs.delete(url)) return;
      root.URL.revokeObjectURL(url);
    }

    return { loadSample, loadAudio, releaseAudio };
  }

  return { create };
}));
