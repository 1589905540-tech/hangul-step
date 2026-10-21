export const GROUP_SIZE = 10;
export const normalize = (value) => String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
export const meaningParts = (value) => normalize(value).replace(/[（(][^）)]*[）)]/g, '').split(/[、，,;；/]/).map(normalize).filter(Boolean);
export function shuffle(items, rng = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
export function groupsOf(words) {
  const groups = [];
  for (let i = 0; i < words.length; i += GROUP_SIZE) groups.push(words.slice(i, i + GROUP_SIZE));
  return groups;
}
export function overlaps(a, b) {
  const meanings = word => [word.chinese, ...(word.acceptedMeanings || [])].flatMap(meaningParts);
  return normalize(a.korean) === normalize(b.korean) || meanings(a).some(p => meanings(b).includes(p));
}
function spellingSimilarity(a, b) {
  const left = Array.from(normalize(a).normalize('NFD'));
  const right = Array.from(normalize(b).normalize('NFD'));
  if (!left.length || !right.length) return 0;
  let row = Array.from({length:right.length + 1}, (_, i) => i);
  for (let i = 0; i < left.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < right.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(left[i] !== right[j])));
    row = next;
  }
  return 1 - row[right.length] / Math.max(left.length, right.length);
}
function categoriesFor(word, defaults) {
  // Personal meanings take precedence: 사과 meaning “道歉” is not a fruit.
  return word.categories || defaults.find(item => normalize(item.korean) === normalize(word.korean) && meaningParts(item.chinese).some(p => meaningParts(word.chinese).includes(p)))?.categories || [];
}
export function makeOptions(target, direction, ownWords, defaults, rng = Math.random, previous = []) {
  const field = direction === 'ko' ? 'korean' : 'chinese';
  const candidates = new Map();
  for (const item of [...ownWords, ...defaults]) {
    const key = normalize(item.korean);
    if (key && item.chinese && !candidates.has(key)) candidates.set(key, item);
  }
  const pool = [...candidates.values()].filter(item => !overlaps(item, target));
  const targetCategories = categoriesFor(target, defaults);
  const related = pool.map(word => {
    const sameCategory = categoriesFor(word, defaults).some(tag => targetCategories.includes(tag));
    const resemblance = Math.max(spellingSimilarity(target.korean, word.korean), spellingSimilarity(target.chinese, word.chinese));
    const weight = (sameCategory ? 3 : 0) + (resemblance >= 0.55 ? resemblance : 0);
    return {word, weight, draw:weight ? -Math.log(Math.max(Number.EPSILON, 1 - rng())) / weight : Infinity};
  }).filter(item => item.weight).sort((a, b) => a.draw - b.draw).map(item => item.word);
  const picked = [target];
  const canPick = (candidate, others = picked) => !others.some(item => overlaps(candidate, item) || normalize(item[field]) === normalize(candidate[field]));
  // Two related distractors when available; the remaining one comes from the full pool.
  for (const candidate of related) {
    if (canPick(candidate)) picked.push(candidate);
    if (picked.length === 3) break;
  }
  for (const candidate of shuffle(pool, rng)) {
    if (picked.length === 4) break;
    if (canPick(candidate)) picked.push(candidate);
  }
  if (picked.length !== 4) throw new Error('可用词义不足，暂时无法组成四个不同选项。请修改过长或重复的释义。');
  const signature = labels => JSON.stringify(labels.map(normalize).sort());
  if (signature(picked.map(word => word[field])) === signature(previous.map(option => option.label))) {
    // Finite fallback also works with a tiny pool or a deterministic random source.
    const alternatives = shuffle(pool, rng);
    for (let i = picked.length - 1; i > 0; i--) {
      const replacement = alternatives.find(word => !picked.some(item => normalize(item[field]) === normalize(word[field])) && canPick(word, picked.filter((_, index) => index !== i)));
      if (replacement) { picked[i] = replacement; break; }
    }
  }
  const options = shuffle(picked.map((word, i) => ({id:word.id, label:word[field], correct:i === 0})), rng);
  const previousPosition = previous.findIndex(option => option.correct);
  const position = options.findIndex(option => option.correct);
  if (previousPosition >= 0 && position === previousPosition) {
    const otherPositions = [0,1,2,3].filter(i => i !== position);
    const next = otherPositions[Math.floor(rng() * otherPositions.length)];
    [options[position], options[next]] = [options[next], options[position]];
  }
  return options;
}
export function makeSession(words, mode = 'both', rng = Math.random) {
  const directions = mode === 'both' ? ['ko', 'zh'] : [mode];
  return { queue: directions.flatMap(direction => shuffle(words, rng).map(word => ({ word, direction, retry: false }))), index: 0, firstTotal: words.length * directions.length, correct: 0, retriesCorrect: 0, answered: 0, outcomes: {}, startedAt: Date.now() };
}
export function recordAnswer(session, correct, {rating = correct ? 'good' : 'again', correction = false} = {}) {
  const question = session.queue[session.index];
  if (!question) throw new Error('本次练习已经结束。');
  const key = question.word.id + ':' + question.direction;
  const wasCorrect = question.result;
  session.outcomes[key] = correct;
  session.ratings ||= {}; session.ratings[key] = rating;
  if (correction) {
    if (wasCorrect && !correct) {if (question.retry) session.retriesCorrect--; else session.correct--;}
  }
  else if (question.retry) { if (correct) session.retriesCorrect++; }
  else {
    session.answered++;
    if (correct) session.correct++;
  }
  question.result = correct; question.rating = rating;
  // At most two short-term repetitions per word and direction, including hard answers.
  session.repeatCounts ||= {};
  if (rating !== 'good' && !question.repetitionQueued && (session.repeatCounts[key] || 0) < 2) {
    question.repetitionQueued = true; session.repeatCounts[key] = (session.repeatCounts[key] || 0) + 1;
    session.queue.splice(Math.min(session.index + 4, session.queue.length), 0, {word:question.word, direction:question.direction, retry:true});
  }
}
export function advance(session) { session.index++; return session.index < session.queue.length; }
export function pendingWords(session) {
  return [...new Map(session.queue.filter(q => session.outcomes[q.word.id + ':' + q.direction] === false || session.ratings?.[q.word.id + ':' + q.direction] === 'hard').map(q => [q.word.id, q.word])).values()];
}
