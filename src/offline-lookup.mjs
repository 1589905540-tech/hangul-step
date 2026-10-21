import {DICTIONARY} from './dictionary.mjs';
import {rankChineseCandidates} from './lookup-ranking.mjs';

const clean = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
const hasKorean = value => /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(value);
const hasChinese = value => /[\u3400-\u9fff]/.test(value);
const aliases = {'书本':'书','妈妈':'母亲','爸爸':'父亲','公交':'公交车','谢谢你':'谢谢','您好':'你好','对不起':'抱歉','朋友们':'朋友'};
const fail = (status, message) => {throw Object.assign(new Error(message), {status});};
const tokens = value => clean(value).split(/[，,、；;\/]/).map(part => part.replace(/[()（）]/g, '').trim()).filter(Boolean);
const dictionaryPath = '/krdict-ko-zh-202609.json';
const recordingsPath = '/krdict-pronunciation-links.json';
const priorityPath = '/krdict-lookup-priority.json';

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = candidate.korean + '\u0000' + candidate.chinese;
    if (seen.has(key) || candidate.korean.length > 100 || candidate.chinese.length > 120 || !hasKorean(candidate.korean) || !hasChinese(candidate.chinese) || /无对应词汇/.test(candidate.chinese)) return false;
    seen.add(key);
    return true;
  });
}

// Only public dictionary data is loaded here. Personal words are kept separately.
export function createOfflineLookup({fetcher = fetch, includeRecordings = true} = {}) {
  let dictionaryPromise = null, recordingsPromise = null, priorityPromise = null, reverseIndex = null;

  async function load(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(path, {credentials:'same-origin', signal:controller.signal});
      if (!response.ok) throw new Error('Dictionary asset unavailable');
      const value = await response.json();
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dictionary asset');
      return value;
    } finally {
      clearTimeout(timeout);
    }
  }

  function dictionary() {
    if (!dictionaryPromise) dictionaryPromise = load(dictionaryPath).catch(error => {dictionaryPromise = null; reverseIndex = null; throw error;});
    return dictionaryPromise;
  }

  function recordings() {
    if (!recordingsPromise) recordingsPromise = load(recordingsPath).catch(error => {recordingsPromise = null; throw error;});
    return recordingsPromise;
  }

  function priorities() {
    if (!priorityPromise) priorityPromise = load(priorityPath).then(value => {
      if (value.schemaVersion !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) throw new Error('Invalid lookup priority asset');
      return value.entries;
    }).catch(error => {priorityPromise = null; throw error;});
    return priorityPromise;
  }

  function chineseIndex(entries) {
    if (reverseIndex) return reverseIndex;
    reverseIndex = new Map();
    for (const [korean, senses] of Object.entries(entries)) {
      if (!hasKorean(korean) || !Array.isArray(senses)) continue;
      for (const chinese of senses) {
        if (typeof chinese !== 'string') continue;
        const variants = new Set([chinese, ...chinese.split(/[，,、；;]/)].map(clean).filter(Boolean));
        for (const variant of variants) {
          if (!reverseIndex.has(variant)) reverseIndex.set(variant, []);
          reverseIndex.get(variant).push({korean, chinese, source:'国立国语院 · 韩汉词典'});
        }
      }
    }
    return reverseIndex;
  }

  async function recording(korean, chinese) {
    // The device edition speaks locally and never needs the large URL index.
    if (!includeRecordings) return null;
    let entries;
    try {entries = await recordings();} catch {return null;}
    const key = clean(korean);
    const candidates = Object.hasOwn(entries, key) && Array.isArray(entries[key]) ? entries[key].filter(candidate => candidate && Array.isArray(candidate.chineseSenses) && typeof candidate.pronunciation === 'string' && typeof candidate.url === 'string' && /^https:\/\/dicmedia\.korean\.go\.kr\/multimedia\//.test(candidate.url)) : [];
    if (!candidates.length) return null;
    const meaning = clean(chinese), parts = tokens(meaning);
    const ranked = candidates.map(candidate => ({candidate, score:Math.max(0, ...candidate.chineseSenses.filter(sense => typeof sense === 'string').map(sense => {
      if (meaning === sense) return 100;
      return Math.max(0, ...tokens(sense).map(part => parts.includes(part) ? 60 : meaning && part.length >= 1 && (meaning.includes(part) || part.includes(meaning)) ? part.length : 0));
    }))})).sort((left, right) => right.score - left.score);
    const tied = ranked.filter(item => item.score === ranked[0].score);
    if (new Set(tied.map(item => item.candidate.pronunciation)).size > 1) return null;
    const selected = ranked[0].candidate;
    return {url:selected.url, pronunciation:selected.pronunciation, entryId:selected.entryId, source:'韩国国立国语院 · 原站发音录音'};
  }

  async function lookup(input) {
    if (typeof input !== 'string') fail(400, '请输入韩文或中文。');
    const text = clean(input);
    if (!text || text.length > 80 || new TextEncoder().encode(text).length > 500) fail(400, '请输入 80 字以内的单词或短语。');
    const ko = hasKorean(text), zh = hasChinese(text);
    if (ko === zh) fail(400, '请每次输入一种语言：一个韩文词，或一个中文意思。');
    const query = aliases[text] || text;
    const match = DICTIONARY.find(word => ko ? word.korean === text : word.chinese === query);
    let available = [], loaded = false, entries = {};
    try {
      entries = await dictionary();
      loaded = true;
      const senses = Object.hasOwn(entries, text) && Array.isArray(entries[text]) ? entries[text] : [];
      available = ko ? senses.filter(sense => typeof sense === 'string').map(chinese => ({korean:text, chinese, source:'国立国语院 · 韩汉词典'})) : chineseIndex(entries).get(query) || [];
    } catch { /* Keep the small dictionary usable and retry the public asset next time. */ }
    let all = uniqueCandidates([...(match ? [{korean:match.korean, chinese:match.chinese, source:'常用词释义'}] : []), ...available]);
    if (!all.length) {
      if (!loaded) fail(503, '词典尚未准备好，请联网后再试，或手动填写。');
      fail(422, '词典暂未收录，可以手动填写韩文和中文。');
    }
    if (!ko) {
      let priorityEntries = {};
      if (loaded) try {priorityEntries = await priorities();} catch { /* Missing optional ranking data must not disable lookup. */ }
      all = rankChineseCandidates(all, entries, priorityEntries, match);
    }
    const selected = ko ? all : all.slice(0, 40);
    const candidates = await Promise.all(selected.map(async candidate => ({...candidate, recording:await recording(candidate.korean, candidate.chinese)})));
    return {...candidates[0], ...(candidates.length > 1 ? {candidates} : {}), ...(all.length > candidates.length ? {totalCandidates:all.length} : {})};
  }

  async function meanings(korean) {
    const key = clean(korean);
    let senses = [];
    try {const entries = await dictionary(); if (Object.hasOwn(entries, key) && Array.isArray(entries[key])) senses = entries[key].filter(value => typeof value === 'string' && hasChinese(value)).map(clean);}
    catch {return null; /* Do not cache a failed read as a permanently missing dictionary entry. */ }
    const starter = DICTIONARY.find(word => clean(word.korean) === key)?.chinese;
    return [...new Set([...(starter ? [starter] : []), ...senses])];
  }
  return {lookup, recording, meanings};
}
