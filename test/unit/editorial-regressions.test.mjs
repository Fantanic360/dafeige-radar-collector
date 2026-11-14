import test from 'node:test';
import assert from 'node:assert/strict';
import { rssAdapter, parseFeed } from '../../src/adapters/rss.mjs';
import { bilibiliAdapter } from '../../src/adapters/bilibili.mjs';
import { xiaoyuzhouAdapter } from '../../src/adapters/xiaoyuzhou.mjs';
import { validateResult } from '../../src/adapters/base.mjs';
import { Runner, batchApplied, mergeRemotePosts } from '../../src/lib/runner.mjs';
import { postIdFor, sanitizePostId } from '../../src/lib/normalize.mjs';

const from='2026-11-06T00:00:00Z', to='2026-11-14T00:00:00Z';
const target={sourceId:'test',platform:'播客',url:'https://example.test',override:{feedUrl:'https://example.test/feed'}};
const nowIso=()=>to;
const saveEvidence=async name=>`evidence/${name}`;

test('long RSS podcast description is metadata; truncated window never success',async()=>{
  const xml=`<rss><channel><item><title>episode</title><link>https://example.test/episode</link><guid>ep</guid><pubDate>Fri, 13 Nov 2026 00:00:00 GMT</pubDate><description>${'show notes '.repeat(500)}</description></item></channel></rss>`;
  const result=await rssAdapter.inspect({target,ctx:{http:{text:async()=>xml},nowIso,saveEvidence},windowFrom:from,windowTo:to});
  assert.equal(result.posts[0].evidence,'metadata');
  assert.equal(result.status,'retry');
  assert.equal(result.contentAttempts[0].status,'retry');
});

test('RSS updated date does not masquerade as publication date',()=>{
  const feed=parseFeed('<feed><entry><title>x</title><link href="https://example.test/x"/><updated>2026-11-13T00:00:00Z</updated></entry></feed>');
  assert.equal(feed.items[0].rawDate,null);
});

test('whole page HTML text cannot automatically verify an article',async()=>{
  const result=await rssAdapter.content({post:{id:'p',url:target.url},ctx:{http:{text:async()=>'<html><nav>'+ 'navigation '.repeat(1000)+'</nav></html>'},saveEvidence}});
  assert.equal(result.status,'retry');
});

test('podcast notes never upgrade to transcript/fulltext',async()=>{
  const result=await xiaoyuzhouAdapter.content({post:{id:'p',title:'episode',extra:{showNotes:'notes '.repeat(400)}},ctx:{saveEvidence}});
  assert.equal(result.status,'retry');
  assert.equal(result.evidence,'metadata');
});

test('Bilibili player API failure is not an empty subtitle result',async()=>{
  await assert.rejects(()=>bilibiliAdapter.content({post:{id:'p',url:'https://www.bilibili.com/video/BV12oWi6VEzP'},ctx:{http:{json:async url=>url.includes('/view?')?{code:0,data:{cid:1}}:{code:-400,message:'bad request'}}}}),/未成功返回/);
});

test('empty subtitle track is retry, never verified',async()=>{
  const result=await bilibiliAdapter.content({post:{id:'p',url:'https://www.bilibili.com/video/BV12oWi6VEzP'},ctx:{http:{json:async url=>url.includes('/view?')?{code:0,data:{cid:1}}:url.includes('/player/')?{code:0,data:{subtitle:{subtitles:[{subtitle_url:'https://example.test/sub'}]}}}:{body:[]}},saveEvidence}});
  assert.equal(result.status,'retry');
});

test('future and relative publication timestamps cannot enter posts',()=>{
  const result=validateResult({status:'success',itemsRead:1,note:'list',posts:[{title:'future',url:'https://example.test/p',publishedAt:'2026-11-15T00:00:00Z'}],windowFrom:from,windowTo:to},target);
  assert.equal(result.ok,false);
});

test('remote blocked content and backoff survive local metadata refresh',()=>{
  const merged=mergeRemotePosts({p:{id:'p',evidence:'metadata',contentStatus:'pending'}},{p:{id:'p',evidence:'metadata',contentStatus:'blocked',contentCheckedAt:to,contentFailCount:3,nextContentAttemptAt:null}});
  assert.equal(merged.p.contentStatus,'blocked');
  assert.equal(merged.p.contentFailCount,3);
});

test('failed pendingFrom is not discarded by initial seven-day window',()=>{
  const result=Runner.prototype.windowFor.call({policy:{}},{id:'t'},{t:{pendingFrom:'2026-10-01T00:00:00Z',lastSuccessWindowTo:from}},new Date(to));
  assert.equal(result.windowFrom,'2026-10-01T00:00:00.000Z');
});

test('live empty roster does not reactivate local authors',async()=>{
  const object={sourcesDoc:{sources:[]},adapterDoc:{},extraDoc:{}};
  assert.deepEqual(await Runner.prototype.resolveTargets.call(object,[]),[]);
});

test('release identifiers use server-compatible characters and bounded length',()=>{
  assert.equal(postIdFor({sourceId:'carl',platform:'GitHub',platformPostId:'LearnPrompt/awesome-seedance@v0.3.0'}),'carl-github-LearnPrompt-awesome-seedance-v0-3-0');
  assert.match(sanitizePostId('v1.2.'+'x'.repeat(200)),/^[A-Za-z0-9_-]{1,100}$/);
});

test('readback does not deadlock when the site omits contentCheckedAt', () => {
  // The public mirror exposes contentStatus but not contentCheckedAt. Treating the
  // missing field as "not applied" preserves the outbox forever and the next round
  // aborts on replay.
  const applied = batchApplied(
    { observations: [], posts: [], contentAttempts: [{ postId: 'p1', checkedAt: '2026-11-14T10:00:00Z' }] },
    { states: {}, posts: { p1: { id: 'p1', contentStatus: 'verified' } } },
  );
  assert.equal(applied, true);
});

test('readback accepts an evidence upgrade but rejects a downgrade', () => {
  const up = batchApplied(
    { posts: [{ id: 'p', publishedAt: '2026-11-14T00:00:00Z', evidence: 'transcript' }] },
    { states: {}, posts: { p: { id: 'p', publishedAt: '2026-11-14T00:00:00Z', evidence: 'fulltext' } } },
  );
  assert.equal(up, true, '站点存了 fulltext，推 transcript 不算失败');
  const down = batchApplied(
    { posts: [{ id: 'p', publishedAt: '2026-11-14T00:00:00Z', evidence: 'fulltext' }] },
    { states: {}, posts: { p: { id: 'p', publishedAt: '2026-11-14T00:00:00Z', evidence: 'metadata' } } },
  );
  assert.equal(down, false, '站点只存了 metadata，说明正文没落库');
});
