// Official learning levels and sense order guide a default, not usage frequency.
// Keep every valid pair: a short Chinese query cannot resolve every context.
export function rankChineseCandidates(candidates, dictionary = {}, priorityEntries = {}, starter) {
  return candidates.map((candidate, position) => {
    const senses = Object.hasOwn(dictionary, candidate.korean) && Array.isArray(dictionary[candidate.korean]) ? dictionary[candidate.korean] : [];
    const index = senses.indexOf(candidate.chinese);
    const values = Object.hasOwn(priorityEntries, candidate.korean) ? priorityEntries[candidate.korean]?.[index] : null;
    const valid = Array.isArray(values) && Number.isInteger(values[0]) && values[0] >= 0 && values[0] <= 3 && Number.isInteger(values[1]) && values[1] >= 1;
    const preferred = starter?.korean === candidate.korean && starter?.chinese === candidate.chinese;
    return {candidate, position, preferred, level:valid ? values[0] : 3, sense:valid ? values[1] : index >= 0 ? index + 1 : Number.MAX_SAFE_INTEGER};
  }).sort((left, right) => Number(right.preferred) - Number(left.preferred) || left.level - right.level || left.sense - right.sense || left.position - right.position).map(item => item.candidate);
}
