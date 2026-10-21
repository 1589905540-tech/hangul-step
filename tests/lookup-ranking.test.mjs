import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {rankChineseCandidates} from '../src/lookup-ranking.mjs';

const [dictionary, priority] = await Promise.all([
  readFile(new URL('../src/data/krdict-ko-zh-202609.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../src/data/krdict-lookup-priority.json', import.meta.url), 'utf8').then(JSON.parse),
]);

function actualCandidates(query) {
  return Object.entries(dictionary).flatMap(([korean, senses]) => senses
    .filter(chinese => new Set([chinese, ...chinese.split(/[，,、；;]/).map(value => value.trim())]).has(query))
    .map(chinese => ({korean, chinese})));
}

test('a primary learning sense outranks an exact Chinese gloss in a secondary sense', () => {
  const secondary = {korean:'날', chinese:'白天'};
  const primary = {korean:'낮', chinese:'白天，白日，日间'};
  const ranked = rankChineseCandidates([secondary, primary],
    {'날':['天，日', '白天'], '낮':['白天，白日，日间']},
    {'날':[[0, 1], [0, 2]], '낮':[[0, 1]]});
  assert.deepEqual(ranked, [primary, secondary]);
});

test('learning level precedes sense order across different entries', () => {
  const advancedFirst = {korean:'일간', chinese:'一天'};
  const beginnerLater = {korean:'하루', chinese:'一天'};
  assert.deepEqual(rankChineseCandidates([advancedFirst, beginnerLater],
    {'일간':['一天'], '하루':['某天', '一天']},
    {'일간':[[2, 1]], '하루':[[0, 2], [0, 3]]}), [beginnerLater, advancedFirst]);
});

test('a starter preference applies to one exact pair rather than every sense of its headword', () => {
  const otherSense = {korean:'차', chinese:'车'};
  const otherWord = {korean:'자동차', chinese:'车'};
  const starterPair = {korean:'차', chinese:'茶'};
  const candidates = [otherSense, otherWord, starterPair];
  const data = {'차':['茶', '车'], '자동차':['车']};
  const ranks = {'차':[[3, 2], [2, 1]], '자동차':[[0, 1]]};
  assert.deepEqual(rankChineseCandidates(candidates, data, ranks, starterPair),
    [starterPair, otherWord, otherSense]);
  assert.deepEqual(rankChineseCandidates(candidates, data, ranks),
    [otherWord, otherSense, starterPair]);
});

test('ties preserve input order, original objects and recording links without mutation', () => {
  const recording = Object.freeze({entryId:'example', url:'https://example.invalid/audio.wav'});
  const first = Object.freeze({korean:'기쁘다', chinese:'高兴', recording});
  const second = Object.freeze({korean:'기뻐하다', chinese:'高兴'});
  const candidates = Object.freeze([first, second]);
  const data = Object.freeze({'기쁘다':Object.freeze(['高兴']), '기뻐하다':Object.freeze(['高兴'])});
  const ranks = Object.freeze({'기쁘다':Object.freeze([Object.freeze([0, 1])]), '기뻐하다':Object.freeze([Object.freeze([0, 1])])});
  const ranked = rankChineseCandidates(candidates, data, ranks);
  assert.notEqual(ranked, candidates);
  assert.equal(ranked[0], first);
  assert.equal(ranked[1], second);
  assert.equal(ranked[0].recording, recording);
  assert.deepEqual(candidates, [first, second]);
  assert.equal(rankChineseCandidates([second, first], data, ranks)[0], second);
});

test('missing and invalid rank tuples fall back to compact sense order, with unknown pairs last', () => {
  const first = {korean:'첫말', chinese:'第一释义'};
  const later = {korean:'뒤말', chinese:'第二释义'};
  const unknown = {korean:'없는말', chinese:'没有收录的释义'};
  const data = {'첫말':['第一释义'], '뒤말':['其他释义', '第二释义']};
  const invalid = [undefined, null, {}, [0, 0], [4, 1], [-1, 1], ['0', 1], [0, '1'], [0.5, 1], [0, 1.5]];
  for (const tuple of invalid) {
    const ranks = {'첫말':[tuple], '뒤말':[[3, 1], tuple]};
    assert.deepEqual(rankChineseCandidates([unknown, later, first], data, ranks),
      [first, later, unknown], 'Invalid tuple: ' + JSON.stringify(tuple));
  }
  assert.deepEqual(rankChineseCandidates([unknown, later, first], data), [first, later, unknown]);
});

test('inherited headword data cannot supply a misleading rank', () => {
  const inherited = {korean:'상속말', chinese:'测试释义'};
  const own = {korean:'직접말', chinese:'测试释义'};
  const data = Object.assign(Object.create({'상속말':['测试释义']}), {'직접말':['测试释义']});
  const ranks = Object.assign(Object.create({'상속말':[[0, 1]]}), {'직접말':[[1, 1]]});
  assert.deepEqual(rankChineseCandidates([inherited, own], data, ranks), [own, inherited]);
});

test('a synonym match uses its full candidate gloss to find the original sense rank', () => {
  const exact = {korean:'낮', chinese:'下午'};
  const synonyms = {korean:'오후', chinese:'下午，午后'};
  assert.deepEqual(rankChineseCandidates([exact, synonyms],
    {'낮':['白天', '下午'], '오후':['下午，午后']},
    {'낮':[[0, 1], [0, 2]], '오후':[[0, 1]]}), [synonyms, exact]);
});

for (const [query, expected, retainedAlternative] of [
  ['白天', '낮', '날'],
  ['一天', '하루', '일간'],
  ['下午', '오후', '낮'],
  ['便宜', '싸다', '저렴하다'],
]) {
  test('official dictionary recommends ' + query + ' → ' + expected + ' and retains alternatives', () => {
    const candidates = actualCandidates(query);
    assert.ok(candidates.length > 1);
    for (const input of [candidates, [...candidates].reverse()]) {
      const ranked = rankChineseCandidates(input, dictionary, priority.entries);
      assert.equal(ranked[0].korean, expected);
      assert.equal(ranked.length, input.length);
      assert.ok(ranked.some(candidate => candidate.korean === retainedAlternative));
      assert.deepEqual(new Set(ranked), new Set(input), 'Ranking must preserve every candidate object');
    }
  });
}
