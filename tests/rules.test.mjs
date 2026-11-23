import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progress, stars, unsupported, remainingSupports, pointerAimDelta, fallbackAimPosition, shotInterval, damageFor, GAME_SECONDS } from '../src/rules.ts';

test('required destruction reaches exactly 100 percent', () => {
  const required = Array.from({ length: 91 }, (_, i) => i);
  const destroyed = new Set();
  for (const id of required) destroyed.add(id);
  assert.equal(progress(destroyed.size, required.length), 100);
  assert.equal(progress(destroyed.size - 1, required.length), 99);
});

test('a support chain releases only when all listed supports fail', () => {
  assert.equal(unsupported([1, 2], new Set([1])), false);
  assert.equal(unsupported([1, 2], new Set([1, 2])), true);
  assert.equal(remainingSupports([1, 2, 3, 4], new Set([1, 2])), 2);
  assert.equal(unsupported([1, 2, 3, 4], new Set([1, 2]), 3), true);
  assert.equal(unsupported([], new Set()), false);
});

test('mouse movement aims in the expected directions', () => {
  const right=pointerAimDelta(50,0), up=pointerAimDelta(0,-50);
  assert.ok(right.yaw<0); // Three.js negative yaw looks right.
  assert.ok(up.pitch>0); // Three.js positive pitch looks up.
  assert.ok(fallbackAimPosition(900,450,1440,900).yaw<0);
  assert.ok(fallbackAimPosition(720,200,1440,900).pitch>0);
});

test('stars and firing upgrades use reachable, distinct rules', () => {
  assert.equal(stars(0, 100, 0), 1);
  assert.equal(stars(40, 12000, 2), 2);
  assert.equal(stars(65, 22000, 9), 3);
  assert.ok(GAME_SECONDS > 100);
  assert.ok(shotInterval('rush') < shotInterval(null));
  assert.ok(damageFor('glass') > damageFor('chocolate'));
});
