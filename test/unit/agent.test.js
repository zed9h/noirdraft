import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestRewrite } from '../../src/renderer/ai/agent.js';
import { createHistory, reconstructRevision } from '../../src/renderer/history/graph.js';

const protocol = 'Use NoirDraft native tools.';
const call = (name, args, id) => ({ id: `call_${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (calls, raw = 'response') => ({ message: { role: 'assistant', content: null, tool_calls: calls }, raw });
const clean = { sentence_integrity: true, mechanics: true, clarity: true, style: true };
const open = (notebooks, intent = 'Rewrite the passage.') => call('open_notebooks', { intent, notebooks }, 'open');
const edit = (operations, notebook, id = 'edit') => call('edit_notebook', { ...(notebook ? { notebook } : {}), operations }, id);
const reviewCall = (next_intent = 'Submit it.', extra = {}, id = 'review') => call('review_notebook', { copyedit: clean, next_intent, ...extra }, id);
const submit = (notebook, id = 'submit') => call('submit_notebook', notebook ? { notebook } : {}, id);

test('a chat-only turn is one send_response', async () => {
  const history = await createHistory('Original.');
  const client = { calls: 0, async chatCompletion() {
    this.calls += 1;
    return this.calls === 1 ? response([call('send_response', { message: 'Hello.' }, 'say')], 'say') : (() => { throw new Error('turn should have ended'); })();
  } };
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 0], request: 'hi', agentProtocol: protocol });
  assert.equal(result.chat, 'Hello.');
  assert.equal(client.calls, 1);
});

const script = (steps) => { let index = 0; const seen = []; return { seen, async chatCompletion({ messages }) { seen.push(messages.at(-1).content); const step = steps[index]; index += 1; if (!step) throw new Error('script exhausted'); return response(Array.isArray(step) ? step : [step]); } }; };
const closing = [call('send_response', { message: 'Done.' }, 'say-done')];
const finishing = [call('finish_changes', {}, 'finish'), ...closing];

test('open_notebooks shows the review with intents, read-only context, and numbered paragraphs', async () => {
  const history = await createHistory('Before. Original. After.');
  const client = script([open([{ intent: 'Sharper.', target_words: 20, start: 'selection' }]), edit([{ op: 'replace', paragraph_id: 1, text: 'Sharp.' }]), reviewCall(), submit(), ...finishing]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [8, 17], mode: 'block', request: 'Sharpen it.', agentProtocol: protocol });
  const form = client.seen[1];
  assert.match(form, /NOIRDRAFT NOTEBOOK REVIEW/);
  assert.match(form, /Overall intent: Rewrite the passage\./);
  assert.match(form, /Notebook 1 of 1 — Sharper\./);
  assert.match(form, /read-only/);
  assert.match(form, /\[¶1\]\nOriginal\./);
  assert.equal(await reconstructRevision(history, 1), 'Before. Sharp. After.\n');
  assert.match(result.chat, /#1/);
});

test('alternatives are siblings of the base and a resubmission chains onto its notebook', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'A.', target_words: 1, start: 'blank' }, { intent: 'B.', target_words: 1, start: 'blank' }]),
    edit([{ op: 'replace', paragraph_id: 1, text: 'First.' }], 1), reviewCall('Submit A.', {}, 'r1'), submit(1, 's1'),
    edit([{ op: 'replace', paragraph_id: 1, text: 'Second.' }], 2, 'e2'), reviewCall('Submit B.', { notebook: 2 }, 'r2'), submit(2, 's2'),
    edit([{ op: 'insert_after', paragraph_id: 2, text: 'First, extended.' }], 1, 'e3'), reviewCall('Submit A again.', { notebook: 1 }, 'r3'), submit(1, 's3'),
    ...finishing,
  ]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Two takes.', agentProtocol: protocol });
  assert.deepEqual(history.revisions.get(1).parents, [0]);
  assert.deepEqual(history.revisions.get(2).parents, [0]);
  assert.deepEqual(history.revisions.get(3).parents, [1]);
  assert.equal(await reconstructRevision(history, 3), 'First.\n\nFirst, extended.\n');
  assert.deepEqual(result.revisions.map(({ id }) => id), [3, 2]);
  assert.doesNotMatch(result.chat, /#1\b/);
});

test('editing twice without a review, or submitting with placeholders, is rejected constructively', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'Long.', target_words: 300, start: 'blank' }]),
    edit([{ op: 'replace', paragraph_id: 1, text: '[Outline the scene.]' }]),
    edit([{ op: 'replace', paragraph_id: 2, text: 'Hasty.' }], undefined, 'again'),
    reviewCall('Expand the outline.', {}, 'r1'),
    submit(undefined, 's1'),
    edit([{ op: 'replace', paragraph_id: 2, text: 'The scene, written out.' }], undefined, 'e2'),
    reviewCall('Submit.', {}, 'r2'), submit(undefined, 's2'), ...finishing,
  ]);
  const corrections = [];
  const wrapped = { async chatCompletion(request) { corrections.push(request.messages.filter((m) => m.content?.includes?.('manager_correction')).map((m) => m.content).join('')); return client.chatCompletion(request); } };
  await requestRewrite({ client: wrapped, history, baseRevisionId: 0, range: [0, 9], request: 'Write a scene.', agentProtocol: protocol });
  assert.match(corrections.join('\n'), /unreviewed edits/);
  assert.match(corrections.join('\n'), /Placeholder paragraphs remain: ¶2/);
  assert.equal(await reconstructRevision(history, 1), 'The scene, written out.\n');
});

test('a batch error lists every problem and suggests smaller edits', async () => {
  const history = await createHistory('Original.');
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'blank' }]), edit([{ op: 'delete', paragraph_id: 42 }, { op: 'insert_after', paragraph_id: 1, text: '' }]), edit([{ op: 'replace', paragraph_id: 1, text: 'Fine.' }], undefined, 'ok'), reviewCall(), submit(), ...finishing]);
  await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(client.seen[2], /NOIRDRAFT EDIT ERRORS/);
  assert.match(client.seen[2], /paragraph 42 is not in this notebook/);
  assert.match(client.seen[2], /smaller edits/);
});

test('an unchanged notebook gets a puzzled response asking about intent and id', async () => {
  const history = await createHistory('Original.');
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'selection' }, { intent: 'B.', target_words: 1, start: 'blank' }]), edit([{ op: 'insert_after', paragraph_id: 1, text: 'Extra.' }], 2, 'wrong'), edit([{ op: 'replace', paragraph_id: 1, text: 'Changed.' }], 2, 'e'), reviewCall('Go.', { notebook: 2 }), submit(1, 'unchanged'), submit(2, 'good'), ...finishing]);
  const corrections = [];
  const wrapped = { async chatCompletion(request) { corrections.push(request.messages.filter((m) => m.content?.includes?.('manager_correction')).map((m) => m.content).join('')); return client.chatCompletion(request); } };
  await requestRewrite({ client: wrapped, history, baseRevisionId: 0, range: [0, 9], request: 'Two.', agentProtocol: protocol });
  assert.match(corrections.join('\n'), /What did you intend\? You may have edited a different notebook/);
});

test('finish warns once about blocked work, then leaves it out', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'Keep.', target_words: 1, start: 'blank' }, { intent: 'Loose.', target_words: 1, start: 'blank' }]),
    edit([{ op: 'replace', paragraph_id: 1, text: 'Kept.' }], 1), reviewCall('Submit.', {}, 'r1'), submit(1, 's1'),
    edit([{ op: 'replace', paragraph_id: 1, text: 'Loose.' }], 2, 'e2'),
    call('finish_changes', {}, 'f1'), call('finish_changes', {}, 'f2'), ...closing,
  ]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Two.', agentProtocol: protocol });
  assert.match(client.seen.join('\n'), /NOIRDRAFT NOT READY TO FINISH/);
  assert.match(client.seen.join('\n'), /Notebook 2 — Loose\.[\s\S]*not achieved: not delivered/);
  assert.equal(history.revisions.has(2), false);
  assert.deepEqual(result.revisions.map(({ id }) => id), [1]);
});

test('the hard review ceiling wraps up: clean reviewed notebooks are submitted, the rest discarded', async () => {
  const history = await createHistory('Original.');
  const steps = [open([{ intent: 'A.', target_words: 1, start: 'blank' }]), edit([{ op: 'replace', paragraph_id: 1, text: 'Good.' }])];
  let id = 1;
  for (let round = 0; round < 20; round += 1) steps.push(reviewCall('Keep polishing.', {}, `r${round}`), edit([{ op: 'replace', paragraph_id: id + 1, text: `Version ${round}.` }], undefined, `e${round}`), (id += 1, null));
  const filtered = steps.filter(Boolean);
  const client = script([...filtered, ...closing]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(client.seen.join('\n'), /review deadline was reached/);
  assert.ok(result.revision);
});

test('emptying a submitted notebook retracts its branch and a rewrite starts a fresh sibling', async () => {
  const history = await createHistory('Original.');
  const progress = [];
  const client = script([
    open([{ intent: 'A.', target_words: 1, start: 'blank' }, { intent: 'B.', target_words: 1, start: 'blank' }]),
    edit([{ op: 'replace', paragraph_id: 1, text: 'First.' }], 1), reviewCall('Submit.', { notebook: 1 }, 'r1'), submit(1, 's1'),
    edit([{ op: 'delete', paragraph_id: 2 }], 1, 'wipe'),
    reviewCall('Rewrite.', { notebook: 1 }, 'r2'),
    edit([{ op: 'replace', paragraph_id: 3, text: 'Fresh start.' }], 1, 'e3'), reviewCall('Submit.', { notebook: 1 }, 'r3'), submit(1, 's2'), ...finishing,
  ]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol, onProgress: ({ intent }) => progress.push(intent?.progress) });
  assert.match(client.seen.join('\n'), /submitted revisions were retracted/);
  assert.equal(history.revisions.has(1), false);
  assert.deepEqual(history.revisions.get(2).parents, [0]);
  assert.deepEqual(result.revisions.map(({ id }) => id), [2]);
  assert.ok(progress.some((line) => /Notebooks ▸?1 ✓ 1\/1w/.test(line ?? '')));
});

test('finish submits ready notebooks the model forgot to submit', async () => {
  const history = await createHistory('Original.');
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'blank' }]), edit([{ op: 'replace', paragraph_id: 1, text: 'Ready.' }]), reviewCall('Done.'), ...finishing]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.equal(await reconstructRevision(history, 1), 'Ready.\n');
  assert.match(result.chat, /^\[#1\].*Done\.$/s);
});

test('chat and change links appear in the order they happen', async () => {
  const history = await createHistory('Original.');
  const client = script([
    call('comment_before_changes', { message: 'I will try.' }, 'before'),
    open([{ intent: 'A.', target_words: 1, start: 'blank' }]),
    edit([{ op: 'replace', paragraph_id: 1, text: 'Made.' }]), reviewCall(), submit(),
    call('send_response', { message: 'Here it is.' }, 'after'),
  ]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.equal(result.chat, 'I will try.\n\n[#1](noirdraft://version/STORY/1)\n\nHere it is.');
  assert.match(client.seen.filter((text) => /COMMENT ADDED/.test(text)).at(-1), /Start with open_notebooks/);
});

test('a send_response submits ready notebooks first, so their link precedes the message', async () => {
  const history = await createHistory('Original.');
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'blank' }]), edit([{ op: 'replace', paragraph_id: 1, text: 'Made.' }]), reviewCall(), call('send_response', { message: 'Done it.' }, 'end')]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.equal(await reconstructRevision(history, 1), 'Made.\n');
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1)\n\nDone it.');
});

test('a send_response with a blocked notebook bounces once without sending, then leaves it out', async () => {
  const history = await createHistory('Original.');
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'blank' }]), edit([{ op: 'replace', paragraph_id: 1, text: '[Outline.]' }]), reviewCall(), call('send_response', { message: 'First try.' }, 'end1'), call('send_response', { message: 'Second try.' }, 'end2')]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(client.seen.join('\n'), /RESPONSE NOT SENT YET/);
  assert.match(client.seen.join('\n'), /Placeholder paragraphs remain: ¶2/);
  assert.equal(result.chat, 'Second try.');
  assert.equal(result.revision, null);
});

test('finish_changes cannot repeat, and send_response ends the turn afterwards', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'A.', target_words: 1, start: 'blank' }]), edit([{ op: 'replace', paragraph_id: 1, text: 'Ready.' }]), reviewCall(),
    call('finish_changes', {}, 'f1'), call('finish_changes', {}, 'f2'), ...closing,
  ]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.equal(await reconstructRevision(history, 1), 'Ready.\n');
  assert.match(client.seen.join('\n'), /already finished/);
  assert.match(client.seen.join('\n'), /Now use send_response/);
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1)\n\nDone.');
});

test('clear_notebook retracts the branch and can restart from the selection or blank', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'A.', target_words: 1, start: 'selection' }, { intent: 'B.', target_words: 1, start: 'blank' }]),
    edit([{ op: 'replace', paragraph_id: 1, text: 'Changed.' }], 1), reviewCall('Submit.', { notebook: 1 }), submit(1),
    call('clear_notebook', { notebook: 1, restart: 'selection' }, 'clear'),
    edit([{ op: 'replace', paragraph_id: 3, text: 'Second try.' }], 1, 'e2'), reviewCall('Go.', { notebook: 1 }, 'r2'), submit(1, 's2'),
    call('clear_notebook', { notebook: 1 }, 'blank'), ...finishing.slice(0, 1), call('send_response', { message: 'Nothing kept.' }, 'say'),
  ]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(client.seen.join('\n'), /back to the selected text\. Its submitted revisions were retracted/);
  assert.match(client.seen.join('\n'), /\[¶3\]\nOriginal\./);
  assert.equal(history.revisions.has(1), false);
  assert.equal(history.revisions.has(2), false);
  assert.equal(result.revision, null);
  assert.equal(result.chat, 'Nothing kept.');
});

test('a single notebook closes on submit and returns the journey summary', async () => {
  const history = await createHistory('Original.');
  const client = script([
    call('comment_before_changes', { message: 'Let me tighten this.' }, 'c'),
    open([{ intent: 'Tighter.', target_words: 1, start: 'blank' }], 'A tighter version.'),
    edit([{ op: 'replace', paragraph_id: 1, text: 'Tight.' }]), call('review_notebook', { copyedit: { ...clean, style: false }, findings: '¶2 is flat.', next_intent: 'Add rhythm.' }, 'r1'),
    edit([{ op: 'replace', paragraph_id: 2, text: 'Tight, then some.' }], undefined, 'e2'), reviewCall('Ready.', {}, 'r2'), submit(),
    call('send_response', { message: 'Tightened it.' }, 'end'),
  ]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'Tighten.', agentProtocol: protocol });
  const summary = client.seen.at(-1);
  assert.match(summary, /closed the drafting/);
  assert.match(summary, /Your first message to the author: "Let me tighten this\."/);
  assert.match(summary, /Your overall intent: A tighter version\./);
  assert.match(summary, /along the way: review 1: ¶2 is flat\.; next: Add rhythm\./);
  assert.match(summary, /achieved: submitted/);
  assert.equal(result.chat, 'Let me tighten this.\n\n[#1](noirdraft://version/STORY/1)\n\nTightened it.');
});

const editReview = (id, verdict = 'approve') => ({ revision_id: id, copyedit: { sentence_integrity: verdict === 'approve', mechanics: verdict === 'approve', clarity: verdict === 'approve', style: verdict === 'approve' }, comment: 'Reviewed.', verdict });
const propose = (proposals, intent = 'Offer rewrites.', alternative_count = proposals.length, id = 'propose') => call('propose_edits', { intent, alternative_count, proposals: proposals.map((text) => ({ text })) }, id);
const reviewEdits = (reviews, id = 'review') => call('review_edits', { set_overview: 'Overall diagnosis.', reviews }, id);
const shortRange = (text, needle) => [text.indexOf(needle), text.indexOf(needle) + needle.length];

test('a selection inside a paragraph gets the short toolset and shows alternatives inline in context', async () => {
  const story = 'She walked home slowly. Rain fell.';
  const history = await createHistory(story);
  const seenTools = [];
  const client = script([propose(['quickly', 'wearily']), reviewEdits([editReview(1), editReview(2)]), call('send_response', { message: 'Two options.' }, 'end')]);
  const wrapped = { seen: client.seen, async chatCompletion(request) { seenTools.push(request.tools.map((item) => item.function.name)); return client.chatCompletion(request); } };
  const result = await requestRewrite({ client: wrapped, history, baseRevisionId: 0, range: shortRange(story, 'slowly'), request: 'Options.', agentProtocol: protocol });
  assert.deepEqual(seenTools[0], ['comment_before_changes', 'propose_edits', 'review_edits', 'send_response']);
  assert.match(client.seen[1], /NOIRDRAFT EDIT REVIEW/);
  assert.match(client.seen[1], /She walked home ⟦slowly⟧\. Rain fell\./);
  assert.match(client.seen[1], /She walked home ⟦quickly⟧\. Rain fell\./);
  assert.equal(await reconstructRevision(history, 2), 'She walked home wearily. Rain fell.\n');
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1) [#2](noirdraft://version/STORY/2)\n\nTwo options.');
});

test('a whole-paragraph selection gets the notebook toolset', async () => {
  const history = await createHistory('Original.');
  const seenTools = [];
  const client = { async chatCompletion(request) { seenTools.push(request.tools.map((item) => item.function.name)); return response([call('send_response', { message: 'Hi.' }, 'r')]); } };
  await requestRewrite({ client, history, baseRevisionId: 0, range: [0, 9], request: 'hi', agentProtocol: protocol });
  assert.deepEqual(seenTools[0], ['comment_before_changes', 'open_notebooks', 'edit_notebook', 'review_notebook', 'submit_notebook', 'clear_notebook', 'finish_changes', 'send_response']);
});

test('short mode: retracted alternatives are removed, a fresh batch continues, and links keep their order', async () => {
  const story = 'A quiet street.';
  const history = await createHistory(story);
  const client = script([
    call('comment_before_changes', { message: 'Trying a few.' }, 'c'),
    propose(['loud', 'empty'], 'Two moods.'), reviewEdits([editReview(1, 'retract'), editReview(2)], 'r1'),
    propose(['narrow'], 'One more.', 1, 'p2'), reviewEdits([editReview(3)], 'r2'),
    call('send_response', { message: 'Kept two.' }, 'end'),
  ]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: shortRange(story, 'quiet'), request: 'Options.', agentProtocol: protocol });
  assert.equal(history.revisions.has(1), false);
  assert.match(client.seen.join('\n'), /approved alternatives sufficiently serve|1 of 2 planned alternatives are approved/);
  assert.equal(result.chat, 'Trying a few.\n\n[#2](noirdraft://version/STORY/2) [#3](noirdraft://version/STORY/3)\n\nKept two.');
});

test('short mode: proposals identical to the base or each other are rejected with every error listed', async () => {
  const story = 'A quiet street.';
  const history = await createHistory(story);
  const client = script([propose(['quiet', 'loud', 'loud', ' ']), propose(['loud'], 'Fixed.', 1, 'p2'), reviewEdits([editReview(1)]), call('send_response', { message: 'Done.' }, 'end')]);
  await requestRewrite({ client, history, baseRevisionId: 0, range: shortRange(story, 'quiet'), request: 'Options.', agentProtocol: protocol });
  const first = client.seen[1];
  assert.match(first, /EDIT REVIEW/);
  assert.match(first, /Proposal 1 leaves the document unchanged/);
  assert.match(first, /Proposal 3 duplicates another proposal/);
  assert.match(first, /Proposal 4 has no text/);
});

test('short mode: send_response with unreviewed alternatives bounces once, then discards them', async () => {
  const story = 'A quiet street.';
  const history = await createHistory(story);
  const client = script([propose(['loud']), call('send_response', { message: 'One.' }, 'e1'), call('send_response', { message: 'Two.' }, 'e2')]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: shortRange(story, 'quiet'), request: 'Options.', agentProtocol: protocol });
  assert.match(client.seen.join('\n'), /RESPONSE NOT SENT YET/);
  assert.equal(history.revisions.has(1), false);
  assert.equal(result.chat, 'Two.');
});

test('comment_before_changes is rejected once changes have started, and tools of the other mode are refused', async () => {
  const story = 'A quiet street.';
  const history = await createHistory(story);
  const corrections = [];
  const client = script([propose(['loud']), call('comment_before_changes', { message: 'Late.' }, 'late'), call('open_notebooks', { intent: 'x', notebooks: [{ intent: 'a', target_words: 5 }] }, 'wrong'), reviewEdits([editReview(1)]), call('send_response', { message: 'Done.' }, 'end')]);
  const wrapped = { async chatCompletion(request) { corrections.push(request.messages.filter((m) => m.content?.includes?.('manager_correction')).map((m) => m.content).join('')); return client.chatCompletion(request); } };
  await requestRewrite({ client: wrapped, history, baseRevisionId: 0, range: shortRange(story, 'quiet'), request: 'Options.', agentProtocol: protocol });
  assert.match(corrections.join('\n'), /Changes have already started/);
  assert.match(corrections.join('\n'), /"open_notebooks" is not available/);
});

test('an intent that names an internal tool is rejected with a plain-prose example, then accepted', async () => {
  const history = await createHistory('Original.');
  const corrections = [];
  const client = script([
    open([{ intent: 'A.', target_words: 1, start: 'blank' }]),
    edit([{ op: 'replace', paragraph_id: 1, text: 'Made.' }]),
    reviewCall('submit_notebook', {}, 'bad'),
    reviewCall('The draft is finished and ready to be delivered.', {}, 'good'),
    submit(), ...closing,
  ]);
  const wrapped = { async chatCompletion(request) { corrections.push(request.messages.filter((m) => m.content?.includes?.('manager_correction')).map((m) => m.content).join('')); return client.chatCompletion(request); } };
  const result = await requestRewrite({ client: wrapped, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(corrections.join('\n'), /Your next_intent names an internal tool \(submit_notebook\)/);
  assert.match(corrections.join('\n'), /in plain prose/);
  assert.match(result.chat, /#1/);
});

test('a long next_intent is bounced toward a short working note', async () => {
  const history = await createHistory('Original.');
  const corrections = [];
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'blank' }]), edit([{ op: 'replace', paragraph_id: 1, text: 'Made.' }]), reviewCall('x'.repeat(250), {}, 'long'), reviewCall('Ready to deliver.', {}, 'short'), submit(), ...closing]);
  const wrapped = { async chatCompletion(request) { corrections.push(request.messages.filter((m) => m.content?.includes?.('manager_correction')).map((m) => m.content).join('')); return client.chatCompletion(request); } };
  await requestRewrite({ client: wrapped, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(corrections.join('\n'), /Keep next_intent to one short line/);
});

test('a cursor on the empty last row inserts on that row, and the range is not lost to trimming', async () => {
  const history = await createHistory('Line one.\n');
  assert.equal(await reconstructRevision(history, 0), 'Line one.\n');
  const client = script([open([{ intent: 'Continue.', target_words: 1, start: 'blank' }]), edit([{ op: 'replace', paragraph_id: 1, text: 'Line two.' }]), reviewCall(), submit(), ...closing]);
  await requestRewrite({ client, history, baseRevisionId: 0, range: [10, 10], request: 'Continue.', agentProtocol: protocol });
  assert.equal(await reconstructRevision(history, 1), 'Line one.\nLine two.\n');
});

test('a notebook well under its target is bounced once toward more writing, then may be submitted as it is', async () => {
  const history = await createHistory('Original.');
  const corrections = [];
  const client = script([
    open([{ intent: 'A long scene.', target_words: 300, start: 'blank' }]),
    edit([{ op: 'replace', paragraph_id: 1, text: 'Just a few words.' }]), reviewCall('Ready.'),
    submit(undefined, 'early'), submit(undefined, 'again'), ...closing,
  ]);
  const wrapped = { async chatCompletion(request) { corrections.push(request.messages.filter((m) => m.content?.includes?.('manager_correction')).map((m) => m.content).join('')); return client.chatCompletion(request); } };
  const result = await requestRewrite({ client: wrapped, history, baseRevisionId: 0, range: [0, 9], request: 'Write a long scene.', agentProtocol: protocol });
  assert.match(corrections.join('\n'), /Just a few|4 words against a target of about 300/);
  assert.match(corrections.join('\n'), /The author asked for more/);
  assert.equal(await reconstructRevision(history, 1), 'Just a few words.\n');
  assert.match(result.chat, /#1/);
});
