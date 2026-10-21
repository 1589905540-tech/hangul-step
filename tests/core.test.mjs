import test from 'node:test';
import assert from 'node:assert/strict';
import {groupsOf,makeOptions,makeSession,recordAnswer,advance,pendingWords,normalize,overlaps} from '../src/core.mjs';
import {DICTIONARY} from '../src/dictionary.mjs';
test('groups contain at most ten real target words, including the remainder',()=>{
  for(const count of [0,1,2,3,10,11,21]){
    const groups=groupsOf(DICTIONARY.slice(0,count));assert.equal(groups.flat().length,count);assert.ok(groups.every(g=>g.length<=10));assert.equal(groups.length,Math.ceil(count/10));
  }
});
test('one to ten vocabulary words still yield exactly four unambiguous choices in both directions',()=>{
  for(const count of [1,2,3,10])for(const word of DICTIONARY.slice(0,count))for(const direction of ['ko','zh']){
    const options=makeOptions(word,direction,DICTIONARY.slice(0,count),DICTIONARY);
    assert.equal(options.length,4);assert.equal(options.filter(o=>o.correct).length,1);assert.equal(new Set(options.map(o=>o.label)).size,4);assert.equal(options.find(o=>o.correct).id,word.id);
  }
});
test('matching Chinese synonyms and Korean Unicode variants do not become distractors',()=>{
  assert.equal(normalize('  친구  '),'친구');assert.equal(normalize('친구'.normalize('NFD')),'친구');
  assert.equal(overlaps({korean:'사과',chinese:'苹果'},{korean:'애플',chinese:'苹果（水果）'}),true);
  assert.equal(overlaps({korean:'미안하다',chinese:'抱歉、对不起'},{korean:'죄송하다',chinese:'对不起'}),true);
  const target={id:'target',korean:'사과',chinese:'苹果'};
  const opts=makeOptions(target,'zh',[{id:'ambiguous',korean:'애플',chinese:'苹果（水果）'},{id:'same-ko',korean:'사과',chinese:'道歉'}],DICTIONARY);
  assert.ok(opts.every(o=>!['ambiguous','same-ko'].includes(o.id)));
});
function seeded(seed=71){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
const optionSet=options=>JSON.stringify(options.map(o=>o.label).sort());
test('repeated practice changes distractor sets and positions, including a fixed random source',()=>{
  const target=DICTIONARY[0];
  for(const direction of ['ko','zh']) {
    const rng=seeded();let previous=[];const positions=new Set(),sets=new Set();
    for(let i=0;i<120;i++) {
      const options=makeOptions(target,direction,DICTIONARY.slice(0,10),DICTIONARY,rng,previous);
      if(previous.length){assert.notEqual(optionSet(options),optionSet(previous));assert.notEqual(options.findIndex(o=>o.correct),previous.findIndex(o=>o.correct));}
      assert.equal(options.filter(o=>o.correct).length,1);assert.equal(new Set(options.map(o=>o.label)).size,4);
      sets.add(optionSet(options));positions.add(options.findIndex(o=>o.correct));previous=options;
    }
    assert.equal(positions.size,4);assert.ok(sets.size>30);
    const first=makeOptions(target,direction,[],DICTIONARY,()=>0);
    const second=makeOptions(target,direction,[],DICTIONARY,()=>0,first);
    assert.notEqual(optionSet(first),optionSet(second));
    const tiny=DICTIONARY.slice(0,4);const a=makeOptions(target,direction,[],tiny,()=>0);const b=makeOptions(target,direction,[],tiny,()=>0,a);
    assert.equal(optionSet(a),optionSet(b));assert.notEqual(b.findIndex(o=>o.correct),a.findIndex(o=>o.correct));
  }
});
test('related choices are preferred without duplication or replacing personal meanings',()=>{
  const target={...DICTIONARY[0],id:'personal-apple'};
  for(const direction of ['ko','zh']) {
    const options=makeOptions(target,direction,[target],DICTIONARY,()=>0.5);
    const fruits=DICTIONARY.filter(w=>w.categories.includes(0));
    assert.ok(options.filter(o=>!o.correct&&fruits.some(w=>w.id===o.id)).length>=2);
    const single=makeOptions(target,direction,[...DICTIONARY.slice(0,10)],DICTIONARY,seeded());
    const duplicate=makeOptions(target,direction,[...DICTIONARY.slice(0,10),...DICTIONARY.slice(0,10)],DICTIONARY,seeded());
    assert.deepEqual(duplicate,single);
  }
  const custom={id:'mine',korean:'가게',chinese:'小卖部'};
  const own=makeOptions(target,'zh',[custom],DICTIONARY,()=>0);
  assert.ok(!own.some(o=>o.label==='商店'));
});
test('a wrong first answer reappears after three intervening questions when available',()=>{
  const session=makeSession(DICTIONARY.slice(0,10),'both',seeded());
  const word=session.queue[0].word;recordAnswer(session,false);
  assert.equal(session.queue.length,21);assert.equal(session.queue[4].retry,true);assert.equal(session.queue[4].word.id,word.id);
  assert.ok(session.queue.slice(1,4).every(q=>q.word.id!==word.id));
});
test('both directions tested; repeated wrong answers finish after at most sixty questions',()=>{
  const session=makeSession(DICTIONARY.slice(0,10));let count=0;
  do{recordAnswer(session,false);count++;}while(advance(session));
  assert.equal(count,60);assert.equal(session.firstTotal,20);assert.equal(session.correct,0);assert.equal(pendingWords(session).length,10);
});

test('correcting a guessed answer records a failure and queues one bounded repetition',()=>{
  const session=makeSession(DICTIONARY.slice(0,2),'zh',seeded());
  recordAnswer(session,true);assert.equal(session.correct,1);
  recordAnswer(session,false,{rating:'again',correction:true});
  assert.equal(session.correct,0);assert.equal(session.answered,1);assert.equal(session.queue.length,3);assert.equal(pendingWords(session).length,1);
  recordAnswer(session,false,{rating:'again',correction:true});assert.equal(session.queue.length,3);
});
test('hard is a correct answer requiring another repetition rather than an error',()=>{
  const session=makeSession(DICTIONARY.slice(0,1),'zh');
  recordAnswer(session,true,{rating:'hard'});assert.equal(session.correct,1);assert.equal(pendingWords(session).length,1);
  advance(session);recordAnswer(session,true);assert.equal(pendingWords(session).length,0);
});
test('all known senses exclude homonyms and synonyms from both quiz directions',()=>{
  const target={id:'apple',korean:'사과',chinese:'苹果',acceptedMeanings:['苹果','道歉']};
  const apology={id:'apology',korean:'사죄',chinese:'道歉'};
  for(const direction of ['ko','zh'])assert.ok(makeOptions(target,direction,[apology],DICTIONARY).every(option=>option.id!=='apology'));
  assert.equal(overlaps({korean:'물',chinese:'水'},{korean:'과일',chinese:'水果',acceptedMeanings:['水果']}),false);
});
test('a corrected retry clears the pending state without rewriting first-round accuracy',()=>{
  const session=makeSession(DICTIONARY.slice(0,1));recordAnswer(session,false);advance(session);recordAnswer(session,true);advance(session);recordAnswer(session,true);advance(session);
  assert.equal(session.correct,1);assert.equal(session.firstTotal,2);assert.equal(session.retriesCorrect,1);assert.equal(pendingWords(session).length,0);
});
