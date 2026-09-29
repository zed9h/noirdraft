import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestRewrite } from '../../src/renderer/ai/agent.js';
import { createHistory, reconstructRevision } from '../../src/renderer/history/graph.js';

const protocol = 'Use NoirDraft native tools.';
const call = (name, args, id) => ({ id: `call_${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const response = (calls, raw = 'response') => ({ message: { role: 'assistant', content: null, tool_calls: calls }, raw });
const open = (drafts, intent = 'Rewrite the passage.') => call('initialize_all_drafts_once', { intent, drafts }, 'open');
const view = (draft, id = 'view') => call('view_draft', draft != null ? { draft } : {}, id);
const replace = (from_paragraph, text, draft, id = 'replace') => call('replace_draft_text', { ...(draft ? { draft } : {}), from_paragraph, text }, id);
const insertAfter = (paragraph, text, draft, id = 'insert-after') => call('insert_draft_text_after', { ...(draft ? { draft } : {}), paragraph, text }, id);
const del = (from_paragraph, to_paragraph, draft, id = 'delete') => call('delete_draft_text', { ...(draft ? { draft } : {}), from_paragraph, ...(to_paragraph ? { to_paragraph } : {}) }, id);
const submit = (draft, id = 'submit') => call('save_draft', draft ? { draft } : {}, id);
const restart = (draft, start = 'blank', id = 'restart') => call('restart_draft', { draft, start }, id);

test('a chat-only turn is one send_chat_response_and_terminate', async () => {
  const history = await createHistory('Original.');
  const client = { calls: 0, async chatCompletion() {
    this.calls += 1;
    return this.calls === 1 ? response([call('send_chat_response_and_terminate', { message: 'Hello.' }, 'say')], 'say') : (() => { throw new Error('turn should have ended'); })();
  } };
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 0], request: 'hi', agentProtocol: protocol });
  assert.equal(result.chat, 'Hello.');
  assert.equal(client.calls, 1);
});

const script = (steps) => { let index = 0; const seen = []; return { seen, async chatCompletion({ messages, tools }) { seen.push(messages.at(-1).content); this._tools?.push(tools.map((item) => item.function.name)); const step = steps[index]; index += 1; if (!step) throw new Error('script exhausted'); return response(Array.isArray(step) ? step : [step]); } }; };
// Like script(), but records the full messages array (with tool_calls) for each call, for compaction assertions.
const recordingScript = (steps, usageByIndex = []) => {
  let index = 0; const calls = [];
  return { calls, async chatCompletion({ messages }) {
    calls.push(messages.map((entry) => ({ role: entry.role, content: entry.content, tool_calls: entry.tool_calls })));
    const step = steps[index];
    const usage = usageByIndex[index];
    index += 1;
    if (!step) throw new Error('script exhausted');
    return { ...response(Array.isArray(step) ? step : [step]), ...(usage != null ? { usage: { promptTokens: usage } } : {}) };
  } };
};
const closing = [call('send_chat_response_and_terminate', { message: 'Done.' }, 'say-done')];
const finishing = [call('finish_changes', {}, 'finish'), ...closing];

test('initialize_all_drafts_once shows drafts, and view_draft shows read-only context and numbered paragraphs', async () => {
  const history = await createHistory('Before. Original. After.');
  const client = script([open([{ intent: 'Sharper.', target_words: 20, start: 'selection' }]), view(1, 'first'), replace(1, 'Sharp.'), view(1, 'second'), submit(), ...finishing]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: [8, 17], mode: 'block', inlineWordLimit: 0, request: 'Sharpen it.', agentProtocol: protocol });
  const initialized = client.seen[1];
  assert.match(initialized, /NOIRDRAFT DRAFTS INITIALIZED/);
  assert.match(initialized, /Setup is done and never repeats/);
  assert.match(initialized, /Draft 1: Sharper\. \(about 20 words\)/);
  assert.match(initialized, /Next: view Draft 1\./);
  assert.doesNotMatch(initialized, /DRAFT VIEW/);
  const form = client.seen[2];
  assert.match(form, /NOIRDRAFT DRAFT VIEW/);
  assert.match(form, /Overall intent: Rewrite the passage\./);
  assert.match(form, /Draft 1 of 1 — Sharper\./);
  assert.match(form, /read-only/);
  assert.match(form, /\[¶1\]\nOriginal\./);
  assert.equal(await reconstructRevision(history, 1), 'Before. Sharp. After.\n');
  assert.match(result.chat, /#1/);
});

test('alternatives are siblings of the base and a resubmission chains onto its notebook', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'A.', target_words: 1, start: 'blank' }, { intent: 'B.', target_words: 1, start: 'blank' }]),
    replace(1, 'First.', 1), view(1, 'v1'), submit(1, 's1'),
    replace(1, 'Second.', 2, 'e2'), view(2, 'v2'), submit(2, 's2'),
    insertAfter(2, 'First, extended.', 1, 'e3'), view(1, 'v3'), submit(1, 's3'),
    ...finishing,
  ]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Two takes.', agentProtocol: protocol });
  assert.deepEqual(history.revisions.get(1).parents, [0]);
  assert.deepEqual(history.revisions.get(2).parents, [0]);
  assert.deepEqual(history.revisions.get(3).parents, [1]);
  assert.equal(await reconstructRevision(history, 3), 'First.\n\nFirst, extended.\n');
  assert.deepEqual(result.revisions.map(({ id }) => id), [3, 2]);
  assert.doesNotMatch(result.chat, /#1\b/);
});

test('several edits happen between views, consuming one cycle, and submitting with placeholders is rejected constructively', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'Long.', target_words: 5, start: 'blank' }]),
    replace(1, '[Outline the scene.]', undefined, 'e1'),
    insertAfter(2, 'A concrete line.', undefined, 'e2'),
    view(1, 'v1'),
    replace(2, 'The scene, written out.', undefined, 'e3'),
    view(1, 'v2'), submit(undefined, 's2'), ...finishing,
  ]);
  const seenViews = [];
  const wrapped = { async chatCompletion(request) { seenViews.push(request.messages.at(-1).content); return client.chatCompletion(request); } };
  await requestRewrite({ mode: 'block', inlineWordLimit: 0, client: wrapped, history, baseRevisionId: 0, range: [0, 9], request: 'Write a scene.', agentProtocol: protocol });
  assert.match(seenViews.find((text) => /NOIRDRAFT DRAFT VIEW/.test(text) && /placeholder/.test(text)), /Placeholders still to write: ¶2/);
  assert.equal(await reconstructRevision(history, 1), 'The scene, written out.\n\nA concrete line.\n');
});

test('a batch error lists every problem and suggests smaller edits', async () => {
  const history = await createHistory('Original.');
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'blank' }]), del(42, undefined, undefined, 'bad'), replace(1, 'Fine.', undefined, 'ok'), view(1), submit(), ...finishing]);
  await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(client.seen[2], /NOIRDRAFT EDIT ERRORS/);
  assert.match(client.seen[2], /paragraph 42 is not in this notebook/);
});

test('an unchanged notebook gets a puzzled response asking about intent and id', async () => {
  const history = await createHistory('Original.');
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'selection' }, { intent: 'B.', target_words: 1, start: 'blank' }]), insertAfter(1, 'Extra.', 2, 'wrong'), replace(1, 'Changed.', 2, 'e'), view(2, 'v'), submit(1, 'unchanged'), submit(2, 'good'), ...finishing]);
  const corrections = [];
  const wrapped = { async chatCompletion(request) { corrections.push(request.messages.filter((m) => m.content?.includes?.('manager_correction')).map((m) => m.content).join('')); return client.chatCompletion(request); } };
  await requestRewrite({ mode: 'block', inlineWordLimit: 0, client: wrapped, history, baseRevisionId: 0, range: [0, 9], request: 'Two.', agentProtocol: protocol });
  assert.match(corrections.join('\n'), /What did you intend\? You may have edited a different draft/);
});

test('finish warns once about blocked work, then leaves it out', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'Keep.', target_words: 1, start: 'blank' }, { intent: 'Loose.', target_words: 1, start: 'blank' }]),
    replace(1, 'Kept.', 1), view(1, 'v1'), submit(1, 's1'),
    replace(1, 'Loose.', 2, 'e2'),
    call('finish_changes', {}, 'f1'), call('finish_changes', {}, 'f2'), ...closing,
  ]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Two.', agentProtocol: protocol });
  assert.match(client.seen.join('\n'), /NOIRDRAFT NOT READY TO FINISH/);
  assert.match(client.seen.join('\n'), /Draft 2 — Loose\.[\s\S]*not achieved: not delivered/);
  assert.equal(history.revisions.has(2), false);
  assert.deepEqual(result.revisions.map(({ id }) => id), [1]);
});

test('the hard cycle ceiling wraps up: reviewed clean notebooks are submitted, the rest discarded', async () => {
  const history = await createHistory('Original.');
  const steps = [open([{ intent: 'A.', target_words: 1, start: 'blank' }]), replace(1, 'Good.', undefined, 'e0')];
  let id = 1;
  for (let round = 0; round < 20; round += 1) steps.push(view(1, `v${round}`), replace(id + 1, `Version ${round}.`, undefined, `e${round}`), (id += 1, null));
  const filtered = steps.filter(Boolean);
  const client = script([...filtered, ...closing]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(client.seen.join('\n'), /cycle deadline was reached/);
  assert.ok(result.revision);
});

test('emptying a submitted notebook retracts its branch and a rewrite starts a fresh sibling', async () => {
  const history = await createHistory('Original.');
  const progress = [];
  const client = script([
    open([{ intent: 'A.', target_words: 1, start: 'blank' }, { intent: 'B.', target_words: 1, start: 'blank' }]),
    replace(1, 'First.', 1), view(1, 'v1'), submit(1, 's1'),
    del(2, undefined, 1, 'wipe'),
    view(1, 'v2'),
    replace(3, 'Fresh start.', 1, 'e3'), view(1, 'v3'), submit(1, 's2'), ...finishing,
  ]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol, onProgress: ({ intent }) => progress.push(intent?.progress) });
  assert.match(client.seen.join('\n'), /saved revisions were retracted/);
  assert.equal(history.revisions.has(1), false);
  assert.deepEqual(history.revisions.get(2).parents, [0]);
  assert.deepEqual(result.revisions.map(({ id }) => id), [2]);
  assert.ok(progress.some((line) => /Draft [▸ ]1 1\/1w ✓/.test(line ?? '')));
});

test('finish submits ready notebooks the model forgot to submit', async () => {
  const history = await createHistory('Original.');
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'blank' }]), replace(1, 'Ready.', undefined, 'e'), view(1), ...finishing]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.equal(await reconstructRevision(history, 1), 'Ready.\n');
  assert.match(result.chat, /^\[#1\].*Done\.$/s);
});

test('chat and change links appear in the order they happen', async () => {
  const history = await createHistory('Original.');
  const client = script([
    call('send_chat_message_and_continue', { message: 'I will try.' }, 'before'),
    open([{ intent: 'A.', target_words: 1, start: 'blank' }]),
    replace(1, 'Made.', undefined, 'e'), view(1), submit(),
    call('send_chat_response_and_terminate', { message: 'Here it is.' }, 'after'),
  ]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.equal(result.chat, 'I will try.\n\n[#1](noirdraft://version/STORY/1)\n\nHere it is.');
  assert.match(client.seen.filter((text) => /Message sent/.test(text)).at(-1), /Manager:/);
});

test('a send_chat_response_and_terminate submits ready notebooks first, so their link precedes the message', async () => {
  const history = await createHistory('Original.');
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'blank' }]), replace(1, 'Made.', undefined, 'e'), view(1), call('send_chat_response_and_terminate', { message: 'Done it.' }, 'end')]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.equal(await reconstructRevision(history, 1), 'Made.\n');
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1)\n\nDone it.');
});

test('a send_chat_response_and_terminate with a blocked notebook bounces once without sending, then leaves it out', async () => {
  const history = await createHistory('Original.');
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'blank' }]), replace(1, '[Outline.]', undefined, 'e'), view(1), call('send_chat_response_and_terminate', { message: 'First try.' }, 'end1'), call('send_chat_response_and_terminate', { message: 'Second try.' }, 'end2')]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(client.seen.join('\n'), /RESPONSE NOT SENT YET/);
  assert.match(client.seen.join('\n'), /Draft 1: Placeholder paragraphs remain: ¶2/);
  assert.equal(result.chat, 'Second try.');
  assert.equal(result.revision, null);
});

test('finish_changes cannot repeat, and send_chat_response_and_terminate ends the turn afterwards', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'A.', target_words: 1, start: 'blank' }]), replace(1, 'Ready.', undefined, 'e'), view(1),
    call('finish_changes', {}, 'f1'), call('finish_changes', {}, 'f2'), ...closing,
  ]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.equal(await reconstructRevision(history, 1), 'Ready.\n');
  assert.match(client.seen.join('\n'), /"finish_changes" is not available/);
  assert.match(client.seen.join('\n'), /send the final chat response and terminate/);
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1)\n\nDone.');
});

test('restart_draft retracts the branch and can restart from the selection or blank', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'A.', target_words: 1, start: 'selection' }, { intent: 'B.', target_words: 1, start: 'blank' }]),
    replace(1, 'Changed.', 1), view(1), submit(1),
    restart(1, 'selection', 'clear'),
    view(1, 'v-after-restart'),
    replace(3, 'Second try.', 1, 'e2'), view(1, 'v2'), submit(1, 's2'),
    restart(1, 'blank', 'blank2'), ...finishing.slice(0, 1), call('send_chat_response_and_terminate', { message: 'Nothing kept.' }, 'say'),
  ]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(client.seen.join('\n'), /back to the selected text\. Its saved revisions were retracted/);
  assert.match(client.seen.join('\n'), /\[¶3\]\nOriginal\./);
  assert.equal(history.revisions.has(1), false);
  assert.equal(history.revisions.has(2), false);
  assert.equal(result.revision, null);
  assert.equal(result.chat, 'Nothing kept.');
});

test('a single notebook stays open after save and can be re-edited and saved again', async () => {
  const history = await createHistory('Original.');
  const client = script([
    call('send_chat_message_and_continue', { message: 'Let me tighten this.' }, 'c'),
    open([{ intent: 'Tighter.', target_words: 1, start: 'blank' }], 'A tighter version.'),
    replace(1, 'Tight.', undefined, 'e1'), view(1, 'v1'), submit(undefined, 's1'),
    replace(2, 'Tight, then some.', undefined, 'e2'), view(1, 'v2'), submit(undefined, 's2'),
    call('send_chat_response_and_terminate', { message: 'Tightened it.' }, 'end'),
  ]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Tighten.', agentProtocol: protocol });
  assert.equal(history.revisions.get(2).parents[0], 1);
  assert.equal(result.chat, 'Let me tighten this.\n\n[#2](noirdraft://version/STORY/2)\n\nTightened it.');
});

const editReview = (id, verdict = 'approve') => ({ revision_id: id, copyedit: { sentence_integrity: verdict === 'approve', mechanics: verdict === 'approve', clarity: verdict === 'approve', style: verdict === 'approve' }, comment: 'Reviewed.', verdict });
const propose = (proposals, intent = 'Offer rewrites.', alternative_count = proposals.length, id = 'propose') => call('propose_edits', { intent, alternative_count, proposals: proposals.map((text) => ({ text })) }, id);
const reviewEdits = (reviews, id = 'review') => call('review_edits', { set_overview: 'Overall diagnosis.', reviews }, id);
const shortRange = (text, needle) => [text.indexOf(needle), text.indexOf(needle) + needle.length];

test('a selection inside a paragraph gets the short toolset and shows alternatives inline in context', async () => {
  const story = 'She walked home slowly. Rain fell.';
  const history = await createHistory(story);
  const seenTools = [];
  const client = script([propose(['quickly', 'wearily']), reviewEdits([editReview(1), editReview(2)]), call('send_chat_response_and_terminate', { message: 'Two options.' }, 'end')]);
  const wrapped = { seen: client.seen, async chatCompletion(request) { seenTools.push(request.tools.map((item) => item.function.name)); return client.chatCompletion(request); } };
  const result = await requestRewrite({ client: wrapped, history, baseRevisionId: 0, range: shortRange(story, 'slowly'), request: 'Options.', agentProtocol: protocol });
  assert.deepEqual(seenTools[0], ['send_chat_message_and_continue', 'send_chat_response_and_terminate', 'propose_edits', 'review_edits']);
  assert.match(client.seen[1], /NOIRDRAFT EDIT REVIEW/);
  assert.match(client.seen[1], /She walked home ⟦slowly⟧\. Rain fell\./);
  assert.match(client.seen[1], /She walked home ⟦quickly⟧\. Rain fell\./);
  assert.equal(await reconstructRevision(history, 2), 'She walked home wearily. Rain fell.\n');
  assert.equal(result.chat, '[#1](noirdraft://version/STORY/1) [#2](noirdraft://version/STORY/2)\n\nTwo options.');
});

test('a whole-paragraph selection gets the block toolset', async () => {
  const original = `${'Word '.repeat(40).trim()}.`;
  const history = await createHistory(original);
  const seenTools = [];
  const client = { async chatCompletion(request) { seenTools.push(request.tools.map((item) => item.function.name)); return response([call('send_chat_response_and_terminate', { message: 'Hi.' }, 'r')]); } };
  await requestRewrite({ client, history, baseRevisionId: 0, range: [0, original.length], request: 'hi', agentProtocol: protocol });
  assert.deepEqual(seenTools[0], ['send_chat_message_and_continue', 'send_chat_response_and_terminate', 'initialize_all_drafts_once']);
});

test('inline mode: retracted alternatives are removed, a fresh batch continues, and links keep their order', async () => {
  const story = 'A quiet street.';
  const history = await createHistory(story);
  const client = script([
    call('send_chat_message_and_continue', { message: 'Trying a few.' }, 'c'),
    propose(['loud', 'empty'], 'Two moods.'), reviewEdits([editReview(1, 'retract'), editReview(2)], 'r1'),
    propose(['narrow'], 'One more.', 1, 'p2'), reviewEdits([editReview(3)], 'r2'),
    call('send_chat_response_and_terminate', { message: 'Kept two.' }, 'end'),
  ]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: shortRange(story, 'quiet'), request: 'Options.', agentProtocol: protocol });
  assert.equal(history.revisions.has(1), false);
  assert.match(client.seen.join('\n'), /approved alternatives sufficiently serve|1 of 2 planned alternatives are approved/);
  assert.equal(result.chat, 'Trying a few.\n\n[#2](noirdraft://version/STORY/2) [#3](noirdraft://version/STORY/3)\n\nKept two.');
});

test('inline mode: proposals identical to the base or each other are rejected with every error listed', async () => {
  const story = 'A quiet street.';
  const history = await createHistory(story);
  const client = script([propose(['quiet', 'loud', 'loud', ' ']), propose(['loud'], 'Fixed.', 1, 'p2'), reviewEdits([editReview(1)]), call('send_chat_response_and_terminate', { message: 'Done.' }, 'end')]);
  await requestRewrite({ client, history, baseRevisionId: 0, range: shortRange(story, 'quiet'), request: 'Options.', agentProtocol: protocol });
  const first = client.seen[1];
  assert.match(first, /EDIT REVIEW/);
  assert.match(first, /Proposal 1 leaves the document unchanged/);
  assert.match(first, /Proposal 3 duplicates another proposal/);
  assert.match(first, /Proposal 4 has no text/);
});

test('inline mode: send_chat_response_and_terminate with unreviewed alternatives bounces once, then discards them', async () => {
  const story = 'A quiet street.';
  const history = await createHistory(story);
  const client = script([propose(['loud']), call('send_chat_response_and_terminate', { message: 'One.' }, 'e1'), call('send_chat_response_and_terminate', { message: 'Two.' }, 'e2')]);
  const result = await requestRewrite({ client, history, baseRevisionId: 0, range: shortRange(story, 'quiet'), request: 'Options.', agentProtocol: protocol });
  assert.match(client.seen.join('\n'), /RESPONSE NOT SENT YET/);
  assert.equal(history.revisions.has(1), false);
  assert.equal(result.chat, 'Two.');
});

test('tools of the other mode are refused, correcting the model toward the right one', async () => {
  const story = 'A quiet street.';
  const history = await createHistory(story);
  const corrections = [];
  const client = script([propose(['loud']), call('initialize_all_drafts_once', { intent: 'x', drafts: [{ intent: 'a', target_words: 5 }] }, 'wrong'), reviewEdits([editReview(1)]), call('send_chat_response_and_terminate', { message: 'Done.' }, 'end')]);
  const wrapped = { async chatCompletion(request) { corrections.push(request.messages.filter((m) => m.content?.includes?.('manager_correction')).map((m) => m.content).join('')); return client.chatCompletion(request); } };
  await requestRewrite({ client: wrapped, history, baseRevisionId: 0, range: shortRange(story, 'quiet'), request: 'Options.', agentProtocol: protocol });
  assert.match(corrections.join('\n'), /"initialize_all_drafts_once" is not available/);
});

test('an intent that names an internal tool is rejected with a plain-prose example, then accepted', async () => {
  const history = await createHistory('Original.');
  const corrections = [];
  const client = script([
    open([{ intent: 'save_draft', target_words: 1, start: 'blank' }], 'save_draft'),
    open([{ intent: 'A tighter version.', target_words: 1, start: 'blank' }], 'A tighter version.', 'open2'),
    replace(1, 'Made.', undefined, 'e'), view(1), submit(), ...closing,
  ]);
  const wrapped = { async chatCompletion(request) { corrections.push(request.messages.filter((m) => m.content?.includes?.('manager_correction')).map((m) => m.content).join('')); return client.chatCompletion(request); } };
  const result = await requestRewrite({ mode: 'block', inlineWordLimit: 0, client: wrapped, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(corrections.join('\n'), /Your overall intent names an internal tool \(save_draft\)/);
  assert.match(corrections.join('\n'), /in plain prose/);
  assert.match(result.chat, /#1/);
});

test('a cursor on the empty last row inserts on that row, and the range is not lost to trimming', async () => {
  const history = await createHistory('Line one.\n');
  assert.equal(await reconstructRevision(history, 0), 'Line one.\n');
  const client = script([open([{ intent: 'Continue.', target_words: 1, start: 'blank' }]), replace(1, 'Line two.', undefined, 'e'), view(1), submit(), ...closing]);
  await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [10, 10], request: 'Continue.', agentProtocol: protocol });
  assert.equal(await reconstructRevision(history, 1), 'Line one.\nLine two.\n');
});

test('a notebook well under its target is bounced once toward more writing, then may be submitted as it is', async () => {
  const history = await createHistory('Original.');
  const corrections = [];
  const client = script([
    open([{ intent: 'A long scene.', target_words: 300, start: 'blank' }]),
    replace(1, 'Just a few words.', undefined, 'e'), view(1, 'v'),
    submit(undefined, 'early'), submit(undefined, 'again'), ...closing,
  ]);
  const wrapped = { async chatCompletion(request) { corrections.push(request.messages.filter((m) => m.content?.includes?.('manager_correction')).map((m) => m.content).join('')); return client.chatCompletion(request); } };
  const result = await requestRewrite({ mode: 'block', inlineWordLimit: 0, client: wrapped, history, baseRevisionId: 0, range: [0, 9], request: 'Write a long scene.', agentProtocol: protocol });
  assert.match(corrections.join('\n'), /Just a few|4 words against a target of about 300/);
  assert.match(corrections.join('\n'), /The author asked for more/);
  assert.equal(await reconstructRevision(history, 1), 'Just a few words.\n');
  assert.match(result.chat, /#1/);
});

test('planning only small notebooks switches the request to the inline flow', async () => {
  const history = await createHistory('Before.\n\n');
  const seenTools = [];
  const client = script([
    open([{ intent: 'Active.', target_words: 8, start: 'blank' }, { intent: 'Quiet.', target_words: 9, start: 'blank' }]),
    propose(['It rained on.', 'The rain thinned.']), reviewEdits([editReview(1), editReview(2)]), call('send_chat_response_and_terminate', { message: 'Two options.' }, 'end'),
  ]);
  const wrapped = { seen: client.seen, async chatCompletion(request) { seenTools.push(request.tools.map((item) => item.function.name)); return client.chatCompletion(request); } };
  const result = await requestRewrite({ client: wrapped, mode: 'block', history, baseRevisionId: 0, range: [8, 8], request: 'Write two.', agentProtocol: protocol });
  assert.match(client.seen[1], /SWITCHED TO INLINE ALTERNATIVES/);
  assert.match(client.seen[1], /alternative_count 2/);
  assert.deepEqual(seenTools[2], ['send_chat_message_and_continue', 'send_chat_response_and_terminate', 'propose_edits', 'review_edits']);
  assert.match(result.chat, /\[#1\].*\[#2\]/s);
});

test('several edits between views consume one cycle, and repeated unchanged views consume none', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'A.', target_words: 500, start: 'blank' }]),
    view(1, 'v0'),
    replace(1, 'One.', undefined, 'e1'), replace(2, 'Two.', undefined, 'e2'), replace(3, 'Three.', undefined, 'e3'),
    view(1, 'v1'), view(1, 'v2'),
    call('send_chat_response_and_terminate', { message: 'Done.' }, 'end'),
  ]);
  await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  const views = client.seen.filter((text) => /NOIRDRAFT DRAFT VIEW/.test(text));
  assert.match(views[0], /Cycle 0 of about/);
  assert.match(views[1], /Cycle 1 of about/);
  assert.match(views[2], /Cycle 1 of about/);
});

test('edit-result guidance escalates from continue, to view, to view-before-continuing as edits accumulate', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'A.', target_words: 2000, start: 'blank' }]),
    replace(1, 'One.', undefined, 'e1'),
    replace(2, 'One and two.', undefined, 'e2'),
    replace(3, 'One, two, three.', undefined, 'e3'),
    replace(4, 'One, two, three, four.', undefined, 'e4'),
    replace(5, 'One, two, three, four, five.', undefined, 'e5'),
    view(1, 'v1'), call('send_chat_response_and_terminate', { message: 'Done.' }, 'end'),
  ]);
  await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  const edits = client.seen.filter((text) => /^Draft 1 updated\./.test(text));
  assert.match(edits[0], /Next: continue editing Draft 1; alternatively, view/);
  assert.match(edits[2], /Next: view Draft 1; alternatively, make one final focused edit\./);
  assert.match(edits[4], /Next: view Draft 1 before continuing\./);
});

test('a long blank draft is recommended to outline with placeholders on its first view; a short draft is not', async () => {
  const history = await createHistory('Original.');
  const longClient = script([open([{ intent: 'Long.', target_words: 900, start: 'blank' }]), view(1, 'v1'), call('send_chat_response_and_terminate', { message: 'Ok.' }, 'end')]);
  await requestRewrite({ client: longClient, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.match(longClient.seen[2], /long blank draft/);
  assert.match(longClient.seen[2], /outline Draft 1 with placeholder paragraphs\./);

  const history2 = await createHistory('Original.');
  const shortClient = script([open([{ intent: 'Short.', target_words: 40, start: 'blank' }]), view(1, 'v1'), call('send_chat_response_and_terminate', { message: 'Ok.' }, 'end')]);
  await requestRewrite({ client: shortClient, mode: 'block', inlineWordLimit: 0, history: history2, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.doesNotMatch(shortClient.seen[2], /long blank draft/);
});

test('save_draft is unavailable right after an edit and reappears after another view', async () => {
  const history = await createHistory('Original.');
  const seenTools = [];
  const client = script([open([{ intent: 'A.', target_words: 1, start: 'blank' }]), replace(1, 'Made.', undefined, 'e1'), view(1, 'v1'), submit(), ...closing]);
  const wrapped = { async chatCompletion(request) { seenTools.push(request.tools.map((item) => item.function.name)); return client.chatCompletion(request); } };
  await requestRewrite({ client: wrapped, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.deepEqual(seenTools[2], ['send_chat_message_and_continue', 'send_chat_response_and_terminate', 'view_draft', 'replace_draft_text', 'insert_draft_text_before', 'insert_draft_text_after', 'delete_draft_text', 'restart_draft', 'finish_changes']);
  assert.ok(seenTools[3].includes('save_draft'));
});

test('saving a draft does not close it: it stays editable and can be viewed and saved again', async () => {
  const history = await createHistory('Original.');
  const client = script([
    open([{ intent: 'A.', target_words: 1, start: 'blank' }]),
    replace(1, 'First.', undefined, 'e1'), view(1, 'v1'), submit(undefined, 's1'),
    replace(2, 'Second.', undefined, 'e2'), view(1, 'v2'), submit(undefined, 's2'),
    call('send_chat_response_and_terminate', { message: 'Done.' }, 'end'),
  ]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol });
  assert.equal(history.revisions.get(2).parents[0], 1);
  assert.equal(await reconstructRevision(history, 2), 'Second.\n');
  assert.deepEqual(result.revisions.map(({ id }) => id), [2]);
});

test('view/edit compaction supersedes an earlier view and folds away edits it already reflects', async () => {
  const history = await createHistory('Original.');
  const client = recordingScript([
    open([{ intent: 'A.', target_words: 500, start: 'blank' }]),
    view(1, 'v1'),
    replace(1, 'One.', 1, 'e1'),
    view(1, 'v2'),
    call('send_chat_response_and_terminate', { message: 'Done.' }, 'end'),
  ]);
  await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol, pruneLevel: 3 });
  const lastRequest = client.calls.at(-1);
  const toolMessages = lastRequest.filter((entry) => entry.role === 'tool');
  assert.ok(toolMessages.some((entry) => /superseded/.test(entry.content)), 'the first view should be stubbed as superseded');
  assert.ok(!toolMessages.some((entry) => /^Draft 1 updated\./.test(entry.content)), 'the folded-in edit result should be gone');
  assert.ok(toolMessages.some((entry) => /NOIRDRAFT DRAFT VIEW/.test(entry.content)), 'the latest view stays intact');
});

test('view/edit compaction is skipped at a lower prune level', async () => {
  const history = await createHistory('Original.');
  const client = recordingScript([
    open([{ intent: 'A.', target_words: 500, start: 'blank' }]),
    view(1, 'v1'),
    replace(1, 'One.', 1, 'e1'),
    view(1, 'v2'),
    call('send_chat_response_and_terminate', { message: 'Done.' }, 'end'),
  ]);
  await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol, pruneLevel: 2 });
  const lastRequest = client.calls.at(-1);
  const toolMessages = lastRequest.filter((entry) => entry.role === 'tool');
  assert.ok(!toolMessages.some((entry) => /superseded/.test(entry.content)));
  assert.ok(toolMessages.some((entry) => /^Draft 1 updated\./.test(entry.content)));
});

test('propose/review compaction collapses a resolved batch to a compact summary', async () => {
  const story = 'A quiet street.';
  const history = await createHistory(story);
  const client = recordingScript([
    propose(['loud', 'quiet again']), reviewEdits([editReview(1, 'retract'), editReview(2)]),
    call('send_chat_response_and_terminate', { message: 'Done.' }, 'end'),
  ]);
  await requestRewrite({ client, history, baseRevisionId: 0, range: shortRange(story, 'quiet'), request: 'Options.', agentProtocol: protocol, pruneLevel: 3 });
  const lastRequest = client.calls.at(-1);
  const toolMessages = lastRequest.filter((entry) => entry.role === 'tool');
  assert.ok(toolMessages.some((entry) => /"resolved"/.test(entry.content)));
  assert.ok(!toolMessages.some((entry) => /NOIRDRAFT EDIT REVIEW/.test(entry.content)));
});

test('a truncated tool response retries with a hint appended in place, at a bumped temperature, instead of failing the turn', async () => {
  const history = await createHistory('Original.');
  const attempts = [];
  let attempt = 0;
  const client = {
    async chatCompletion({ messages, temperature }) {
      attempts.push({ length: messages.length, lastContent: messages.at(-1).content, temperature });
      attempt += 1;
      if (attempt === 1) return { message: { role: 'assistant', content: '', tool_calls: [] }, finishReason: 'length', raw: 'truncated' };
      return response([call('send_chat_response_and_terminate', { message: 'Recovered.' }, 'r')]);
    },
  };
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 0], request: 'hi', agentProtocol: protocol });
  assert.equal(attempt, 2);
  assert.equal(attempts[0].length, attempts[1].length, 'no new message should be added for the failed attempt');
  assert.notEqual(attempts[0].lastContent, attempts[1].lastContent);
  assert.match(attempts[1].lastContent, /previous attempt failed/);
  assert.ok(attempts[1].temperature > attempts[0].temperature);
  assert.equal(result.chat, 'Recovered.');
});

test('a persistently truncated response exhausts its retries and fails the turn', async () => {
  const history = await createHistory('Original.');
  const client = { async chatCompletion() { return { message: { role: 'assistant', content: '', tool_calls: [] }, finishReason: 'length', raw: 'r' }; } };
  await assert.rejects(
    requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 0], request: 'hi', agentProtocol: protocol }),
    (error) => error.code === 'TRUNCATED_TOOL_RESPONSE',
  );
});

test('context-budget pressure collapses to the most recently edited draft and is reported on the result', async () => {
  const history = await createHistory('Original.');
  const client = recordingScript([
    open([{ intent: 'A.', target_words: 1, start: 'blank' }, { intent: 'B.', target_words: 1, start: 'blank' }]),
    replace(1, 'First.', 1), view(1, 'v1'),
    replace(1, 'Second.', 2, 'e2'), view(2, 'v2'),
    call('send_chat_response_and_terminate', { message: 'Done.' }, 'end'),
  ], [0, 0, 0, 0, 500, 0]);
  const result = await requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Two.', agentProtocol: protocol, contextBudget: { contextLength: 100, reservedGeneration: 0 } });
  assert.equal(result.contextUsage.collapsedToOneDraft, true);
  assert.equal(result.contextUsage.peakPromptTokens, 500);
});

test('context-budget pressure fails the turn once nothing more can be pruned at the strictest level', async () => {
  const history = await createHistory('Original.');
  const client = recordingScript([
    open([{ intent: 'A.', target_words: 1, start: 'blank' }]),
    replace(1, 'First.', 1), view(1, 'v1'),
  ], [0, 0, 500]);
  await assert.rejects(
    requestRewrite({ client, mode: 'block', inlineWordLimit: 0, history, baseRevisionId: 0, range: [0, 9], request: 'Write.', agentProtocol: protocol, pruneLevel: 1, contextBudget: { contextLength: 100, reservedGeneration: 0 } }),
    (error) => error.code === 'CONTEXT_BUDGET_EXCEEDED',
  );
});
