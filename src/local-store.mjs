import {normalizeLearningCode, createEmptySpace, projectSnapshot, emptyReviewProgress, SYNC_LIMITS} from '../sync/protocol.mjs';

const DATABASE_NAME = 'spring-local-v1';
const DOCUMENTS = 'documents';
const META = 'meta';
const clone = value => value === undefined ? undefined : structuredClone(value);
const keyFor = code => 'space:' + code;
const normalizedText = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORD_FIELDS = ['id', 'korean', 'chinese', 'generation', 'createdAt', 'masteryKo', 'masteryZh', 'mistakes', 'lastPracticedAt', 'reviewDays', 'reviewProgress'];
const protocolWord = word => Object.fromEntries(WORD_FIELDS.filter(field => word[field] !== undefined).map(field => [field, clone(word[field])]));

export class LocalStoreError extends Error {
  constructor(message, cause, {status, code} = {}) {
    super(message, cause ? {cause} : undefined); this.name = 'LocalStoreError';
    if (status !== undefined) this.status = status;
    if (code !== undefined) this.code = code;
  }
}
const recordError = (message, status, code) => new LocalStoreError(message, undefined, {status, code});

function storageError(error) {
  if (error instanceof LocalStoreError || error?.name === 'SyncProtocolError') return error;
  return new LocalStoreError(error?.name === 'QuotaExceededError' ? '设备存储空间不足，本次修改尚未保存。' : '无法保存到此设备，请检查浏览器的存储权限。', error);
}

function endpointValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) throw new LocalStoreError('同步地址格式不正确。');
  const endpoint = value.trim();
  if (/^\/(?!\/)[^\s]*$/.test(endpoint)) return endpoint;
  let parsed;
  try {parsed = new URL(endpoint);} catch {throw new LocalStoreError('同步地址格式不正确。');}
  if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)))) throw new LocalStoreError('同步地址需要使用 HTTPS。');
  return parsed.href;
}

function progressFor(word) {
  if (word.reviewProgress) return clone(word.reviewProgress);
  const progress = emptyReviewProgress();
  if (word.masteryKo && word.masteryZh) {
    progress.cleanRounds = Math.max(1, [1, 3, 7, 14].indexOf(word.reviewDays) + 1);
    progress.advancedAt = word.lastPracticedAt ?? null;
  }
  return progress;
}

function enrichedSnapshot(snapshot, previousWords) {
  const previous = new Map(previousWords.map(word => [word.id, word]));
  return {...clone(snapshot), words:snapshot.words.map(word => {
    const earlier = previous.get(word.id);
    const sameMeaning = earlier?.korean === word.korean && earlier?.chinese === word.chinese;
    return sameMeaning ? {...clone(earlier), ...clone(word)} : clone(word);
  })};
}

/** Device data commits before callers can advance a question. No network access. */
export function createLocalStore({indexedDB = globalThis.indexedDB, makeId = () => globalThis.crypto.randomUUID(), now = Date.now} = {}) {
  let databasePromise;

  function id() {
    const value = makeId();
    if (typeof value !== 'string' || !UUID.test(value)) throw new LocalStoreError('无法创建安全的设备标识。');
    return value.toLowerCase();
  }

  function open() {
    if (!indexedDB?.open) return Promise.reject(new LocalStoreError('此浏览器不支持保存学习数据。'));
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      let request;
      try {request = indexedDB.open(DATABASE_NAME, 1);} catch (error) {reject(storageError(error)); return;}
      request.onupgradeneeded = () => {if (!request.result.objectStoreNames.contains(DOCUMENTS)) request.result.createObjectStore(DOCUMENTS);};
      request.onerror = () => reject(storageError(request.error));
      request.onblocked = () => reject(new LocalStoreError('请关闭旧版本的春页面，再重新打开。'));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {database.close(); databasePromise = undefined;};
        resolve(database);
      };
    }).catch(error => {databasePromise = undefined; throw error;});
    return databasePromise;
  }

  async function transaction(mode, callback) {
    const database = await open();
    return new Promise((resolve, reject) => {
      let tx, result, failed;
      try {tx = database.transaction(DOCUMENTS, mode);} catch (error) {reject(storageError(error)); return;}
      const store = tx.objectStore(DOCUMENTS);
      const request = operation => new Promise((done, fail) => {
        let job;
        try {job = operation();} catch (error) {fail(error); return;}
        job.onsuccess = () => done(job.result);
        job.onerror = () => fail(job.error);
      });
      tx.oncomplete = () => failed ? reject(storageError(failed)) : resolve(result);
      tx.onabort = () => reject(storageError(failed || tx.error || new Error('transaction aborted')));
      tx.onerror = () => {failed ||= tx.error;};
      Promise.resolve().then(() => callback({get:key => request(() => store.get(key)), put:(key, value) => request(() => store.put(clone(value), key))})).then(value => {result = value;}, error => {
        failed = error;
        try {tx.abort();} catch {reject(storageError(error));}
      });
    });
  }

  function emptyDocument(code, spaceId = 'local:' + code.slice(3), allowCloudCreate = true) {
    return {code, snapshot:createEmptySpace(spaceId, now()), pending:[], nextSeq:1, endpoint:null, lastSyncedAt:null, remoteSpaceId:null, allowCloudCreate, conflicts:[], answerReceipts:[], wordMetadata:{}, everCloudConfigured:false};
  }

  function projected(document, clientId, rejectFromSeq) {
    const projection = projectSnapshot(document.snapshot, document.pending, {code:document.code, clientId, now:now()});
    const rejected = rejectFromSeq === undefined ? null : projection.conflicts?.find(conflict => conflict.seq >= rejectFromSeq);
    if (rejected) throw new LocalStoreError(rejected.reason === 'word-limit' ? '词库最多可保存 ' + SYNC_LIMITS.words + ' 个生词，本次修改尚未保存。' : '本次修改与现有词库不一致，尚未保存。');
    const words = Array.isArray(projection) ? projection : projection.words;
    if (!Array.isArray(words)) throw new LocalStoreError('无法读取本地词库，请保留此设备上的数据。');
    return {
      code:document.code, spaceId:document.remoteSpaceId || document.snapshot.spaceId,
      words:words.map(word => {
        const metadata = document.wordMetadata?.[word.id];
        return metadata?.generation === word.generation && metadata.korean === word.korean && metadata.chinese === word.chinese ? {...clone(metadata), ...clone(word)} : clone(word);
      }), pending:clone(document.pending), cloudConfigured:Boolean(document.endpoint),
      cloudCreated:Boolean(document.remoteSpaceId), lastSyncedAt:document.lastSyncedAt,
      conflicts:clone(document.conflicts), clientId, revision:document.snapshot.revision,
    };
  }

  async function active(store, requestedCode) {
    const meta = await store.get(META);
    if (!meta) throw new LocalStoreError('请先打开本地词库。');
    const code = requestedCode ? normalizeLearningCode(requestedCode) : meta.activeCode;
    const document = await store.get(keyFor(code));
    if (!document) throw new LocalStoreError('此设备还没有这个词库，请先联网恢复。');
    return {meta, document};
  }

  function append(document, meta, type, payload, operationId) {
    if (!Number.isSafeInteger(document.nextSeq) || document.nextSeq < 1 || document.nextSeq === Number.MAX_SAFE_INTEGER) throw new LocalStoreError('本地记录序号已满，请先导出备份。');
    const operation = {id:operationId || id(), clientId:meta.clientId, seq:document.nextSeq++, createdAt:now(), type, payload:clone(payload)};
    document.pending.push(operation);
    return operation;
  }

  async function mutate(callback) {
    return transaction('readwrite', async store => {
      const {meta, document} = await active(store);
      const previousSeq = document.nextSeq;
      await callback(document, meta);
      projected(document, meta.clientId, previousSeq);
      compactLocal(document, meta);
      const state = projected(document, meta.clientId);
      await store.put(keyFor(document.code), document);
      return state;
    });
  }

  function compactLocal(document, meta) {
    if (document.endpoint || document.everCloudConfigured || document.remoteSpaceId || document.pending.length <= 200) return;
    const snapshot = projectSnapshot(document.snapshot, document.pending, {code:document.code, clientId:meta.clientId, now:now()});
    const tombstones = clone(document.snapshot.tombstones || {});
    for (const operation of document.pending) {
      if (operation.type === 'word-delete') tombstones[operation.payload.wordId] = {generation:operation.payload.generation, deletedAt:operation.createdAt};
    }
    document.snapshot = {...snapshot, tombstones};
    document.pending = [];
    document.localCompacted = true;
  }

  async function initialize() {
    return transaction('readwrite', async store => {
      let meta = await store.get(META), newlyCreated = false;
      if (!meta) {
        const code = normalizeLearningCode('SC-' + id());
        meta = {schemaVersion:1, activeCode:code, clientId:id()};
        await store.put(keyFor(code), emptyDocument(code));
        await store.put(META, meta);
        newlyCreated = true;
      }
      const document = await store.get(keyFor(meta.activeCode));
      if (!document) throw new LocalStoreError('本地词库记录不完整，请保留数据并联系支持。');
      return {...projected(document, meta.clientId), newlyCreated, isNew:newlyCreated};
    });
  }

  async function read() {return transaction('readonly', async store => {const {meta, document} = await active(store); return projected(document, meta.clientId);});}

  async function setSpace(value, {snapshot, allowCreate = false} = {}) {
    const code = normalizeLearningCode(value);
    return transaction('readwrite', async store => {
      const {meta, document:previous} = await active(store);
      let document = await store.get(keyFor(code));
      if (!document && !snapshot && !allowCreate) throw new LocalStoreError('此设备还没有这个词库，请先联网恢复。');
      if (!document) {
        document = emptyDocument(code, snapshot?.spaceId, allowCreate);
        document.endpoint = previous.endpoint;
      }
      if (snapshot) updateFromRemote(document, meta, snapshot);
      meta.activeCode = code;
      const state = projected(document, meta.clientId);
      await store.put(keyFor(code), document);
      await store.put(META, meta);
      return state;
    });
  }

  async function importLegacy({code:value, spaceId, words}) {
    const code = normalizeLearningCode(value);
    if (!Array.isArray(words)) throw new LocalStoreError('旧词库内容无法读取。');
    return transaction('readwrite', async store => {
      const {meta, document:previous} = await active(store);
      const existing = await store.get(keyFor(code));
      if (existing && (existing.pending.length || existing.snapshot.words.length)) {
        meta.activeCode = code;
        await store.put(META, meta);
        return projected(existing, meta.clientId);
      }
      const document = existing || emptyDocument(code, spaceId || 'local:' + code.slice(3));
      document.endpoint = previous.endpoint;
      const imported = words.map(word => ({...clone(word), generation:UUID.test(word.generation || '') ? word.generation.toLowerCase() : id(), reviewProgress:progressFor(word)}));
      document.wordMetadata ||= {};
      for (const word of imported) document.wordMetadata[word.id] = clone(word);
      if (imported.length) append(document, meta, 'space-import', {words:imported.map(protocolWord)});
      meta.activeCode = code;
      const state = projected(document, meta.clientId, 1);
      await store.put(keyFor(code), document);
      await store.put(META, meta);
      return state;
    });
  }

  async function configureCloud(endpoint) {
    const value = endpointValue(endpoint);
    return mutate((document, meta) => {
      if (value && !document.everCloudConfigured && !document.remoteSpaceId) {
        // Local compaction acknowledges device operations. A new cloud starts at seq 1,
        // so its first operation seeds the complete current vocabulary and progress.
        const words = projected(document, meta.clientId).words;
        document.snapshot = createEmptySpace(document.snapshot.spaceId, now());
        document.pending = []; document.nextSeq = 1;
        if (words.length) append(document, meta, 'space-import', {words:words.map(protocolWord)});
        document.everCloudConfigured = true;
        document.localCompacted = false;
      }
      document.endpoint = value;
    });
  }
  async function cloudEndpoint() {return transaction('readonly', async store => (await active(store)).document.endpoint);}

  async function putWord(pair, wordId) {
    return mutate((document, meta) => {
      const words = projected(document, meta.clientId).words;
      const korean = normalizedText(pair?.korean), chinese = normalizedText(pair?.chinese);
      if (!korean || !chinese) throw new LocalStoreError('请填写韩文和中文释义。');
      const old = wordId ? words.find(word => word.id === wordId) : null;
      if (wordId && !old) throw recordError('这条生词已经被删除。', 404, 'WORD_DELETED');
      if (old && pair.generation !== undefined && pair.generation !== old.generation) throw recordError('这个词的释义已经修改，请重新打开编辑。', 409, 'WORD_CHANGED');
      if (old?.korean === korean && old.chinese === chinese) return;
      if (words.some(word => word.id !== wordId && word.korean === korean)) throw new LocalStoreError('词库里已经有这个韩文。');
      const word = {id:old?.id || id(), korean, chinese, generation:id(), createdAt:old?.createdAt ?? now()};
      if (pair.recording) word.recording = clone(pair.recording);
      document.wordMetadata ||= {};
      document.wordMetadata[word.id] = clone(word);
      append(document, meta, 'word-put', {word, baseGeneration:old?.generation ?? null});
    });
  }

  async function deleteWord(wordId) {
    return mutate((document, meta) => {
      const word = projected(document, meta.clientId).words.find(item => item.id === wordId);
      if (!word) return;
      append(document, meta, 'word-delete', {wordId, generation:word.generation});
    });
  }

  async function answer(payload) {
    return mutate((document, meta) => {
      if (!payload || typeof payload.id !== 'string') throw new LocalStoreError('答题记录不完整。');
      const receipt = document.answerReceipts.find(item => item.id === payload.id);
      const word = projected(document, meta.clientId).words.find(item => item.id === payload.wordId);
      const generation = payload.generation || receipt?.generation || word?.generation;
      const fingerprint = JSON.stringify([payload.wordId, generation, payload.direction, payload.correct, payload.retry, ...(payload.rating!==undefined||payload.phase!==undefined||payload.correction!==undefined?[payload.rating??null,payload.phase??null,payload.correction??null]:[])]);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) throw recordError('这条答题记录与已保存的内容不同。', 409, 'ANSWER_CONFLICT');
        return;
      }
      if (!word) throw recordError('这条生词已经被删除。', 404, 'WORD_DELETED');
      if (generation !== word.generation) throw recordError('这个词的释义已经修改，请重新练习。', 409, 'WORD_CHANGED');
      append(document, meta, 'answer', {...payload, generation}, payload.id);
      document.answerReceipts.push({id:payload.id, generation, fingerprint});
      document.answerReceipts = document.answerReceipts.slice(-2000);
    });
  }

  function updateFromRemote(document, meta, response) {
    if (!response || response.schemaVersion !== 1 || typeof response.spaceId !== 'string' || !Number.isSafeInteger(response.revision) || response.revision < 0 || !Array.isArray(response.words) || !response.acks || typeof response.acks !== 'object' || !Array.isArray(response.conflicts)) throw new LocalStoreError('同步服务器返回了无法读取的词库，本地记录已保留。');
    if (document.remoteSpaceId && response.spaceId !== document.remoteSpaceId) throw new LocalStoreError('同步结果属于另一份词库，本地记录已保留。');
    const ack = response.acks[meta.clientId] ?? 0;
    if (!Number.isSafeInteger(ack) || ack < 0 || ack >= document.nextSeq) throw new LocalStoreError('同步确认序号不正确，本地记录已保留。');
    // Responses from concurrent tabs can arrive out of order; an old snapshot must not roll back data.
    if (document.remoteSpaceId && response.revision < document.snapshot.revision) return;
    const oldWords = projected(document, meta.clientId).words;
    for (const conflict of response.conflicts) {
      if (!conflict || typeof conflict.id !== 'string') throw new LocalStoreError('同步冲突记录无法读取，本地记录已保留。');
      const operation = document.pending.find(item => item.id === conflict.id && item.seq === conflict.seq);
      if (!document.conflicts.some(item => item.id === conflict.id && item.seq === conflict.seq)) document.conflicts.push({...clone(conflict), localOperation:clone(operation)});
    }
    document.pending = document.pending.filter(operation => operation.seq > ack);
    document.snapshot = enrichedSnapshot(response, oldWords);
    document.remoteSpaceId = response.spaceId;
    document.lastSyncedAt = now();
    document.allowCloudCreate = false;
  }

  async function applyRemote(response, {code} = {}) {
    return transaction('readwrite', async store => {
      const {meta, document} = await active(store, code);
      updateFromRemote(document, meta, response);
      const state = projected(document, meta.clientId);
      await store.put(keyFor(document.code), document);
      return state;
    });
  }

  async function pendingBatch(limit = SYNC_LIMITS.operations) {
    if (!Number.isInteger(limit) || limit < 1 || limit > SYNC_LIMITS.operations) throw new LocalStoreError('同步批次大小不正确。');
    return transaction('readonly', async store => {
      const {meta, document} = await active(store);
      return {code:document.code, clientId:meta.clientId, operations:clone(document.pending.slice(0, limit)), create:document.allowCloudCreate};
    });
  }

  async function exportBackup() {const state = await read(); return {schemaVersion:1, version:1, code:state.code, exportedAt:now(), words:state.words, conflicts:state.conflicts};}
  async function importBackup(backup) {
    if (!backup || (backup.schemaVersion ?? backup.version) !== 1 || !Array.isArray(backup.words) || backup.words.length > SYNC_LIMITS.words) throw new LocalStoreError('这份备份无法读取，请选择春导出的 JSON 文件。');
    return transaction('readwrite', async store => {
      const {meta, document} = await active(store);
      const current = projected(document, meta.clientId), known = new Set(current.words.map(word => word.korean));
      const previousSeq = document.nextSeq;
      let added = 0, skipped = 0;
      document.wordMetadata ||= {};
      for (const source of backup.words) {
        if (!source || typeof source.korean !== 'string' || typeof source.chinese !== 'string') throw new LocalStoreError('备份里的生词记录不完整，本次导入尚未保存。');
        const korean = normalizedText(source.korean), chinese = normalizedText(source.chinese);
        if (known.has(korean)) {skipped++; continue;}
        const word = {id:id(), korean, chinese, generation:id(), createdAt:source.createdAt ?? now()};
        const fields = ['masteryKo', 'masteryZh', 'mistakes', 'lastPracticedAt', 'reviewDays', 'reviewProgress'];
        const importedProgress = Object.fromEntries(fields.map(field => [field, clone(source[field])]));
        // The shared protocol validates all imported progress before this transaction commits.
        append(document, meta, 'word-put', {word, baseGeneration:null, importedProgress});
        document.wordMetadata[word.id] = {...clone(source), ...word};
        known.add(korean); added++;
      }
      projected(document, meta.clientId, previousSeq);
      compactLocal(document, meta);
      const state = projected(document, meta.clientId);
      await store.put(keyFor(document.code), document);
      return {...state, added, skipped};
    });
  }
  async function close() {if (databasePromise) {const database = await databasePromise; database.close(); databasePromise = undefined;}}
  return {initialize, read, setSpace, importLegacy, configureCloud, cloudEndpoint, putWord, deleteWord, answer, applyRemote, pendingBatch, exportBackup, importBackup, close};
}
