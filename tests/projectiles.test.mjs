import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CandyProjectiles } from '../src/projectiles.ts';

test('all weapon modes create visible ammunition and return it to a bounded pool', () => {
  const scene = new THREE.Scene();
  const shots = new CandyProjectiles(scene);
  const modes = ['normal', 'rush', 'storm', 'pierce', 'rocks', 'gum', 'laser'];
  for (const mode of modes) shots.spawn(new THREE.Vector3(0, 2, 4), new THREE.Vector3(0, 2, -15), mode);
  assert.equal(shots.count, modes.length);
  assert.equal(scene.children.length, modes.length);
  assert.ok(scene.children.every(group => group.children.length > 0));
  shots.update(1);
  assert.equal(shots.count, 0);
  assert.equal(scene.children.length, 0);
  assert.equal(shots.pooledCount, modes.length);

  for (let i = 0; i < 200; i++) shots.spawn(new THREE.Vector3(), new THREE.Vector3(0, 0, -20), 'normal');
  assert.equal(shots.count, shots.limit);
  assert.equal(scene.children.length, shots.limit);
  shots.clear();
  assert.equal(shots.count, 0);
  assert.equal(scene.children.length, 0);
});
