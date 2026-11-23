import {test} from 'node:test';
import assert from 'node:assert/strict';
import {LEVELS,emptyProgress,parseProgress,recordVictory,unlocked,levelStars} from '../src/levels.ts';

test('the kingdom has ten nodes but only two playable castles',()=>{
  assert.equal(LEVELS.length,10);
  assert.deepEqual(LEVELS.filter(level=>level.castle).map(level=>level.id),[1,2]);
});

test('victory unlocks only level two and preserves the best run',()=>{
  const initial=emptyProgress();
  assert.equal(unlocked(1,initial),true);
  assert.equal(unlocked(2,initial),false);
  const first=recordVictory(initial,1,1,9800,108);
  assert.equal(unlocked(2,first),true);
  assert.equal(unlocked(3,first),false);
  const improved=recordVictory(first,1,2,14000,92);
  const replay=recordVictory(improved,1,1,8000,116);
  assert.deepEqual(replay.records[1],{completed:true,stars:2,score:14000,bestTime:92});
  assert.equal(unlocked(2,recordVictory(replay,2,2,20000,105)),true);
});

test('legacy best run migrates without erasing newer progress',()=>{
  const legacy=JSON.stringify({score:16000,time:94});
  const migrated=parseProgress(null,legacy);
  assert.equal(migrated.records[1].stars,1);
  assert.equal(migrated.records[1].bestTime,94);
  const saved=recordVictory(migrated,1,3,22000,58);
  assert.deepEqual(parseProgress(JSON.stringify(saved),legacy),saved);
});

test('zero-time legacy completion and an empty new save still unlock level two',()=>{
  const legacy=JSON.stringify({score:22000,time:0});
  const restored=parseProgress(JSON.stringify(emptyProgress()),legacy);
  assert.equal(restored.records[1].completed,true);
  assert.equal(restored.records[1].stars,1);
  assert.equal(restored.records[1].score,22000);
  assert.equal(restored.records[1].bestTime,0);
  assert.equal(unlocked(2,restored),true);
  assert.equal(unlocked(2,parseProgress(JSON.stringify(restored),null)),true);
});

test('loss-only legacy score and malformed saves do not unlock levels',()=>{
  const restored=parseProgress('{broken',JSON.stringify({score:15000,time:null}));
  assert.equal(restored.records[1].score,15000);
  assert.equal(unlocked(2,restored),false);
  assert.equal(unlocked(2,parseProgress(null,JSON.stringify({score:15000,time:null}))),false);
});

test('existing V1.3 stars and scores survive migration from a later legacy record',()=>{
  const old=JSON.stringify({version:1,records:{1:{stars:3,score:24000,bestTime:59},2:{stars:2,score:18000,bestTime:100}}});
  const result=parseProgress(old,JSON.stringify({score:14000,time:95}));
  assert.deepEqual(result.records[1],{completed:true,stars:3,score:24000,bestTime:59});
  assert.deepEqual(result.records[2],{completed:true,stars:2,score:18000,bestTime:100});
  assert.equal(unlocked(3,result),false);
});

test('each playable level has its own star targets',()=>{
  assert.equal(levelStars(60,20000,8,LEVELS[0].thresholds),3);
  assert.equal(levelStars(60,20000,8,LEVELS[1].thresholds),2);
});
