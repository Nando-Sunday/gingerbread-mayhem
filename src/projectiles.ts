import * as THREE from 'three';
import type { Upgrade } from './rules';

export type ShotMode = Upgrade | 'normal';
type FlyingCandy = { object: THREE.Group; from: THREE.Vector3; to: THREE.Vector3; age: number; duration: number; mode: ShotMode };

const ball = new THREE.SphereGeometry(.18, 12, 9);
const smallBall = new THREE.SphereGeometry(.075, 10, 7);
const bigBall = new THREE.SphereGeometry(.32, 16, 11);
const ring = new THREE.TorusGeometry(.14, .037, 7, 16);
const crystal = new THREE.OctahedronGeometry(.18, 0);
const stick = new THREE.CylinderGeometry(.045, .045, .62, 8);
const beam = new THREE.CylinderGeometry(.065, .065, 1, 8);
const halo = new THREE.CylinderGeometry(.17, .17, 1, 8);
const candyColors = [0xff3158, 0x00e4d8, 0xffc826, 0xff5eae, 0x8adf39];
const candies = candyColors.map(color => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .45, metalness: .12, roughness: .16 }));
const white = new THREE.MeshStandardMaterial({ color: 0xfff7d8, roughness: .21, metalness: .1 });
const gem = new THREE.MeshStandardMaterial({ color: 0xff5d37, emissive: 0xff3a17, emissiveIntensity: .8, metalness: .18, roughness: .15 });
const gum = new THREE.MeshStandardMaterial({ color: 0xff60ae, emissive: 0xff4a9d, emissiveIntensity: .42, transparent: true, opacity: .68, metalness: .05, roughness: .09, depthWrite: false });
const beamCore = new THREE.MeshBasicMaterial({ color: 0xe4fff3, transparent: true, opacity: .98, depthWrite: false });
const beamHalo = new THREE.MeshBasicMaterial({ color: 0x1df5db, transparent: true, opacity: .35, depthWrite: false });

export class CandyProjectiles {
  private active: FlyingCandy[] = [];
  private pool = new Map<ShotMode, THREE.Group[]>();
  private serial = 0;
  private scene: THREE.Scene;
  readonly limit = 72;

  constructor(scene: THREE.Scene) { this.scene = scene; }

  get count() { return this.active.length; }
  get pooledCount() { return [...this.pool.values()].reduce((sum, items) => sum + items.length, 0); }

  private create(mode: ShotMode): THREE.Group {
    const group = new THREE.Group();
    if (mode === 'laser') {
      const outer = new THREE.Mesh(halo, beamHalo);
      const inner = new THREE.Mesh(beam, beamCore);
      group.add(outer, inner);
      group.userData.outer = outer;
      group.userData.inner = inner;
      return group;
    }
    const spinner = new THREE.Group();
    group.add(spinner);
    group.userData.spinner = spinner;
    if (mode === 'pierce') {
      const candy = new THREE.Mesh(ball, candies[3]);
      candy.scale.set(1.35, 1.35, .55);
      candy.position.z = -.25;
      spinner.add(candy);
      const swirl = new THREE.Mesh(ring, white);
      swirl.position.z = -.34;
      spinner.add(swirl);
      const handle = new THREE.Mesh(stick, white);
      handle.rotation.x = Math.PI / 2;
      handle.position.z = .16;
      spinner.add(handle);
    } else if (mode === 'rocks') {
      spinner.add(new THREE.Mesh(crystal, gem));
      for (let i = 0; i < 4; i++) {
        const shard = new THREE.Mesh(smallBall, candies[i]);
        const a = i * Math.PI / 2;
        shard.position.set(Math.sin(a) * .19, Math.cos(a) * .19, .08);
        spinner.add(shard);
      }
    } else if (mode === 'gum') {
      spinner.add(new THREE.Mesh(bigBall, gum));
      const highlight = new THREE.Mesh(smallBall, white);
      highlight.position.set(-.12, .15, -.22);
      spinner.add(highlight);
    } else {
      const candy = new THREE.Mesh(ball, candies[0]);
      if (mode === 'rush') candy.scale.setScalar(.82);
      if (mode === 'storm') candy.scale.set(1.22, 1.22, .82);
      const stripe = new THREE.Mesh(ring, mode === 'rush' ? candies[2] : white);
      stripe.rotation.x = Math.PI / 2;
      if (mode === 'storm') stripe.rotation.y = Math.PI / 4;
      const tail = new THREE.Mesh(smallBall, mode === 'rush' ? candies[2] : candies[1]);
      tail.position.z = mode === 'rush' ? .32 : .23;
      if (mode === 'rush') tail.scale.set(1.1, 1.1, 2.1);
      spinner.add(candy, stripe, tail);
      group.userData.candy = candy;
      group.userData.tail = tail;
    }
    group.traverse(node => { if (node instanceof THREE.Mesh) node.castShadow = false; });
    return group;
  }

  private release(index: number) {
    const shot = this.active[index];
    this.scene.remove(shot.object);
    let bucket = this.pool.get(shot.mode);
    if (!bucket) { bucket = []; this.pool.set(shot.mode, bucket); }
    bucket.push(shot.object);
    this.active.splice(index, 1);
  }

  spawn(from: THREE.Vector3, to: THREE.Vector3, mode: ShotMode) {
    if (this.active.length >= this.limit) this.release(0);
    const bucket = this.pool.get(mode);
    const object = bucket?.pop() ?? this.create(mode);
    const index = this.serial++ % candies.length;
    if (object.userData.candy) {
      object.userData.candy.material = mode === 'rush' ? candies[2] : mode === 'storm' ? candies[(index + 1) % candies.length] : candies[index];
      object.userData.tail.material = mode === 'rush' ? candies[0] : candies[(index + 2) % candies.length];
    }
    object.scale.setScalar(1);
    const distance = from.distanceTo(to);
    const duration = mode === 'laser' ? .115 : mode === 'rush' ? Math.min(.16, .06 + distance / 400) : Math.min(.24, .085 + distance / 300);
    if (mode === 'laser') {
      const direction = to.clone().sub(from).normalize();
      object.position.copy(from).add(to).multiplyScalar(.5);
      object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
      object.userData.outer.scale.y = distance;
      object.userData.inner.scale.y = distance;
    } else {
      object.position.copy(from);
      object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), to.clone().sub(from).normalize());
    }
    this.scene.add(object);
    this.active.push({ object, from: from.clone(), to: to.clone(), age: 0, duration, mode });
  }

  update(dt: number) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const shot = this.active[i];
      shot.age += dt;
      const t = Math.min(1, shot.age / shot.duration);
      if (shot.mode === 'laser') shot.object.scale.setScalar(t > .7 ? Math.max(.01, (1 - t) / .3) : 1);
      else {
        shot.object.position.lerpVectors(shot.from, shot.to, t);
        shot.object.userData.spinner.rotation.z += dt * (shot.mode === 'pierce' ? 28 : shot.mode === 'rocks' ? 17 : 11);
        shot.object.scale.setScalar(t > .78 ? Math.max(.01, (1 - t) / .22) : 1);
      }
      if (t >= 1) this.release(i);
    }
  }

  clear() { while (this.active.length) this.release(this.active.length - 1); }
}
