import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { CandyProjectiles, type ShotMode } from './projectiles';
import { UPGRADE_SECONDS, damageFor, fallbackAimPosition, pointerAimDelta, progress, remainingSupports, shotInterval, unsupported, type Material, type Upgrade } from './rules';
import { LEVELS, PROGRESS_KEY, emptyProgress, levelStars, parseProgress, recordVictory, unlocked, type KingdomProgress, type LevelId } from './levels';
import './style.css';

type Piece = { id:number; group:THREE.Group; core:THREE.Mesh; cracks:THREE.Group; damageStage:number; weakSpot:THREE.Vector3|null; body:RAPIER.RigidBody; half:THREE.Vector3; material:Material; hp:number; maxHp:number; supports:number[]; minimumSupports:number; supportLoss:number; required:boolean; destroyed:boolean; fallen:boolean; impactDone:boolean; previousVy:number };
type FX = { mesh:THREE.Object3D; life:number; max:number; velocity?:THREE.Vector3; recycle?:'particle'|'flash'; baseScale?:number; spark?:boolean };
type Debris = { mesh:THREE.Mesh; body:RAPIER.RigidBody; life:number };
type Pickup = { mesh:THREE.Group; kind:Upgrade; taken:boolean; phase:number };
type DamageEvent = { id:number; amount:number; point:THREE.Vector3; chain:boolean };

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `<canvas id="scene"></canvas><div class="vignette"></div><div class="hud" id="hud"><div class="topbar"><div class="brand-small">GINGERBREAD <span>MAYHEM</span><small id="leveltitle"></small></div><div class="hud-center"><div class="pill timer" id="timerbox"><small>TIME LEFT</small><strong id="timer">2:00</strong></div><div class="pill"><small>SCORE</small><strong id="score">0</strong></div></div><div class="icon-buttons"><button class="icon-btn" id="sound" aria-label="Toggle sound" title="Sound">♪</button><button class="icon-btn" id="shake" aria-label="Toggle camera shake" title="Camera shake">✧</button><button class="icon-btn" id="pause" aria-label="Pause" title="Pause">Ⅱ</button></div></div><div class="crosshair" id="crosshair"><b></b></div><div class="message" id="message"></div><div class="bottom-left"><div class="meter"><div class="row"><span>CASTLE DESTROYED</span><strong id="progress">0%</strong></div><div class="track"><div class="fill" id="progressfill"></div></div></div><div class="combo" id="combo"></div></div><div class="upgrade" id="upgrade"><small>ACTIVE POWER-UP</small><strong id="upgradename"></strong><div class="track"><div class="fill" id="upgradefill"></div></div></div></div><div class="toast" id="toast"></div><div class="overlay" id="overlay"><div class="menu-card"><h1>LOADING...</h1></div></div>`;
const $ = <T extends HTMLElement>(id:string) => document.getElementById(id) as T;

let world:RAPIER.World;
let renderer:THREE.WebGLRenderer;
let scene:THREE.Scene;
let camera:THREE.PerspectiveCamera;
let skyGeometry:THREE.SphereGeometry,sunLight:THREE.DirectionalLight,fillLight:THREE.PointLight;
let ambientClouds:THREE.Group[]=[],ambientGears:THREE.Group[]=[],ambientSparkles:THREE.InstancedMesh|null=null,ambientClock=0,ambientUpdateAccum=0;
const ambientDummy=new THREE.Object3D();
let weapon:THREE.Group;
let barrelCluster:THREE.Group;
let muzzle:THREE.Object3D;
let muzzleFlash:THREE.Mesh;
let modeLamp:THREE.Mesh;
let projectiles:CandyProjectiles;
let pieces:Piece[]=[];
let pickups:Pickup[]=[];
let fx:FX[]=[];
let particlePool:THREE.Mesh[]=[];
let flashPool:THREE.Mesh[]=[];
let debris:Debris[]=[];
let rayTargets:THREE.Object3D[]=[];
let castleDecor:THREE.Object3D[]=[];
let destroyed = new Set<number>();
let pendingDamage:DamageEvent[]=[];
let supportDirty=false;
const MAX_DAMAGE_PER_FRAME=20,MAX_BREAKS_PER_FRAME=4,MAX_SUPPORT_RELEASES=8,MAX_PENDING_DAMAGE=512;
let physicsStepMs=0,physicsStepMaxMs=0,impactEventsFrame=0,damageProcessedFrame=0,breaksFrame=0,supportReleasesFrame=0,droppedDamage=0,activeAudioNodes=0,explosions=0;
let state:'menu'|'map'|'selected'|'playing'|'paused'|'won'|'lost'='menu';
let currentLevel:LevelId=1,selectedLevel:LevelId=1,kingdomProgress:KingdomProgress=emptyProgress();
let justUnlockedLevel2=false;
let time=LEVELS[0].seconds, score=0, combo=0, bestCombo=0, comboClock=0, active:Upgrade|null=null, upgradeClock=0;
let yaw=0, pitch=-0.02, firing=false, fireClock=0, spin=0, recoil=0, shake=0, totalRequired=0, destroyedRequired=0, slowClock=0;
let soundOn=true, shakeOn=true, audio:AudioContext|null=null, lastTime=0, physicsAccum=0, messageClock=0, toastClock=0, hitClock=0, shotCount=0;
let audioNoise:AudioBuffer|null=null,lastImpactAudio=-1;
let motorOsc:OscillatorNode|null=null,motorGain:GainNode|null=null;
let motorUpdateClock=0;
let fallbackAim=false;
let lifetimeShots=0,perfEl:HTMLDivElement|null=null,perfFrames=0,perfSeconds=0,perfMaxFrame=0;
let stressActive=false,stressStart=0,stressShotStart=0,stressFrames=0,stressFrameMs=0,stressRestarts=0,stressPeakShots=0,stressPeakBodies=0,stressPeakParticles=0,stressPeakGeometry=0,stressBaselineGeometry=0,stressPeakPhysics=0,stressPeakQueue=0,stressPeakAudio=0,stressImpactEvents=0,stressBreaks=0,stressExplosionStart=0,stressModeIndex=0,stressDroppedDamage=0;
let stressButton:HTMLButtonElement|null=null;
const mat:Record<Material,THREE.MeshStandardMaterial> = {
  gingerbread:new THREE.MeshStandardMaterial({color:0xffffff,roughness:.77}),
  chocolate:new THREE.MeshStandardMaterial({color:0xffffff,roughness:.24,metalness:.08}),
  glass:new THREE.MeshStandardMaterial({color:0x36e6e7,roughness:.08,metalness:.12,transparent:true,opacity:.84,emissive:0x009cad,emissiveIntensity:.26}),
  candy:new THREE.MeshStandardMaterial({color:0xf72d5b,roughness:.09,metalness:.1,emissive:0x4e071b,emissiveIntensity:.2}),
  marshmallow:new THREE.MeshStandardMaterial({color:0xffe8e9,roughness:.72}),
  frosting:new THREE.MeshStandardMaterial({color:0xfff7df,roughness:.28}),
  wafer:new THREE.MeshStandardMaterial({color:0xffffff,roughness:.57}),
  caramel:new THREE.MeshStandardMaterial({color:0xa64c12,roughness:.21,metalness:.04,emissive:0x4f1700,emissiveIntensity:.06})
};
const mint = new THREE.MeshStandardMaterial({color:0x00ccb7,roughness:.18,metalness:.12,emissive:0x005b52,emissiveIntensity:.1});
const brass = new THREE.MeshStandardMaterial({color:0xffc345,roughness:.23,metalness:.68});
const copper = new THREE.MeshStandardMaterial({color:0xb55b36,roughness:.25,metalness:.68});
const darkWood = new THREE.MeshStandardMaterial({color:0x563925,roughness:.79});
const darkCrack = new THREE.LineBasicMaterial({color:0x5d3026,transparent:true,opacity:.8});
const glassCrack = new THREE.LineBasicMaterial({color:0x196985,transparent:true,opacity:.8});
const enamel = new THREE.MeshStandardMaterial({color:0x005f76,roughness:.23,metalness:.42});
const pink = new THREE.MeshStandardMaterial({color:0xff4e9b,roughness:.18,metalness:.04});
const lime = new THREE.MeshStandardMaterial({color:0x7fd229,roughness:.27,metalness:.04});
const gold = new THREE.MeshStandardMaterial({color:0xffc62c,roughness:.22,metalness:.08});
const windowGlow = new THREE.MeshStandardMaterial({color:0xffd873,emissive:0xff9a24,emissiveIntensity:.45,roughness:.16,metalness:.05});
const groundMat = new THREE.MeshStandardMaterial({color:0x55b868,roughness:.93});
const sugarMat = new THREE.MeshStandardMaterial({color:0xfff3d5,roughness:.72});
const crystalMat=new THREE.MeshStandardMaterial({color:0xa4f7fb,emissive:0x155b83,emissiveIntensity:.14,roughness:.11,metalness:.12,flatShading:true});
const lilacCrystal=new THREE.MeshStandardMaterial({color:0xd6a5ff,emissive:0x60368b,emissiveIntensity:.1,roughness:.13,metalness:.1,flatShading:true});
const berryGlaze=new THREE.MeshStandardMaterial({color:0xe94f84,roughness:.13,metalness:.06});
const cocoaStream=new THREE.MeshStandardMaterial({color:0x76362a,roughness:.18,metalness:.1,side:THREE.DoubleSide});
const sideHillRose=new THREE.MeshStandardMaterial({color:0xf1a2b4,roughness:.74});
const sideHillPeach=new THREE.MeshStandardMaterial({color:0xf3ca98,roughness:.75});
function cookieTexture(){const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#c77a3f';ctx.fillRect(0,0,128,128);let seed=123456;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};for(let i=0;i<850;i++){const x=rand()*128,y=rand()*128,r=.2+rand()*1.6;ctx.fillStyle=i%5===0?'rgba(255,233,175,.33)':'rgba(95,39,23,.13)';ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();}const tex=new THREE.CanvasTexture(canvas);tex.colorSpace=THREE.SRGBColorSpace;tex.wrapS=tex.wrapT=THREE.RepeatWrapping;tex.repeat.set(1.5,1.5);return tex;}
mat.gingerbread.map=cookieTexture();mat.gingerbread.bumpMap=mat.gingerbread.map;mat.gingerbread.bumpScale=.035;mat.gingerbread.needsUpdate=true;
function chocolateTexture(){const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const ctx=canvas.getContext('2d')!;const grad=ctx.createLinearGradient(0,0,128,128);grad.addColorStop(0,'#7c3c31');grad.addColorStop(.5,'#56221f');grad.addColorStop(1,'#8c4934');ctx.fillStyle=grad;ctx.fillRect(0,0,128,128);let seed=78931;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};for(let i=0;i<160;i++){ctx.strokeStyle=i%3?'rgba(26,9,12,.09)':'rgba(255,199,143,.08)';ctx.lineWidth=.5+rand()*1.3;ctx.beginPath();const y=rand()*128;ctx.moveTo(0,y);ctx.bezierCurveTo(38,y+rand()*8,70,y-rand()*8,128,y+rand()*4);ctx.stroke();}const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;return texture;}
mat.chocolate.map=chocolateTexture();mat.chocolate.bumpMap=mat.chocolate.map;mat.chocolate.bumpScale=.024;
function waferTexture(){const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#f6cd83';ctx.fillRect(0,0,128,128);ctx.strokeStyle='#b8793f';ctx.lineWidth=4;for(let n=-128;n<256;n+=18){ctx.beginPath();ctx.moveTo(n,0);ctx.lineTo(n+128,128);ctx.stroke();ctx.beginPath();ctx.moveTo(n,128);ctx.lineTo(n+128,0);ctx.stroke();}const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;return texture;}
mat.wafer.map=waferTexture();mat.wafer.bumpMap=mat.wafer.map;mat.wafer.bumpScale=.025;
const glowMats:Record<Upgrade,THREE.MeshStandardMaterial> = {
  rush:new THREE.MeshStandardMaterial({color:0xffd65c,emissive:0xffaa2b,emissiveIntensity:1.5,roughness:.25}),
  storm:new THREE.MeshStandardMaterial({color:0x8de9e6,emissive:0x3acbc7,emissiveIntensity:1.5,roughness:.25}),
  pierce:new THREE.MeshStandardMaterial({color:0xc88dff,emissive:0x8844d5,emissiveIntensity:1.5,roughness:.25}),
  rocks:new THREE.MeshStandardMaterial({color:0xff817b,emissive:0xd94552,emissiveIntensity:1.5,roughness:.25}),
  gum:new THREE.MeshStandardMaterial({color:0xffaacc,emissive:0xe84e97,emissiveIntensity:1.5,roughness:.25}),
  laser:new THREE.MeshStandardMaterial({color:0x8cffff,emissive:0x36f4e9,emissiveIntensity:1.8,roughness:.2})
};
const labels:Record<Upgrade,string>={rush:'SUGAR RUSH',storm:'CANDY STORM',pierce:'PIERCING LOLLIPOP',rocks:'POP ROCKS',gum:'BUBBLE GUM BOMB',laser:'SUGAR LASER'};
const modeColors:Record<ShotMode,number>={normal:0xffd06a,rush:0xffd426,storm:0x14f1df,pierce:0xd367ff,rocks:0xff552c,gum:0xff59ab,laser:0x65fff0};
const v=(x:number,y:number,z:number)=>new THREE.Vector3(x,y,z);
function mesh(geo:THREE.BufferGeometry, material:THREE.Material, parent:THREE.Object3D, x=0,y=0,z=0){const m=new THREE.Mesh(geo,material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
function disposeObject(object:THREE.Object3D,disposeMaterials=false){object.traverse(child=>{if(child instanceof THREE.Mesh||child instanceof THREE.LineSegments){child.geometry.dispose();if(disposeMaterials){const materials=Array.isArray(child.material)?child.material:[child.material];for(const material of materials){if(material instanceof THREE.MeshBasicMaterial&&material.map)material.map.dispose();material.dispose();}}}});}
function disposeCoreMaterial(p:Piece){const material=p.core.material;if(!Array.isArray(material)&&material!==mat[p.material])material.dispose();}
function box(parent:THREE.Object3D, material:THREE.Material, sx:number,sy:number,sz:number,x=0,y=0,z=0){return mesh(new THREE.BoxGeometry(sx,sy,sz),material,parent,x,y,z);}
function cylinder(parent:THREE.Object3D, material:THREE.Material, r1:number,r2:number,h:number,x=0,y=0,z=0,segments=12){return mesh(new THREE.CylinderGeometry(r1,r2,h,segments),material,parent,x,y,z);}
function sphere(parent:THREE.Object3D, material:THREE.Material,r:number,x=0,y=0,z=0){return mesh(new THREE.SphereGeometry(r,12,8),material,parent,x,y,z);}
function mergeDecorations(parent:THREE.Object3D, candidates:THREE.Mesh[],worldSpace=false){
  const groups=new Map<string,THREE.Mesh[]>();
  for(const item of candidates){if(Array.isArray(item.material))continue;const key=item.material.uuid+':'+(item.geometry.index?'indexed':'plain');const group=groups.get(key)??[];group.push(item);groups.set(key,group);}
  for(const group of groups.values()){
    if(group.length<2)continue;
    const transformed=group.map(item=>{item.updateMatrix();return item.geometry.clone().applyMatrix4(worldSpace?item.matrixWorld:item.matrix);});
    const combined=mergeGeometries(transformed);
    for(const geometry of transformed)geometry.dispose();
    if(!combined)continue;
    const merged=new THREE.Mesh(combined,group[0].material);merged.castShadow=group.some(item=>item.castShadow);merged.receiveShadow=group.some(item=>item.receiveShadow);parent.add(merged);
    for(const item of group){item.parent?.remove(item);item.geometry.dispose();}
  }
}
function mergeStaticScenery(){scene.updateMatrixWorld(true);const candidates:THREE.Mesh[]=[];scene.traverse(o=>{if(o instanceof THREE.Mesh)candidates.push(o);});mergeDecorations(scene,candidates,true);}
function mergeCastleDecor(){for(const p of pieces){const candidates=p.group.children.filter((o):o is THREE.Mesh=>o instanceof THREE.Mesh&&o!==p.core&&!rayTargets.includes(o));mergeDecorations(p.group,candidates);}}

function buildSideEnvironment(){
  for(const side of [-1,1]){
    for(let i=0;i<5;i++){
      const x=side*(28+i*10),z=23-i*16,r=5.8+(i%3)*1.2;
      const hill=sphere(scene,i%2?sideHillPeach:sideHillRose,r,x,.55,z);hill.scale.set(1.55,.53,1.14);hill.castShadow=false;
      const cap=sphere(scene,mat.frosting,r*.66,x,2.75+(i%3)*.28,z);cap.scale.set(1.4,.19,1.05);cap.castShadow=false;
    }
    const streamPoints:THREE.Vector3[]=[],leftBank:THREE.Vector3[]=[],rightBank:THREE.Vector3[]=[];
    for(let i=0;i<=26;i++){
      const z=16-i*2.35,x=side*(12.8+Math.sin(i*.46)*1.15+i*.09),width=1.05+Math.sin(i*.72)*.16;
      streamPoints.push(v(x,-.035,z));leftBank.push(v(x-width,.02,z));rightBank.push(v(x+width,.02,z));
    }
    const vertices:number[]=[],indices:number[]=[];
    for(let i=0;i<streamPoints.length;i++){vertices.push(leftBank[i].x,-.031,leftBank[i].z,rightBank[i].x,-.031,rightBank[i].z);if(i>0){const n=i*2;indices.push(n-2,n-1,n,n-1,n+1,n);}}
    const streamGeo=new THREE.BufferGeometry();streamGeo.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));streamGeo.setIndex(indices);streamGeo.computeVertexNormals();const stream=mesh(streamGeo,cocoaStream,scene);stream.castShadow=false;
    for(const bank of [leftBank,rightBank]){const curve=new THREE.CatmullRomCurve3(bank);const edging=mesh(new THREE.TubeGeometry(curve,52,.085,5,false),mat.frosting,scene);edging.castShadow=false;}
    for(let i=0;i<6;i++){
      const z=13-i*7.2,x=side*(10.25+(i%2)*1.45),crystalCount=3+(i%2);
      const mound=sphere(scene,i%2?mat.marshmallow:mat.frosting,.78+(i%3)*.16,x,.1,z);mound.scale.set(1.35,.38,.9);mound.castShadow=false;
      for(let j=0;j<crystalCount;j++){
        const gem=mesh(new THREE.OctahedronGeometry(.24+(j%2)*.1,0),j%2?lilacCrystal:crystalMat,scene,x+(j-(crystalCount-1)/2)*.37,.31+(j%2)*.13,z+(j%2)*.27);gem.scale.y=1.5+(j%3)*.35;gem.rotation.y=j*.55;gem.castShadow=false;
      }
      for(let j=0;j<5;j++){const a=j*2.4,r=.16+(j%3)*.07;const drop=sphere(scene,j%2?berryGlaze:mint,r,x+Math.sin(a)*1.15,r*.75,z+Math.cos(a)*.76);drop.scale.y=.7;drop.castShadow=false;}
    }
    for(let i=0;i<5;i++){
      const x=side*(7.2+(i%2)*1.5),z=14-i*4.5;
      const icing=sphere(scene,mat.frosting,.86+(i%3)*.13,x,.04,z);icing.scale.set(1.45,.3,.84);icing.castShadow=false;
      for(let j=0;j<4;j++){
        const a=j*Math.PI/2+i*.4,r=.28+(j%2)*.14;
        const rock=mesh(new THREE.DodecahedronGeometry(r,0),j%2?berryGlaze:mat.chocolate,scene,x+Math.sin(a)*.76,r*.8,z+Math.cos(a)*.48);rock.rotation.set(j*.3,i*.4,j*.5);rock.castShadow=false;
      }
      const crystal=mesh(new THREE.OctahedronGeometry(.24+(i%2)*.09,0),i%2?crystalMat:lilacCrystal,scene,x+side*.18,.43,z-.12);crystal.scale.y=1.9;crystal.castShadow=false;
    }
    for(let i=0;i<4;i++){
      const x=side*(9.1+(i%2)*1.25),z=8-i*6.6;
      const pole=cylinder(scene,mat.frosting,.11,.14,2.9,x,1.45,z,9);pole.castShadow=false;
      for(let band=0;band<7;band++){const stripe=cylinder(scene,berryGlaze,.143,.143,.16,x,.28+band*.39,z,9);stripe.castShadow=false;}
      const globe=sphere(scene,i%2?gold:mat.candy,.37,x,3.08,z);globe.castShadow=false;
      const halo=mesh(new THREE.TorusGeometry(.42,.065,7,16),brass,scene,x,3.08,z);halo.castShadow=false;
      sphere(scene,mat.frosting,.1,x-.14,3.21,z+.25).castShadow=false;
    }
    for(let i=0;i<3;i++){
      const x=side*(21.5+i*5.9),z=5-i*15;
      const wall=mesh(new RoundedBoxGeometry(2.2,2.6,1.8,2,.18),i%2?mat.chocolate:mat.gingerbread,scene,x,1.28,z);wall.castShadow=false;
      const roof=mesh(new THREE.ConeGeometry(1.66,1.65,8),i%2?mat.frosting:pink,scene,x,3.35,z);roof.rotation.y=.39;roof.castShadow=false;
      const rim=cylinder(scene,mat.frosting,1.48,1.48,.22,x,2.66,z,8);rim.castShadow=false;
      for(const dx of [-.55,.55]){const window=box(scene,windowGlow,.38,.64,.08,x+dx,1.52,z+ .96);window.castShadow=false;}
      sphere(scene,mat.candy,.22,x,4.3,z).castShadow=false;
      for(let j=0;j<3;j++){const bush=sphere(scene,j%2?mint:berryGlaze,.42,x+(j-1)*1.15,.4,z+.95);bush.castShadow=false;}
    }
    for(let i=0;i<3;i++){
      const x=side*(31+i*8),z=-39-i*9;
      const mountain=mesh(new THREE.ConeGeometry(5.2+i*.55,13+i*2,7),i%2?mat.chocolate:mat.wafer,scene,x,5.0,z);mountain.rotation.y=.25+i*.3;mountain.castShadow=false;
      const cap=mesh(new THREE.ConeGeometry(2.18+i*.22,3.1,7),mat.frosting,scene,x,11.0+i*.82,z);cap.rotation.y=.25+i*.3;cap.castShadow=false;
    }
    const pedestalX=side*17,pedestalZ=-5.5;
    const base=cylinder(scene,enamel,1.1,1.32,.65,pedestalX,.35,pedestalZ,12);base.castShadow=false;
    cylinder(scene,copper,.72,.83,1.15,pedestalX,1.17,pedestalZ,12).castShadow=false;
    sphere(scene,mat.glass,.33,pedestalX,2.05,pedestalZ).castShadow=false;
  }
}
function addAmbientEnvironment(){
  const cloudMat=new THREE.MeshStandardMaterial({color:0xffe2ec,roughness:.83,emissive:0x94506c,emissiveIntensity:.055});
  const puffGeo=new THREE.SphereGeometry(1,10,8);
  for(let i=0;i<5;i++){
    const group=new THREE.Group();group.position.set(-31+i*15,13.8+(i%3)*2.2,-42-(i%2)*8);group.userData.baseX=group.position.x;group.userData.baseY=group.position.y;scene.add(group);ambientClouds.push(group);
    for(let j=0;j<5;j++){const puff=new THREE.Mesh(puffGeo,cloudMat);puff.position.set((j-2)*1.35,Math.sin(j*1.8)*.37,0);puff.scale.set(1.55+(j%2)*.4,.8+(j%3)*.11,1.1);puff.castShadow=false;group.add(puff);}
  }
  for(const side of [-1,1]){
    const group=new THREE.Group();group.position.set(side*17,1.25,-5.5);scene.add(group);ambientGears.push(group);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(.73,.16,7,16),copper);ring.castShadow=false;group.add(ring);
    const hub=new THREE.Mesh(new THREE.SphereGeometry(.25,10,8),enamel);hub.castShadow=false;group.add(hub);
    for(let i=0;i<8;i++){const tooth=new THREE.Mesh(new THREE.BoxGeometry(.2,.27,.16),brass);const angle=i*Math.PI/4;tooth.position.set(Math.sin(angle)*.79,Math.cos(angle)*.79,0);tooth.rotation.z=-angle;tooth.castShadow=false;group.add(tooth);}
  }
  ambientSparkles=new THREE.InstancedMesh(new THREE.OctahedronGeometry(.12,0),new THREE.MeshBasicMaterial({color:0xfff5b7,transparent:true,opacity:.75,depthWrite:false}),36);
  ambientSparkles.castShadow=false;ambientSparkles.frustumCulled=false;scene.add(ambientSparkles);updateAmbientSparkles(0);
}
function updateAmbientSparkles(t:number){if(!ambientSparkles)return;for(let i=0;i<36;i++){const side=i%2?1:-1,x=side*(9.6+(i%9)*2.35),z=9-Math.floor(i/9)*12.5;ambientDummy.position.set(x,1.5+(i%5)*.58+Math.sin(t*.75+i*2.3)*.23,z);ambientDummy.rotation.set(t*.35+i,t*.21,t*.17);ambientDummy.scale.setScalar(.55+(Math.sin(t*1.6+i*1.7)+1)*.28);ambientDummy.updateMatrix();ambientSparkles.setMatrixAt(i,ambientDummy.matrix);}ambientSparkles.instanceMatrix.needsUpdate=true;}

function initScene(){
  scene=new THREE.Scene();scene.background=new THREE.Color(0x42cce9);scene.fog=new THREE.FogExp2(0x58d2e6,.011);
  skyGeometry=new THREE.SphereGeometry(115,32,16);const positions=skyGeometry.getAttribute('position'),colors=new Float32Array(positions.count*3),horizon=new THREE.Color(0x8beef0),zenith=new THREE.Color(0x126bc2);
  for(let i=0;i<positions.count;i++){const t=THREE.MathUtils.smoothstep(positions.getY(i),-18,87),color=horizon.clone().lerp(zenith,t);colors[i*3]=color.r;colors[i*3+1]=color.g;colors[i*3+2]=color.b;}
  skyGeometry.setAttribute('color',new THREE.BufferAttribute(colors,3));const sky=new THREE.Mesh(skyGeometry,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.BackSide,depthWrite:false,fog:false}));sky.castShadow=false;scene.add(sky);
  camera=new THREE.PerspectiveCamera(67,innerWidth/innerHeight,.08,160);camera.position.set(0,3.0,16);
  renderer=new THREE.WebGLRenderer({canvas:$<HTMLCanvasElement>('scene'),antialias:true,powerPreference:'high-performance'});
  renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,1.6));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.14;
  scene.add(new THREE.HemisphereLight(0xfff1d8,0x3192aa,1.65));
  sunLight=new THREE.DirectionalLight(0xffecba,3.1);sunLight.position.set(-10,23,9);sunLight.castShadow=true;sunLight.shadow.mapSize.set(2048,2048);sunLight.shadow.camera.left=-30;sunLight.shadow.camera.right=30;sunLight.shadow.camera.top=27;sunLight.shadow.camera.bottom=-27;sunLight.shadow.normalBias=.035;scene.add(sunLight);
  fillLight=new THREE.PointLight(0x3af8e6,12,43);fillLight.position.set(11,10,-20);scene.add(fillLight);
  const floor=box(scene,groundMat,200,.8,200,0,-.5,0);floor.castShadow=false;
  const path=box(scene,sugarMat,9,.025,46,0,-.07,2);
  for(let i=0;i<18;i++){const z=14-i*2.6;box(scene,i%2?pink:mat.candy,7.7,.035,.18,0,-.045,z);}
  const water=new THREE.MeshStandardMaterial({color:0x00c9e3,roughness:.19,metalness:.24,emissive:0x008baa,emissiveIntensity:.15});
  box(scene,water,200,.025,5.5,0,-.03,6);
  box(scene,sugarMat,9.6,.23,6.1,0,.10,6);
  for(let i=0;i<7;i++)box(scene,i%2?pink:mint,9.4,.035,.25,0,.235,3.4+i*.83);
  for(const side of [-1,1])for(let i=0;i<5;i++){
    const post=cylinder(scene,mat.frosting,.08,.1,.75,side*4.75,.58,3.45+i*1.3);post.castShadow=false;
    sphere(scene,i%2?mat.candy:gold,.17,side*4.75,.99,3.45+i*1.3);
  }
  const cloudA=new THREE.MeshStandardMaterial({color:0xfff8f5,roughness:1,emissive:0xffffff,emissiveIntensity:.12}),cloudB=new THREE.MeshStandardMaterial({color:0xffeaf4,roughness:1,emissive:0xffcbe1,emissiveIntensity:.08});
  for(let i=0;i<7;i++){const group=new THREE.Group();group.position.set(-43+i*14,14+(i%3)*2.3,-57-(i%2)*9);scene.add(group);for(let j=0;j<6;j++){const puff=sphere(group,j%3?cloudA:cloudB,2.3+(j%2)*.7,(j-2.5)*1.65,Math.sin(j*1.7)*.8,0);puff.scale.y=.74;puff.castShadow=false;}}
  for(let side of [-1,1])for(let i=0;i<17;i++){
    let z=18-i*3.9;let x=side*(8.5+Math.sin(i*3.7)*1.8);const bush=new THREE.Group();bush.position.set(x,0,z);scene.add(bush);
    cylinder(bush,darkWood,.13,.16,.48,0,.22,0,7);
    for(let j=0;j<3;j++)sphere(bush,j%3===0?pink:j%3===1?mint:lime,.58+(j%2)*.16,Math.sin(j*2)*.25,.65+j*.27,Math.cos(j*2)*.2);
    for(let j=0;j<5;j++)sphere(bush,j%2?gold:mat.frosting,.075,Math.sin(j*2.1)*.41,1.16+Math.sin(j)*.25,Math.cos(j*2.1)*.4);
  }
  for(let side of [-1,1])for(let i=0;i<7;i++){
    const x=side*(14+i*2.7),z=-27+i*7;const base=cylinder(scene,mat.gingerbread,1.1,1.4,1.3,x,.45,z,8);base.rotation.y=.4;
    cylinder(scene,mat.frosting,.94,1.03,.18,x,1.12,z,8);
    cylinder(scene,mint,.75,.9,1.2,x,1.78,z,8);
    const top=mesh(new THREE.ConeGeometry(.9,1.4,8),i%2?pink:gold,scene,x,3.05,z);top.rotation.y=.4;
  }
  for(const side of [-1,1])for(let tree=0;tree<2;tree++){
    const x=side*(tree?23:15),z=tree?-23:1;
    const trunk=cylinder(scene,darkWood,.35,.52,3.7,x,1.85,z,10);trunk.rotation.z=side*.08;
    const crown=new THREE.Group();crown.position.set(x,4.35,z);scene.add(crown);
    for(let layer=0;layer<3;layer++)for(let j=0;j<8;j++){
      const a=j*Math.PI/4+layer*.2,r=layer===2?.65:1.12;
      const color=(j+layer+tree)%3===0?pink:(j+layer+tree)%3===1?mat.candy:mint;
      sphere(crown,color,.72,Math.sin(a)*r,layer*.56,Math.cos(a)*r);
    }
    sphere(crown,tree?gold:pink,1.05,0,1.62,0);
    cylinder(scene,brass,.08,.08,3.9,x,4.7,z);
    sphere(scene,gold,.25,x,6.75,z);
  }
  for(let side of [-1,1])for(let i=0;i<29;i++){
    const x=side*(10.8+(i%5)*1.9),z=-27+i*1.9,r=.16+(i%4)*.07;
    const drop=sphere(scene,i%4===0?pink:i%4===1?gold:i%4===2?mint:mat.candy,r,x,r-.08,z);
    drop.scale.y=.75;
  }
  for(let i=0;i<21;i++){
    const x=-34+i*3.5,y=11+(i%5)*2.5,z=-47-(i%3)*7;
    const orb=sphere(scene,i%3===0?pink:i%3===1?gold:mint,.12+(i%3)*.05,x,y,z);orb.castShadow=false;
  }
  const groundBody=world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0,-.4,0));world.createCollider(RAPIER.ColliderDesc.cuboid(100,.4,100).setFriction(.88),groundBody);
  const hillMats=[new THREE.MeshStandardMaterial({color:0xffa9b7,roughness:.65}),new THREE.MeshStandardMaterial({color:0xffd29a,roughness:.6}),new THREE.MeshStandardMaterial({color:0xb7a2ed,roughness:.58})];
  for(let i=0;i<9;i++){const x=-45+i*11,z=-39-(i%3)*9;const mound=sphere(scene,hillMats[i%3],4.5+(i%2)*1.2,x,1.6,z);mound.scale.set(1.35,.58,1);mound.castShadow=false;const icing=sphere(scene,mat.frosting,3.45+(i%2)*.7,x,3.0,z);icing.scale.set(1.3,.28,.95);icing.castShadow=false;}
  for(const side of [-1,1])for(let i=0;i<4;i++){const x=side*(13+i*4.2),z=-8-i*6;const rock=mesh(new THREE.DodecahedronGeometry(.78+(i%2)*.24,0),mat.chocolate,scene,x,.65,z);rock.rotation.set(i*.4,i*.8,i*.3);rock.castShadow=false;for(let j=0;j<3;j++){const gem=mesh(new THREE.OctahedronGeometry(.17+j*.055,0),j%2?mint:gold,scene,x+(j-1)*.4,1.3+j*.2,z+.25);gem.castShadow=false;}}
  buildSideEnvironment();
  mergeStaticScenery();
  addAmbientEnvironment();
}
function applyLevelTheme(){
  const chocolate=currentLevel===2,horizon=new THREE.Color(chocolate?0xffd0c0:0x8beef0),zenith=new THREE.Color(chocolate?0x9e62a8:0x126bc2);
  const positions=skyGeometry.getAttribute('position'),colors=skyGeometry.getAttribute('color');
  for(let i=0;i<positions.count;i++){const t=THREE.MathUtils.smoothstep(positions.getY(i),-18,87),color=horizon.clone().lerp(zenith,t);colors.setXYZ(i,color.r,color.g,color.b);}colors.needsUpdate=true;
  scene.background=new THREE.Color(chocolate?0xf5b7a6:0x42cce9);(scene.fog as THREE.FogExp2).color.setHex(chocolate?0xf0aaad:0x58d2e6);
  sunLight.color.setHex(chocolate?0xffc388:0xffecba);fillLight.color.setHex(chocolate?0xff8cbb:0x3af8e6);
  groundMat.color.setHex(chocolate?0x72bc62:0x55b868);
}

function addPiece(x:number,y:number,z:number,sx:number,sy:number,sz:number,material:Material,opts:{supports?:number[],minimumSupports?:number,hp?:number,trim?:boolean,window?:boolean,weakPoint?:boolean}={}):Piece{
  const group=new THREE.Group();group.position.set(x,y,z);scene.add(group);
  const core=mesh(new RoundedBoxGeometry(sx,sy,sz,3,.11),mat[material],group);
  if(opts.trim!==false){
    const edge=.085;const front=sz/2+.015;
    mesh(new RoundedBoxGeometry(sx+edge,.18,.2,2,.07),mat.frosting,group,0,sy/2-.05,front);
    if(sy>.65)for(const side of [-1,1])mesh(new RoundedBoxGeometry(.12,sy,.16,2,.055),mat.frosting,group,side*(sx/2-.03),0,front);
    if(material==='gingerbread'&&sx>1.3)for(let n=0;n<Math.floor(sx/.52);n++){
      const dot=sphere(group,n%4===0?pink:mat.frosting,.075,-sx/2+.3+n*.52,sy/2-.16,front+.055);dot.castShadow=false;
    }
  }
  if(opts.window){
    const frame=box(group,brass,Math.min(.8,sx*.55),Math.min(1.2,sy*.65),.09,0,.06,sz/2+.09);
    box(group,windowGlow,Math.min(.66,sx*.43),Math.min(1.04,sy*.55),.1,0,.06,sz/2+.16);
    box(group,brass,.055,Math.min(1.04,sy*.55),.13,0,.06,sz/2+.22);
    box(group,brass,Math.min(.66,sx*.43),.055,.13,0,.06,sz/2+.22);
    const arch=mesh(new THREE.TorusGeometry(Math.min(.33,sx*.215),.07,6,12,Math.PI),pink,group,0,Math.min(.53,sy*.3),sz/2+.2);arch.rotation.z=Math.PI;
    frame.castShadow=false;
  }
  if(material==='chocolate'){
    for(const side of [-1,1])box(group,brass,.07,sy*.7,.075,side*(sx/2-.15),0,sz/2+.07);
  }
  if(material==='wafer')for(const side of [-1,1])box(group,mat.chocolate,.08,sy*.82,.11,side*(sx/2-.1),0,sz/2+.08);
  if(material==='caramel'&&sx>2){for(let n=0;n<Math.min(9,Math.floor(sx/.7));n++)sphere(group,gold,.08,-sx/2+.35+n*.72,sy/2-.08,sz/2+.07);}
  const body=world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x,y,z));
  world.createCollider(RAPIER.ColliderDesc.cuboid(sx/2,sy/2,sz/2).setFriction(.72),body);
  const id=pieces.length;
  const hp=Math.round((opts.hp??(material==='glass'?45:material==='chocolate'?65:material==='marshmallow'?48:72))*1.9);
  const weakSpot=(opts.weakPoint??((opts.supports?.length??0)===0&&sy>=1.8))?new THREE.Vector3(sx*.19,-sy*.24,sz/2+.16):null;
  if(weakSpot){
    const marker=mesh(new THREE.TorusGeometry(.17,.045,6,12),brass,group,weakSpot.x,weakSpot.y,weakSpot.z);marker.castShadow=false;
    const sugar=sphere(group,pink,.07,weakSpot.x,weakSpot.y,weakSpot.z+.04);sugar.castShadow=false;
  }
  const cracks=new THREE.Group();group.add(cracks);
  const lineMat=material==='glass'?glassCrack:darkCrack;
  for(let stage=0;stage<3;stage++){
    const points:number[]=[];const branches=stage+2;
    for(let j=0;j<branches;j++){
      const ox=(j-(branches-1)/2)*Math.min(.23,sx*.18),oy=(j%2?-.08:.1)*Math.min(1,sy);
      const dx=(j%2?1:-1)*Math.min(sx*.24,.34),dy=Math.min(sy*.3,.39);
      const zf=sz/2+.11+stage*.004;
      points.push(ox,oy,zf,ox+dx*.38,oy+dy*.38,zf,ox+dx*.38,oy+dy*.38,zf,ox+dx*.76,oy+dy*.1,zf,ox+dx*.76,oy+dy*.1,zf,ox+dx,oy+dy*.74,zf);
    }
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3));const lines=new THREE.LineSegments(geometry,lineMat);lines.visible=false;cracks.add(lines);
  }
  const p:Piece={id,group,core,cracks,damageStage:0,weakSpot,body,half:v(sx/2,sy/2,sz/2),material,hp,maxHp:hp,supports:opts.supports??[],minimumSupports:opts.minimumSupports??1,supportLoss:0,required:true,destroyed:false,fallen:false,impactDone:false,previousVy:0};
  core.userData.piece=id;rayTargets.push(core);
  pieces.push(p);totalRequired++;return p;
}

function buildCastle(){if(currentLevel===2)buildChocolateCitadel();else buildGingerbreadGate();}
function buildGingerbreadGate(){
  // Front ramparts are individually breakable bricks; towers and keep use support chains.
  const frontZ=-12.8;
  for(const side of [-1,1]){
    const start=side<0?-6.5:2.2;
    const base:number[]=[];
    for(let i=0;i<4;i++){
      const p=addPiece(start+i*1.45,1.0,frontZ,1.39,1.9,.95,'gingerbread',{hp:61});base.push(p.id);
      addPiece(start+i*1.45,2.35,frontZ,1.37,.65,1,'gingerbread',{supports:[p.id],hp:50});
    }
    for(let i=0;i<4;i++)addPiece(start+i*1.45,2.95,frontZ,1.24,.48,1.04,'marshmallow',{supports:[base[i]],hp:42});
  }
  for(const x of [-8.1,8.1])for(const z of [-12.6,-21.2])buildTower(x,z);
  buildKeep();
  const gate=addPiece(0,1.35,-12.85,2.4,2.5,.75,'chocolate',{hp:100,trim:false});
  const gateArc=mesh(new THREE.TorusGeometry(1.2,.19,8,18,Math.PI),brass,gate.group,0,.83,.48);gateArc.rotation.z=Math.PI;
  for(let i=0;i<6;i++)box(gate.group,brass,.08,2.1,.07,-.9+i*.36,-.13,.42);
  addPiece(0,3.2,-12.85,2.5,.95,1.15,'gingerbread',{supports:[gate.id],hp:68});
  for(const kind of ['rush','storm','pierce','rocks','gum','laser'] as Upgrade[]){const i=(['rush','storm','pierce','rocks','gum','laser'] as Upgrade[]).indexOf(kind);addPickup(kind,[-5.1,5.1,-8.1,8.1,-2.1,2.1][i],[4.7,4.7,7.5,7.5,6.8,6.8][i],[-12.1,-12.1,-21.2,-21.2,-16,-16][i]);}
  const banner=box(scene,enamel,3.9,.74,.15,0,9.85,-13.5);castleDecor.push(banner);
  castleDecor.push(box(scene,brass,3.98,.09,.18,0,10.2,-13.5));
  const canvas=document.createElement('canvas');canvas.width=512;canvas.height=96;const ctx=canvas.getContext('2d')!;ctx.clearRect(0,0,512,96);ctx.fillStyle='#ffe9c3';ctx.font='900 57px sans-serif';ctx.textAlign='center';ctx.fillText('SUGAR LORD',256,65);const tex=new THREE.CanvasTexture(canvas);const textMat=new THREE.MeshBasicMaterial({map:tex,transparent:true});castleDecor.push(mesh(new THREE.PlaneGeometry(3.6,.68),textMat,scene,0,9.85,-13.397));
  banner.castShadow=true;
  mergeCastleDecor();
}

function buildTower(x:number,z:number){
  const legs:number[]=[];
  for(const dx of [-.8,.8])for(const dz of [-.8,.8]){
    const p=addPiece(x+dx,1.4,z+dz,.74,2.8,.74,'gingerbread',{hp:70});legs.push(p.id);
    cylinder(p.group,mat.frosting,.43,.43,.15,0,1.28,0);
    for(let band=0;band<4;band++)cylinder(p.group,band%2?pink:mat.frosting,.4,.4,.11,0,-.95+band*.55,0);
  }
  const lower=addPiece(x,3.16,z,2.9,.65,2.9,'chocolate',{supports:legs,minimumSupports:3,hp:86});
  const midWalls:number[]=[];
  for(const dx of [-.8,.8])for(const dz of [-.8,.8]){
    const p=addPiece(x+dx,4.5,z+dz,1.12,2.2,1.12,'gingerbread',{supports:[lower.id],window:dz>0,hp:69});midWalls.push(p.id);
    if(dz>0)addPiece(x+dx,5.93,z+dz,1.14,.66,1.12,'marshmallow',{supports:[p.id],hp:48});
  }
  const upper=addPiece(x,6.56,z,3.3,.48,3.3,'chocolate',{supports:midWalls,minimumSupports:3,hp:65});
  for(let i=0;i<4;i++){
    const angle=i*Math.PI/2;const p=addPiece(x+Math.sin(angle)*1.2,7.08,z+Math.cos(angle)*1.2,.82,.72,.82,'gingerbread',{supports:[upper.id],hp:43});
    sphere(p.group,mat.frosting,.18,0,.44,0);
  }
  const roof=addPiece(x,7.65,z,3.45,.48,3.45,'chocolate',{supports:[upper.id],hp:70,trim:false});
  const cone=mesh(new THREE.ConeGeometry(2.55,2.8,8),mat.chocolate,roof.group,0,1.55,0);cone.rotation.y=Math.PI/8;
  cone.userData.piece=roof.id;rayTargets.push(cone);
  for(let tier=0;tier<3;tier++)for(let tile=0;tile<10;tile++){
    const a=tile*Math.PI/5+tier*.16,r=1.92-tier*.58;
    const shingle=sphere(roof.group,(tile+tier)%3===0?pink:(tile+tier)%3===1?mint:gold,.42,Math.sin(a)*r,.75+tier*.67,Math.cos(a)*r);
    shingle.scale.set(1,.34,1.15);shingle.rotation.y=a;
  }
  cylinder(roof.group,brass,.13,.13,.65,0,3.16,0);
  sphere(roof.group,mat.candy,.25,0,3.56,0);
  for(let s of [-1,1]){
    const pole=cylinder(scene,mat.frosting,.09,.09,3,x+s*1.92,1.5,z+1.95);pole.castShadow=false;castleDecor.push(pole);
    for(let n=0;n<3;n++)castleDecor.push(cylinder(scene,mat.candy,.1,.1,.43,x+s*1.92,1.1+n*.8,z+1.95));
    castleDecor.push(sphere(scene,mat.candy,.25,x+s*1.92,3.1,z+1.95));
  }
}

function buildKeep(){
  const z=-18;
  const support:number[]=[];
  for(let row=0;row<2;row++)for(let col=0;col<4;col++){
    const p=addPiece(-3.15+col*2.1,1.25,z+(row?2:-2),1.99,2.4,.92,'gingerbread',{hp:72,window:col===1||col===2});support.push(p.id);
  }
  const slab=addPiece(0,2.65,z,8.7,.45,5.8,'chocolate',{supports:support,minimumSupports:5,hp:100});
  const middle:number[]=[];
  for(let row=0;row<2;row++)for(let col=0;col<4;col++){
    const p=addPiece(-3.15+col*2.1,4.1,z+(row?2:-2),1.99,2.4,.92,'gingerbread',{supports:[slab.id],window:col%2===0,hp:70});
    middle.push(p.id);
    if(row===1&&col<3)addPiece(-2.1+col*2.1,5.55,z+2,1.42,.5,.91,'marshmallow',{supports:[p.id],hp:46});
  }
  const cornice=addPiece(0,5.63,z,9.2,.5,6.2,'chocolate',{supports:middle,minimumSupports:5,hp:86});
  const topWalls:number[]=[];
  for(let row=0;row<2;row++)for(let col=0;col<3;col++){
    const p=addPiece(-2.75+col*2.75,6.86,z+(row?1.75:-1.75),2.56,2.05,.79,'gingerbread',{supports:[cornice.id],window:row===1,hp:65});
    topWalls.push(p.id);
    if(col===1&&row===1)box(p.group,brass,.17,1.84,.15,0,0,.52);
  }
  const roof=addPiece(0,8.12,z,9.5,.47,6.65,'chocolate',{supports:topWalls,minimumSupports:4,hp:90});
  for(let row=0;row<5;row++){
    const yy=8.48+row*.32;
    const width=4.45-row*.72;
    const r=box(roof.group,mat.chocolate,width*2,.3,6.4-row*.32,0,yy-8.12,0);r.rotation.z=row%2?.04:-.04;r.userData.piece=roof.id;rayTargets.push(r);
    box(roof.group,brass,width*2+.04,.07,6.4-row*.32,0,yy-8.3,0);
    for(let tile=0;tile<9-row;tile++){
      const x=-width+.53+tile*(width*2/(9-row));
      const shingle=sphere(roof.group,(tile+row)%3===0?pink:(tile+row)%3===1?mint:gold,.32,x,yy-8.12+.13,3.05-row*.11);
      shingle.scale.set(1.1,.32,.62);
    }
  }
  for(let sx of [-1,1]){
    const spire=addPiece(sx*3.3,9.35,z,1.12,1.6,1.12,'candy',{supports:[roof.id],hp:58,trim:false});
    const cap=mesh(new THREE.ConeGeometry(.7,1.3,8),mint,spire.group,0,1.3,0);cap.rotation.y=.4;
    sphere(spire.group,brass,.2,0,2.05,0);
  }
}

function buildChocolateCitadel(){
  // Three defensive sections share bridge supports; each can fail separately.
  const curtain:number[]=[];
  for(const side of [-1,1])for(let i=0;i<5;i++){
    const x=side*(2.55+i*1.65);
    const wall=addPiece(x,1.15,-12.6,1.57,2.25,1.15,i%3===0?'wafer':'chocolate',{hp:i%3===0?73:78,weakPoint:i===1||i===4});
    curtain.push(wall.id);
    addPiece(x,2.63,-12.6,1.55,.68,1.2,'caramel',{supports:[wall.id],hp:62,trim:false});
    const crest=addPiece(x,3.2,-12.6,1.38,.45,1.1,'wafer',{supports:[wall.id],hp:48,trim:false});
    for(const edge of [-1,1])sphere(crest.group,mat.frosting,.14,edge*.55,.26,.46);
  }
  const gate=addPiece(0,1.35,-12.4,3.15,2.65,1.15,'chocolate',{hp:115,trim:false,weakPoint:true});
  const gateRim=mesh(new THREE.TorusGeometry(1.24,.17,8,20,Math.PI),brass,gate.group,0,.72,.68);gateRim.rotation.z=Math.PI;
  for(let i=0;i<7;i++)box(gate.group,copper,.095,1.82,.08,-1.15+i*.38,-.29,.69);
  const lintel=addPiece(0,3.22,-12.55,5.1,.9,1.5,'wafer',{supports:[gate.id,curtain[0],curtain[5]],minimumSupports:2,hp:87});
  for(let i=0;i<5;i++)box(lintel.group,mat.chocolate,.16,.72,.12,-2+i,0,.83);

  const bastionDecks:number[]=[];
  for(const side of [-1,1]){
    const x=side*8.1,z=-18.2,legs:number[]=[];
    for(const dx of [-.95,.95])for(const dz of [-1.05,1.05]){
      const leg=addPiece(x+dx,1.55,z+dz,.8,3.05,.85,'wafer',{hp:84,weakPoint:dz>0});legs.push(leg.id);
      for(let stripe=0;stripe<3;stripe++)box(leg.group,mat.chocolate,.83,.11,.9,0,-.95+stripe*.88,0);
    }
    const deck=addPiece(x,3.31,z,4.1,.56,4.3,'chocolate',{supports:legs,minimumSupports:3,hp:118,trim:false});bastionDecks.push(deck.id);
    for(let edge of [-1,1]){
      const wall=addPiece(x+edge*1.33,4.54,z+1.33,1.34,1.94,.95,'chocolate',{supports:[deck.id],hp:82,window:true});
      addPiece(x+edge*1.33,5.74,z+1.33,1.44,.52,1.02,'wafer',{supports:[wall.id],hp:53,trim:false});
      const rear=addPiece(x+edge*1.33,4.54,z-1.33,1.34,1.94,.95,'caramel',{supports:[deck.id],hp:80,trim:false});
      addPiece(x+edge*1.33,5.74,z-1.33,1.44,.52,1.02,'wafer',{supports:[rear.id],hp:53,trim:false});
    }
    const roof=addPiece(x,6.23,z,4.25,.62,4.4,'chocolate',{supports:[deck.id],hp:91,trim:false});
    const dome=mesh(new THREE.CylinderGeometry(.8,2.16,2.1,8),mat.caramel,roof.group,0,1.28,0);dome.rotation.y=Math.PI/8;dome.userData.piece=roof.id;rayTargets.push(dome);
    cylinder(roof.group,brass,.16,.16,.78,0,2.66,0);
    sphere(roof.group,mat.candy,.26,0,3.08,0);
    for(let n=0;n<8;n++){const a=n*Math.PI/4;const stud=sphere(roof.group,n%2?gold:mat.frosting,.18,Math.sin(a)*1.7,.45,Math.cos(a)*1.7);stud.castShadow=false;}
  }

  const z=-23.8,foundations:number[]=[];
  for(let row=0;row<2;row++)for(let col=0;col<5;col++){
    const x=-4.2+col*2.1,zz=z+(row?2.75:-2.75);
    const wall=addPiece(x,1.38,zz,1.98,2.65,1.06,col===0||col===4?'wafer':'chocolate',{hp:row?84:94,window:row===1&&col%2===1,weakPoint:row===1&&(col===1||col===3)});
    foundations.push(wall.id);
  }
  const floor=addPiece(0,2.94,z,10.8,.55,7.2,'caramel',{supports:foundations,minimumSupports:6,hp:135,trim:false});
  const mid:number[]=[];
  for(let row=0;row<2;row++)for(let col=0;col<5;col++){
    const x=-4.2+col*2.1,zz=z+(row?2.75:-2.75);
    const wall=addPiece(x,4.28,zz,1.98,2.15,1.06,col%2?'chocolate':'wafer',{supports:[floor.id],hp:79,window:row===1&&col%2===0});mid.push(wall.id);
    if(row===1&&col%2===1)addPiece(x,5.59,zz,1.92,.56,1.05,'caramel',{supports:[wall.id],hp:56,trim:false});
  }
  const cornice=addPiece(0,5.79,z,11.3,.64,7.65,'chocolate',{supports:mid,minimumSupports:6,hp:116,trim:false});
  const upper:number[]=[];
  for(let col=0;col<4;col++){
    const x=-3.45+col*2.3;
    const wall=addPiece(x,7.08,z+2.15,2.14,2.1,1.05,'chocolate',{supports:[cornice.id],hp:85,window:true});upper.push(wall.id);
    addPiece(x,8.45,z+2.15,2.18,.55,1.07,'wafer',{supports:[wall.id],hp:55,trim:false});
  }
  const crown=addPiece(0,8.5,z,10.8,.62,6.9,'caramel',{supports:upper,minimumSupports:3,hp:116,trim:false});
  const cakeDome=mesh(new THREE.SphereGeometry(2.15,18,12),mat.chocolate,crown.group,0,1.9,-1.15);cakeDome.scale.set(1.35,.83,1.05);cakeDome.userData.piece=crown.id;rayTargets.push(cakeDome);
  for(let ring=0;ring<3;ring++){const icing=mesh(new THREE.TorusGeometry(2.03-ring*.19,.09,6,24),ring===1?pink:mat.frosting,crown.group,0,1.15+ring*.48,-1.15);icing.rotation.x=Math.PI/2;}
  sphere(crown.group,mat.candy,.33,0,3.56,-1.15);
  for(let i=0;i<4;i++){
    const x=-3.6+i*2.4;
    const tower=addPiece(x,9.54,z+1.6,1.45,1.45,1.35,i%2?'glass':'wafer',{supports:[crown.id],hp:63,trim:false});
    const cap=mesh(new THREE.ConeGeometry(.95,1.42,8),i%2?mint:mat.caramel,tower.group,0,1.34,0);cap.userData.piece=tower.id;rayTargets.push(cap);
    sphere(tower.group,brass,.17,0,2.13,0);
  }
  for(const [index,side] of [-1,1].entries()){
    const bridge=addPiece(side*5.52,3.9,-20.6,3.85,.38,1.45,'caramel',{supports:[bastionDecks[index],floor.id],minimumSupports:2,hp:85,trim:false});
    for(const rail of [-1,1])for(let i=0;i<3;i++){
      box(bridge.group,brass,.08,.55,.08,-1.28+i*1.25,.37,rail*.6);
      box(bridge.group,mat.frosting,3.65,.09,.09,0,.64,rail*.6);
    }
    const gear=mesh(new THREE.TorusGeometry(.68,.17,8,12),copper,scene,side*6.7,2.13,-14.5);gear.rotation.x=.23;castleDecor.push(gear);
    for(let i=0;i<6;i++){const a=i*Math.PI/3;castleDecor.push(box(scene,brass,.22,.1,.13,side*6.7+Math.sin(a)*.66,2.13+Math.cos(a)*.66,-14.37));}
  }
  for(const [index,side] of [-1,1].entries()){
    const x=side*13.4,z=-19.4,posts:number[]=[];
    for(const dx of [-.82,.82])for(const dz of [-.9,.9]){
      const post=addPiece(x+dx,1.44,z+dz,.76,2.82,.82,'wafer',{hp:79,weakPoint:dz>0});posts.push(post.id);
      for(let stripe=0;stripe<4;stripe++)box(post.group,mat.chocolate,.8,.09,.86,0,-1.1+stripe*.67,0);
    }
    const platform=addPiece(x,3.06,z,3.62,.52,3.94,'caramel',{supports:posts,minimumSupports:3,hp:102,trim:false});
    for(const dx of [-.85,.85])for(const dz of [-.85,.85]){
      const wall=addPiece(x+dx,4.16,z+dz,1.05,1.66,1.03,'chocolate',{supports:[platform.id],hp:77,window:dz>0});
      addPiece(x+dx,5.23,z+dz,1.07,.48,1.05,'wafer',{supports:[wall.id],hp:46,trim:false});
    }
    const drum=addPiece(x,5.76,z,3.76,.54,4.05,'chocolate',{supports:[platform.id],hp:83,trim:false});
    const cap=mesh(new THREE.CylinderGeometry(1.0,2.02,1.75,10),mat.caramel,drum.group,0,1.06,0);cap.userData.piece=drum.id;rayTargets.push(cap);
    for(let n=0;n<10;n++){const a=n*Math.PI/5;sphere(drum.group,n%2?gold:mat.frosting,.16,Math.sin(a)*1.58,.36,Math.cos(a)*1.58);}
    const chimney=addPiece(x,7.52,z,.89,1.42,.89,'glass',{supports:[drum.id],hp:62,trim:false});
    cylinder(chimney.group,copper,.51,.51,.15,0,.66,0);sphere(chimney.group,mat.candy,.25,0,1.04,0);
    const link=addPiece(side*10.75,3.48,-18.6,5.35,.32,1.28,'caramel',{supports:[platform.id,bastionDecks[index]],minimumSupports:2,hp:77,trim:false});
    for(const rail of [-1,1])box(link.group,brass,5.2,.1,.09,0,.29,rail*.5);
  }
  for(const kind of ['rush','storm','pierce','rocks','gum','laser'] as Upgrade[]){const i=(['rush','storm','pierce','rocks','gum','laser'] as Upgrade[]).indexOf(kind);addPickup(kind,[-4.6,4.6,-8.8,8.8,-1.8,1.8][i],[5.15,5.15,7.5,7.5,6.5,6.5][i],[-12,-12,-18.1,-18.1,-20,-20][i]);}
  addCastleBanner('CHOCOLATE CITADEL',-13.55,9.68);
  mergeCastleDecor();
}
function addCastleBanner(label:string,z:number,y:number){
  const backing=box(scene,enamel,5.6,.75,.15,0,y,z);castleDecor.push(backing);castleDecor.push(box(scene,brass,5.7,.11,.19,0,y+.38,z));
  const canvas=document.createElement('canvas');canvas.width=768;canvas.height=96;const ctx=canvas.getContext('2d')!;ctx.fillStyle='#fff0be';ctx.font='900 56px sans-serif';ctx.textAlign='center';ctx.fillText(label,384,65);const texture=new THREE.CanvasTexture(canvas);
  castleDecor.push(mesh(new THREE.PlaneGeometry(5.3,.68),new THREE.MeshBasicMaterial({map:texture,transparent:true}),scene,0,y,z+.1));
}

function addPickup(kind:Upgrade,x:number,y:number,z:number){
  const g=new THREE.Group();g.position.set(x,y,z);scene.add(g);
  sphere(g,glowMats[kind],.45);
  const ring=mesh(new THREE.TorusGeometry(.65,.07,7,20),brass,g);ring.rotation.x=.4;
  for(let i=0;i<7;i++){const a=i*Math.PI*2/7;sphere(g,glowMats[kind],.065,Math.sin(a)*.8,Math.cos(a)*.8,0);}
  const p:Pickup={mesh:g,kind,taken:false,phase:Math.random()*6};pickups.push(p);
  const candy=g.children[0];candy.userData.pickup=kind;rayTargets.push(candy);
}

function makeWeapon(){
  weapon=new THREE.Group();camera.add(weapon);scene.add(camera);weapon.position.set(.72,-.83,-1.45);weapon.scale.setScalar(.72);
  mesh(new RoundedBoxGeometry(.76,.61,1.76,3,.17),darkWood,weapon,0,-.12,-.05);
  box(weapon,mat.gingerbread,.64,.45,1.3,0,-.12,.25);
  mesh(new RoundedBoxGeometry(.81,.35,.83,3,.11),enamel,weapon,0,.15,-.12);
  for(let side of [-1,1]){
    box(weapon,brass,.09,.46,1.17,side*.38,-.07,.1);
    cylinder(weapon,copper,.24,.24,.14,side*.44,-.04,-.05).rotation.z=Math.PI/2;
    for(let i=0;i<7;i++){const a=i*Math.PI*2/7;sphere(weapon,brass,.038,side*.52,-.04+Math.sin(a)*.18,-.05+Math.cos(a)*.18);}
  }
  const grip=box(weapon,darkWood,.25,.74,.35,-.2,-.52,.56);grip.rotation.z=-.23;
  cylinder(weapon,brass,.42,.47,.37,0,-.02,-.44).rotation.x=Math.PI/2;
  for(const z of [-.48,.12,.58]){const bezel=mesh(new THREE.TorusGeometry(.39,.045,7,20),brass,weapon,0,-.08,z);bezel.rotation.x=Math.PI/2;}
  for(let i=0;i<5;i++){const jewel=sphere(weapon,i%2?mint:mat.candy,.065,-.26+i*.13,.34,.29);jewel.castShadow=false;}
  const vial=mesh(new THREE.SphereGeometry(.24,16,12),mat.glass,weapon,0,.49,-.15);vial.scale.set(1.12,.72,.85);vial.castShadow=false;
  const vialRing=mesh(new THREE.TorusGeometry(.22,.045,6,16),brass,weapon,0,.46,-.15);vialRing.rotation.x=Math.PI/2;
  barrelCluster=new THREE.Group();barrelCluster.position.set(0,.02,-.54);weapon.add(barrelCluster);
  for(let i=0;i<6;i++){
    const a=i*Math.PI/3, bx=Math.sin(a)*.25, by=Math.cos(a)*.25;
    const tube=cylinder(barrelCluster,copper,.095,.105,1.9,bx,by,-.88);tube.rotation.x=Math.PI/2;
    const trim=cylinder(barrelCluster,brass,.12,.12,.17,bx,by,-1.77);trim.rotation.x=Math.PI/2;
    const bore=cylinder(barrelCluster,darkWood,.055,.055,.012,bx,by,-1.87);bore.rotation.x=Math.PI/2;
  }
  for(let z of [-.35,-1.25]){const band=cylinder(barrelCluster,brass,.43,.43,.15,0,0,z);band.rotation.x=Math.PI/2;}
  for(let z of [-.78,-1.5]){const halo=mesh(new THREE.TorusGeometry(.41,.038,7,24),mint,barrelCluster,0,0,z);halo.rotation.x=Math.PI/2;}
  for(let i=0;i<6;i++){const a=i*Math.PI/3;const tip=sphere(barrelCluster,mat.candy,.052,Math.sin(a)*.25,Math.cos(a)*.25,-1.96);tip.castShadow=false;}
  muzzle=new THREE.Object3D();muzzle.position.set(0,0,-2.42);weapon.add(muzzle);
  muzzleFlash=mesh(new THREE.ConeGeometry(.19,.5,8),new THREE.MeshBasicMaterial({color:0xffdf91,transparent:true,opacity:.9,depthWrite:false}),weapon,0,0,-2.52);muzzleFlash.rotation.x=-Math.PI/2;muzzleFlash.visible=false;
  modeLamp=mesh(new THREE.TorusGeometry(.39,.075,8,24),new THREE.MeshBasicMaterial({color:modeColors.normal}),weapon,0,.02,-2.05);
  cylinder(weapon,brass,.13,.13,.62,0,.47,.25);
  sphere(weapon,mat.candy,.15,0,.82,.25);
}

function ensureAudio(){if(!audio)audio=new AudioContext();if(!audioNoise){audioNoise=audio.createBuffer(1,audio.sampleRate,audio.sampleRate);const data=audioNoise.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=Math.random()*2-1;}if(!motorOsc){motorOsc=audio.createOscillator();motorGain=audio.createGain();const filter=audio.createBiquadFilter();filter.type='lowpass';filter.frequency.value=430;motorOsc.type='sawtooth';motorOsc.frequency.value=60;motorGain.gain.value=0;motorOsc.connect(filter);filter.connect(motorGain);motorGain.connect(audio.destination);motorOsc.start();}if(audio.state==='suspended')audio.resume();}
function tone(f:number,duration:number,type:OscillatorType='sine',volume=.12,end=f*.6){if(!soundOn||!audio)return;const now=audio.currentTime;const osc=audio.createOscillator(),gain=audio.createGain();osc.type=type;osc.frequency.setValueAtTime(f,now);osc.frequency.exponentialRampToValueAtTime(Math.max(30,end),now+duration);gain.gain.setValueAtTime(volume,now);gain.gain.exponentialRampToValueAtTime(.001,now+duration);osc.connect(gain);gain.connect(audio.destination);activeAudioNodes++;osc.onended=()=>{activeAudioNodes--;osc.disconnect();gain.disconnect();};osc.start(now);osc.stop(now+duration+.01);}
function noise(duration:number,volume:number,cutoff:number){if(!soundOn||!audio||!audioNoise)return;const now=audio.currentTime,source=audio.createBufferSource(),filter=audio.createBiquadFilter(),gain=audio.createGain();source.buffer=audioNoise;source.loop=true;source.playbackRate.value=.85+Math.random()*.3;filter.type='lowpass';filter.frequency.value=cutoff;gain.gain.setValueAtTime(volume,now);gain.gain.exponentialRampToValueAtTime(.001,now+duration);source.connect(filter);filter.connect(gain);gain.connect(audio.destination);activeAudioNodes++;source.onended=()=>{activeAudioNodes--;source.disconnect();filter.disconnect();gain.disconnect();};source.start(now,Math.random()*.7);source.stop(now+duration+.01);}
function soundImpact(material:Material){if(audio&&audio.currentTime-lastImpactAudio<.025)return;if(audio)lastImpactAudio=audio.currentTime;const f=({gingerbread:210,chocolate:132,glass:1080,candy:670,marshmallow:115,frosting:450,wafer:270,caramel:190})[material];tone(f*(.85+Math.random()*.3),material==='glass'?.2:.13,material==='glass'?'triangle':'square',material==='glass'?.055:.045);noise(material==='glass'?.16:.085,material==='gingerbread'?.16:.09,material==='glass'?6500:1900);}
function showMessage(value:string,duration=1.2){$('message').textContent=value;$('message').classList.add('show');messageClock=duration;}
function showToast(value:string,duration=1.5){$('toast').textContent=value;$('toast').classList.add('show');toastClock=duration;}

const particleGeo=new THREE.TetrahedronGeometry(1);
const flashGeo=new THREE.SphereGeometry(1,8,6);
const particleMaterials:Record<Material,THREE.MeshBasicMaterial>={
  gingerbread:new THREE.MeshBasicMaterial({color:0xcb7b42}),chocolate:new THREE.MeshBasicMaterial({color:0x642a25}),glass:new THREE.MeshBasicMaterial({color:0x30f0e6}),
  candy:new THREE.MeshBasicMaterial({color:0xff3c70}),marshmallow:new THREE.MeshBasicMaterial({color:0xffebed}),frosting:new THREE.MeshBasicMaterial({color:0xfff8df}),wafer:new THREE.MeshBasicMaterial({color:0xefb76d}),caramel:new THREE.MeshBasicMaterial({color:0xb85b1e})
};
const sparkleMaterial=new THREE.MeshBasicMaterial({color:0xffe78a});
const flashMaterial=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.8,depthWrite:false});
function recycleFX(f:FX){scene.remove(f.mesh);if(f.recycle==='particle')particlePool.push(f.mesh as THREE.Mesh);else if(f.recycle==='flash')flashPool.push(f.mesh as THREE.Mesh);else disposeObject(f.mesh,true);}
function burst(pos:THREE.Vector3,material:Material,count:number,power=1){
  for(let i=0;i<count && fx.length<280;i++){
    const size=(material==='glass'?.035:.055)+Math.random()*.08;
    const m=particlePool.pop()??new THREE.Mesh(particleGeo,particleMaterials[material]);m.material=i%6===0?sparkleMaterial:particleMaterials[material];m.position.copy(pos);m.scale.set(size*(i%6===0?.55:1),size*(i%6===0?2:1),size*(i%6===0?.55:1));scene.add(m);
    const vel=v((Math.random()-.5)*5*power,Math.random()*4*power,(Math.random()-.5)*5*power);
    const life=.6+Math.random()*.7;fx.push({mesh:m,life,max:life,velocity:vel,recycle:'particle',baseScale:size,spark:i%6===0});
  }
}
function flash(pos:THREE.Vector3,color=0xffe2a2,size=.22){if(fx.length>=280)return;const m=flashPool.pop()??new THREE.Mesh(flashGeo,flashMaterial.clone());(m.material as THREE.MeshBasicMaterial).color.setHex(color);m.position.copy(pos);m.scale.setScalar(size);scene.add(m);fx.push({mesh:m,life:.16,max:.16,recycle:'flash',baseScale:size});}
function trail(from:THREE.Vector3,to:THREE.Vector3,color=0xffd990,thickness=.028){if(fx.length>=280)return;const dir=to.clone().sub(from),len=dir.length();const m=new THREE.Mesh(new THREE.CylinderGeometry(thickness,thickness,len,5),new THREE.MeshBasicMaterial({color,transparent:true,opacity:.8,depthWrite:false}));m.position.copy(from).add(to).multiplyScalar(.5);m.quaternion.setFromUnitVectors(v(0,1,0),dir.normalize());scene.add(m);fx.push({mesh:m,life:.09,max:.09});}

function fracture(p:Piece,pos:THREE.Vector3){
  const count=p.material==='glass'?7:p.material==='chocolate'?4:5;
  burst(pos,p.material,p.material==='glass'?18:12,1.15);
  for(let i=0;i<count && debris.length<70;i++){
    const s=p.half.clone().multiplyScalar(.25+Math.random()*.28);
    const m=new THREE.Mesh(new THREE.BoxGeometry(s.x*2,s.y*2,s.z*2),mat[p.material]);m.position.copy(p.group.position).add(v((Math.random()-.5)*p.half.x,(Math.random()-.5)*p.half.y,(Math.random()-.5)*p.half.z));m.rotation.set(Math.random(),Math.random(),Math.random());m.castShadow=true;scene.add(m);
    const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(m.position.x,m.position.y,m.position.z).setLinearDamping(.25));world.createCollider(RAPIER.ColliderDesc.cuboid(Math.max(.06,s.x),Math.max(.06,s.y),Math.max(.06,s.z)).setDensity(.5),body);
    body.applyImpulse({x:(Math.random()-.5)*3,y:2+Math.random()*4,z:(Math.random()-.5)*3},true);
    debris.push({mesh:m,body,life:8+Math.random()*6});
  }
}
function releasePiece(p:Piece,impulse=0){
  if(p.destroyed||p.fallen)return;
  const pos=p.group.position.clone();world.removeRigidBody(p.body);
  const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x,pos.y,pos.z).setLinearDamping(.38).setAngularDamping(.4));
  world.createCollider(RAPIER.ColliderDesc.cuboid(p.half.x,p.half.y,p.half.z).setDensity(.62).setFriction(.8),body);p.body=body;p.fallen=true;
  body.applyImpulse({x:(Math.random()-.5)*2+impulse,y:1.5,z:1+Math.random()*2},true);
  if(p.group.children.some(c=>c.type==='Mesh'))tone(75+Math.random()*35,.32,'sawtooth',.035);
}
function checkSupport(){
  if(!supportDirty)return;
  supportDirty=false;let changes=0;
  const unavailable=new Set([...destroyed,...pieces.filter(p=>p.fallen).map(p=>p.id)]);
  for(const p of pieces){
    if(p.destroyed||p.fallen||p.supports.length===0)continue;
    const lost=p.supports.length-remainingSupports(p.supports,unavailable);
    if(lost>p.supportLoss){p.supportLoss=lost;if(lost>0){p.group.rotation.z=(p.id%2?1:-1)*Math.min(.055,lost/p.supports.length*.07);burst(p.group.position,'gingerbread',2,.35);}}
    if(unsupported(p.supports,unavailable,p.minimumSupports)){
      if(changes>=MAX_SUPPORT_RELEASES){supportDirty=true;continue;}
      releasePiece(p);unavailable.add(p.id);changes++;
    }
  }
  supportReleasesFrame=changes;
  if(changes>=2){slowClock=.3;shake=Math.max(shake,.12);score+=changes*35;showMessage('CHAIN COLLAPSE! +' + changes*35,.8);noise(.35,.19,650);tone(65,.4,'sawtooth',.075,35);}
}
function queueDamage(p:Piece,amount:number,point:THREE.Vector3,chain=false){
  if(p.destroyed||amount<=0||state!=='playing')return;
  if(pendingDamage.length>=MAX_PENDING_DAMAGE){const existing=pendingDamage.find(event=>event.id===p.id);if(existing){existing.amount+=amount;existing.chain ||= chain;existing.point.copy(point);}else droppedDamage++;return;}
  pendingDamage.push({id:p.id,amount,point:point.clone(),chain});
}
function damagePiece(p:Piece,amount:number,point:THREE.Vector3,chain=false):boolean{
  if(p.destroyed)return false;
  p.hp-=amount;burst(point,p.material,p.material==='glass'?5:3,.7);flash(point,p.material==='glass'?0x9afff0:0xffd394,.13);
  soundImpact(p.material);hitClock=.09;shake=Math.max(shake,.026);
  if(p.hp>0){
    const stage=p.hp/p.maxHp>.75?0:p.hp/p.maxHp>.5?1:p.hp/p.maxHp>.25?2:3;
    if(stage>p.damageStage){
      if(p.damageStage===0)p.core.material=mat[p.material].clone();
      p.damageStage=stage;
      p.cracks.children.forEach((crack,index)=>{crack.visible=index<stage;});
      (p.core.material as THREE.MeshStandardMaterial).color.copy(mat[p.material].color).multiplyScalar(1-stage*.12);
      if(stage>=2)p.core.rotation.z=(p.id%2?1:-1)*(.008*stage);
      burst(point,p.material,5+stage*2,.6+stage*.1);
      if(stage===3)tone(p.material==='glass'?780:165,.13,'triangle',.04);
    }
    return false;
  }
  p.destroyed=true;destroyed.add(p.id);destroyedRequired++;rayTargets=rayTargets.filter(o=>o.userData.piece!==p.id);
  world.removeRigidBody(p.body);scene.remove(p.group);fracture(p,point);disposeCoreMaterial(p);disposeObject(p.group);combo=comboClock>0?combo+1:1;comboClock=2.2;bestCombo=Math.max(bestCombo,combo);
  const gain=Math.round((p.material==='chocolate'?135:100)*Math.min(4,1+combo*.15)*(chain?1.3:1));score+=gain;
  if(combo>=3)$('combo').classList.add('show');$('combo').textContent=`${combo}× COMBO`;
  if(combo===5||combo===10||combo===20)showMessage(combo+'× SWEET STREAK!',.9);
  supportDirty=true;return true;
}
function drainDamage(maxEvents=MAX_DAMAGE_PER_FRAME,maxBreaks=MAX_BREAKS_PER_FRAME){
  let processed=0,breaks=0;
  while(pendingDamage.length&&processed<maxEvents){
    const event=pendingDamage[0],p=pieces[event.id];
    if(!p||p.destroyed){pendingDamage.shift();continue;}
    if(p.hp<=event.amount&&breaks>=maxBreaks)break;
    pendingDamage.shift();if(damagePiece(p,event.amount,event.point,event.chain))breaks++;processed++;
  }
  damageProcessedFrame=processed;breaksFrame=breaks;
  checkSupport();
  if(destroyedRequired>=totalRequired&&state==='playing')finish(true);
}

function activate(kind:Upgrade,p:Pickup){const at=p.mesh.position.clone();p.taken=true;scene.remove(p.mesh);disposeObject(p.mesh);rayTargets=rayTargets.filter(o=>o.userData.pickup!==kind);active=kind;upgradeClock=UPGRADE_SECONDS;burst(at,'candy',22,1.45);flash(at,modeColors[kind],.9);showMessage(labels[kind]+'!',1.4);tone(470,.36,'triangle',.11,950);tone(700,.3,'sine',.07,1200);updateHud();}
function explode(pos:THREE.Vector3,radius:number,damage:number){
  explosions++;
  flash(pos,0xff7296,radius*.35);burst(pos,'candy',24,2);noise(.23,.25,1300);tone(94,.32,'sawtooth',.12,41);shake=Math.max(shake,.12);
  let n=0;const radiusSq=radius*radius;for(const p of pieces){if(p.destroyed)continue;const distSq=p.group.position.distanceToSquared(pos);if(distSq<radiusSq){const dist=Math.sqrt(distSq);if(p.fallen)p.body.applyImpulse({x:(p.group.position.x-pos.x)*1.8,y:2.5,z:(p.group.position.z-pos.z)*1.8},true);queueDamage(p,damage*(1-dist/radius*.75),pos,true);n++;}}
  if(n>=4)score+=n*40;
}
function bubbleBomb(pos:THREE.Vector3){if(fx.length>=280){explode(pos,2.7,47);return;}const bubbleMaterial=new THREE.MeshStandardMaterial({color:0xff70bd,emissive:0xff268d,emissiveIntensity:.3,roughness:.08,transparent:true,opacity:.56,depthWrite:false});const m=sphere(scene,bubbleMaterial,.35,pos.x,pos.y,pos.z);const target=pos.clone();fx.push({mesh:m,life:1.3,max:1.3});const grow=()=>{if(!m.parent)return;const t=1.3-(fx.find(f=>f.mesh===m)?.life??0);m.scale.setScalar(1+t*4);m.position.copy(target);if(t>1.22){scene.remove(m);explode(target,2.7,47);}};m.userData.grow=grow;}

const raycaster=new THREE.Raycaster();const targetVec=new THREE.Vector3();
function fireOne(offsetX=0,offsetY=0){
  const shotMode:ShotMode=active??'normal';
  camera.updateMatrixWorld();muzzle.getWorldPosition(targetVec);const origin=targetVec.clone();
  const dir=new THREE.Vector3(offsetX,offsetY,-1).normalize().applyQuaternion(camera.quaternion);
  raycaster.set(camera.position,dir);raycaster.far=90;
  const hits=raycaster.intersectObjects(rayTargets.filter(o=>o.parent!==null),false);
  let end=camera.position.clone().addScaledVector(dir,65),pierced=0,hit=false;const seen=new Set<number>();
  for(const h of hits){const id=h.object.userData.piece as number|undefined;const pickup=h.object.userData.pickup as Upgrade|undefined;
    if(pickup){const p=pickups.find(q=>q.kind===pickup&&!q.taken);if(p){end=h.point;activate(pickup,p);hit=true;break;}continue;}
    if(id===undefined||seen.has(id))continue;const p=pieces[id];if(p.destroyed)continue;seen.add(id);
    if(!hit)end=h.point.clone();hit=true;
    if(shotMode==='gum'){bubbleBomb(h.point);break;}
    if(shotMode==='rocks'){explode(h.point,2.05,41);break;}
    const local=p.group.worldToLocal(h.point.clone());
    const precise=!!p.weakSpot&&local.distanceToSquared(p.weakSpot)<.13;
    if(precise){showToast('WEAK POINT! +75',.65);score+=75;flash(h.point,0xffec72,.25);}
    queueDamage(p,damageFor(p.material)*(shotMode==='laser'?.78:shotMode==='pierce'?.7:shotMode==='storm'?.38:1)*(precise?1.85:1),h.point);
    pierced++;if(shotMode!=='pierce'||pierced>=2)break;
  }
  const color=modeColors[shotMode];
  projectiles.spawn(origin,end,shotMode);
  if(shotMode==='pierce')trail(origin,end,color,.047);
  if(!hit)flash(end,color,.09);
  else if(shotMode==='rush')flash(end,0xffe94c,.18);
  else if(shotMode==='storm')burst(end,'candy',2,.5);
  else if(shotMode==='pierce')tone(680,.075,'triangle',.035,970);
  else if(shotMode==='laser')flash(end,0x40fff2,.24);
  muzzleFlash.visible=true;muzzleFlash.userData.time=shotMode==='rocks'?.085:.055;(muzzleFlash.material as THREE.MeshBasicMaterial).color.setHex(color);
  recoil=shotMode==='rocks'?.085:shotMode==='gum'?.12:.055;spin+=shotMode==='rush'?.3:.22;shotCount++;lifetimeShots++;
  if(shotCount%2===0){const launch=shotMode==='laser'?540:shotMode==='gum'?95:shotMode==='rocks'?180:shotMode==='pierce'?300:shotMode==='rush'?230:shotMode==='storm'?165:130;tone(launch*(.92+Math.random()*.16),.075,shotMode==='laser'?'sawtooth':'square',.024,launch*.62);noise(.045,shotMode==='rocks'?.065:.033,shotMode==='laser'?3300:1900);}
  if(shotMode==='laser'&&hit)shake=Math.max(shake,.015);
}
function fire(){if(active==='storm'){for(let i=0;i<5;i++){const a=i*Math.PI*2/5;fireOne(Math.sin(a)*.034,Math.cos(a)*.034);}}else fireOne();}

function saveKingdom():boolean{try{localStorage.setItem(PROGRESS_KEY,JSON.stringify(kingdomProgress));return true;}catch{return false;}}
function showHome(){state='menu';firing=false;$('hud').classList.remove('active');$('overlay').classList.remove('hidden');$('overlay').innerHTML=`<div class="menu-card home-card"><div class="kicker">A NEW ARCADE ADVENTURE</div><div class="menu-emblem">✦ &nbsp; CANDY KINGDOM &nbsp; ✦</div><h1>GINGERBREAD<br><em>MAYHEM</em></h1><p class="story">Ten sweet destinations. Two castles ready to crumble. Your Caramel Crankshot is waiting.</p><div class="controls">AIM WITH MOUSE &nbsp;·&nbsp; HOLD CLICK TO FIRE &nbsp;·&nbsp; ESC TO PAUSE</div><button class="primary" id="openmap">EXPLORE SUGAR KINGDOM →</button></div>`;$('openmap').addEventListener('click',showMap);}
function showMap(){state='map';firing=false;document.exitPointerLock?.();$('hud').classList.remove('active');$('overlay').classList.remove('hidden');
  const positions:[[number,number],[number,number],[number,number],[number,number],[number,number],[number,number],[number,number],[number,number],[number,number],[number,number]]=[[9,84],[25,68],[42,82],[58,65],[76,69],[85,43],[67,29],[48,40],[30,19],[12,33]];
  const path=positions.map(([x,y],i)=>`${i?'L':'M'} ${x*10} ${y*5.2}`).join(' ');
  const nodes=LEVELS.map((level,index)=>{const record=level.id<=2?kingdomProgress.records[level.id as LevelId]:null,open=unlocked(level.id,kingdomProgress),[x,y]=positions[index];return `<button class="map-node ${open?'open':'locked'} ${record?.stars?'completed':''} ${justUnlockedLevel2&&level.id===2?'fresh-unlock':''}" style="--x:${x}%;--y:${y}%" data-level="${level.id}" ${open?'':'disabled'} aria-label="Level ${level.id}: ${level.name}${open?'':', locked'}"><span class="node-icon">${open?level.icon:'🔒'}</span><span class="node-number">${level.id}</span><span class="node-stars">${record?.stars?'★'.repeat(record.stars)+'☆'.repeat(3-record.stars):open?'☆☆☆':'LOCKED'}</span><span class="node-name">${level.name}</span></button>`;}).join('');
  $('overlay').innerHTML=`<div class="kingdom-map"><div class="map-header"><div><div class="kicker">CHOOSE YOUR NEXT ADVENTURE</div><h2>SUGAR <em>KINGDOM</em></h2><p>Follow the sugar trail. Earn stars to open the next castle.</p></div><button class="map-back" id="mapback">← MAIN MENU</button></div><div class="map-landscape"><div class="map-sun"></div><div class="map-hill hill-a"></div><div class="map-hill hill-b"></div><div class="map-hill hill-c"></div><div class="map-lolli lolli-a" aria-hidden="true"></div><div class="map-lolli lolli-b" aria-hidden="true"></div><div class="map-cupcake" aria-hidden="true"></div><svg class="map-path" viewBox="0 0 1000 520" preserveAspectRatio="none" aria-hidden="true"><path d="${path}"/><path d="${path}"/><path d="${path}"/></svg>${nodes}</div><div class="map-footer"><span>★ ${kingdomProgress.records[1].stars+kingdomProgress.records[2].stars} / 6 STARS EARNED</span><span>LEVELS 3–10 · COMING SOON</span></div></div>`;
  $('mapback').addEventListener('click',showHome);
  $('overlay').querySelectorAll<HTMLButtonElement>('.map-node.open').forEach(button=>button.addEventListener('click',()=>showLevelDetail(Number(button.dataset.level) as LevelId)));
  justUnlockedLevel2=false;
}
function showLevelDetail(id:LevelId){if(!unlocked(id,kingdomProgress))return;selectedLevel=id;state='selected';const level=LEVELS[id-1],record=kingdomProgress.records[id];
  $('overlay').innerHTML=`<div class="menu-card level-card theme-${level.theme}"><button class="card-back" id="backtomap">← SUGAR KINGDOM</button><div class="level-illustration"><span>${level.icon}</span><i></i><b></b></div><div class="kicker">LEVEL ${id} / 10</div><h2>${level.name}</h2><p class="story">${level.subtitle}</p><div class="level-record"><span>BEST STARS <b>${'★'.repeat(record.stars)}${'☆'.repeat(3-record.stars)}</b></span><span>BEST SCORE <b>${record.score.toLocaleString()}</b></span><span>TIME <b>${level.seconds}s</b></span></div><button class="primary" id="playlevel">PLAY LEVEL ${id} →</button></div>`;
  $('backtomap').addEventListener('click',showMap);$('playlevel').addEventListener('click',()=>{currentLevel=id;resetAndPlay();});
}

function updateHud(){
  const seconds=Math.ceil(Math.max(0,time));$('timer').textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
  $('score').textContent=score.toLocaleString();
  $('progress').textContent=progress(destroyedRequired,totalRequired)+'%';
  $('progressfill').style.width=progress(destroyedRequired,totalRequired)+'%';
  $('timerbox').classList.toggle('danger',time<20);
  $('upgrade').classList.toggle('show',!!active);if(active){$('upgradename').textContent=labels[active]+` · ${Math.ceil(upgradeClock)}s`;$('upgradefill').style.width=(upgradeClock/UPGRADE_SECONDS*100)+'%';}
}
function finish(won:boolean){if(state!=='playing')return;if(stressActive){stressRestarts++;stressDroppedDamage+=droppedDamage;resetAndPlay(false);time=10000;active='rush';upgradeClock=10000;firing=true;return;}state=won?'won':'lost';firing=false;document.exitPointerLock?.();$('hud').classList.remove('active');$('overlay').classList.remove('hidden');if(won){for(const m of castleDecor){scene.remove(m);disposeObject(m,m instanceof THREE.Mesh&&m.material instanceof THREE.MeshBasicMaterial);}castleDecor=[];}
  const level=LEVELS[currentLevel-1],elapsed=level.seconds-time,s=won?levelStars(time,score,bestCombo,level.thresholds):0;
  const unlocking=won&&currentLevel===1&&!unlocked(2,kingdomProgress);
  if(unlocking)justUnlockedLevel2=true;
  let saved=true;if(won){kingdomProgress=recordVictory(kingdomProgress,currentLevel,s,score,elapsed);saved=saveKingdom();}
  const record=kingdomProgress.records[currentLevel];
  $('overlay').innerHTML=`<div class="menu-card result"><div class="kicker">LEVEL ${currentLevel} · ${level.name.toUpperCase()}</div><h2>${won?'SWEET VICTORY!':'TIME UP'}</h2><div class="stars">${'★'.repeat(s)}${'☆'.repeat(3-s)}</div><p>${won?'The fortress is crumbs. The kingdom is yours.':'The fortress still stands. Aim for its marked supports and collect power-ups.'}</p>${unlocking?'<div class="unlock-reveal">✦ LEVEL 2 UNLOCKED <strong>CHOCOLATE CITADEL</strong></div>':''}${saved?'':'<p class="save-warning">Progress could not be saved in this browser.</p>'}<div class="stats"><div class="stat"><small>YOUR SCORE</small><b>${score.toLocaleString()}</b></div><div class="stat"><small>COMPLETION</small><b>${won?elapsed.toFixed(1)+'s':progress(destroyedRequired,totalRequired)+'%'}</b></div><div class="stat"><small>BEST SCORE</small><b>${record.score.toLocaleString()}</b></div><div class="stat"><small>BEST TIME</small><b>${record.bestTime===null?'—':record.bestTime.toFixed(1)+'s'}</b></div></div><div class="result-actions">${won&&currentLevel===1?'<button class="primary" id="nextlevel">NEXT LEVEL →</button>':''}<button class="primary secondary" id="resultmap">WORLD MAP</button><button class="map-back" id="replay">REPLAY</button></div></div>`;
  $('replay').addEventListener('click',()=>resetAndPlay());$('resultmap').addEventListener('click',showMap);
  if(won&&currentLevel===1)$('nextlevel').addEventListener('click',()=>{currentLevel=2;resetAndPlay();});
  if(won){tone(523,.4,'triangle',.1,784);setTimeout(()=>tone(784,.5,'triangle',.1,1046),140);}
}
function pause(){if(state!=='playing')return;state='paused';firing=false;document.exitPointerLock?.();$('overlay').classList.remove('hidden');$('overlay').innerHTML=`<div class="menu-card"><div class="kicker">TAKE A BREATHER · ${LEVELS[currentLevel-1].name.toUpperCase()}</div><h1>PAUSED</h1><p class="story">Your Caramel Crankshot is ready when you are.</p><button class="primary" id="resume">RESUME →</button><div class="pause-options"><button id="pauseSound">SOUND: ${soundOn?'ON':'OFF'}</button><button id="pauseShake">CAMERA SHAKE: ${shakeOn?'ON':'OFF'}</button><button id="pauseMap">SUGAR KINGDOM MAP</button></div><p class="pause-note">Click to lock your mouse and continue.</p></div>`;$('resume').addEventListener('click',resume);$('pauseMap').addEventListener('click',showMap);$('pauseSound').addEventListener('click',()=>{soundOn=!soundOn;$('sound').textContent=soundOn?'♪':'×';$('pauseSound').textContent=`SOUND: ${soundOn?'ON':'OFF'}`;});$('pauseShake').addEventListener('click',()=>{shakeOn=!shakeOn;$('shake').textContent=shakeOn?'✧':'·';$('pauseShake').textContent=`CAMERA SHAKE: ${shakeOn?'ON':'OFF'}`;});}
function requestAimLock(){if(fallbackAim)return;try{const result=renderer.domElement.requestPointerLock();if(result&&typeof result.catch==='function')result.catch(()=>{fallbackAim=true;showToast('MOUSE AIM ACTIVE');});}catch{fallbackAim=true;showToast('MOUSE AIM ACTIVE');}}
function resume(){if(state!=='paused')return;state='playing';$('overlay').classList.add('hidden');requestAimLock();}
function resetAndPlay(lockPointer=true){
  for(const p of pieces){if(!p.destroyed){world.removeRigidBody(p.body);disposeCoreMaterial(p);disposeObject(p.group);}scene.remove(p.group);}
  for(const m of castleDecor){scene.remove(m);disposeObject(m,m instanceof THREE.Mesh&&m.material instanceof THREE.MeshBasicMaterial);}castleDecor=[];
  for(const d of debris){world.removeRigidBody(d.body);scene.remove(d.mesh);disposeObject(d.mesh);}
  for(const f of fx)recycleFX(f);
  projectiles.clear();
  for(const p of pickups){if(!p.taken)disposeObject(p.mesh);scene.remove(p.mesh);}
  pieces=[];pickups=[];fx=[];debris=[];rayTargets=[];destroyed=new Set();pendingDamage=[];supportDirty=false;droppedDamage=0;totalRequired=0;destroyedRequired=0;
  time=LEVELS[currentLevel-1].seconds;score=0;combo=0;bestCombo=0;comboClock=0;active=null;upgradeClock=0;firing=false;fireClock=0;spin=0;shake=0;slowClock=0;shotCount=0;messageClock=0;toastClock=0;hitClock=0;physicsAccum=0;
  yaw=0;pitch=-.02;applyLevelTheme();buildCastle();state='playing';$('overlay').classList.add('hidden');$('hud').classList.add('active');$('leveltitle').textContent=LEVELS[currentLevel-1].name.toUpperCase();$('combo').classList.remove('show');$('combo').textContent='';$('message').classList.remove('show');$('toast').classList.remove('show');$('crosshair').classList.remove('hit');updateHud();ensureAudio();if(lockPointer)requestAimLock();
}
function simulateCompletion(id:LevelId=currentLevel,preserveProgress=false){
  const stored=localStorage.getItem(PROGRESS_KEY),original=kingdomProgress,previousSound=soundOn;soundOn=false;currentLevel=id;resetAndPlay(false);scene.updateMatrixWorld(true);let shots=0,passes=0;
  while(state==='playing'&&passes<30&&shots<2500){
    const beforeShots=shots;
    for(const target of pieces){
      if(target.destroyed)continue;
      const direction=target.group.position.clone().sub(camera.position).normalize();
      const heading=Math.atan2(-direction.x,-direction.z),elevation=Math.asin(-direction.y);
      if(Math.abs(heading)>1.12||elevation<-.61||elevation>.55)continue;
      raycaster.set(camera.position,direction);raycaster.far=90;
      const hit=raycaster.intersectObjects(rayTargets,false).find(h=>{
        const id=h.object.userData.piece as number|undefined;
        return id!==undefined&&!pieces[id].destroyed;
      });
      if(!hit)continue;
      const p=pieces[hit.object.userData.piece as number];
      queueDamage(p,damageFor(p.material),hit.point);drainDamage();shots++;
      if(state!=='playing')break;
    }
    passes++;if(beforeShots===shots)break;
  }
  soundOn=previousSound;const result={level:id,complete:state==='won',destroyed:destroyedRequired,total:totalRequired,shots,passes};
  if(!preserveProgress){kingdomProgress=original;if(stored===null)localStorage.removeItem(PROGRESS_KEY);else localStorage.setItem(PROGRESS_KEY,stored);}
  console.info('Completion simulation',result);
  if(state==='playing')showToast(`QA: ${destroyedRequired}/${totalRequired} targets reachable`,5);
  return result;
}
function progressionCheck(){
  const stored=localStorage.getItem(PROGRESS_KEY),original=kingdomProgress;
  try{
    kingdomProgress=emptyProgress();saveKingdom();const initiallyLocked=!unlocked(2,kingdomProgress);
    const first=simulateCompletion(1,true),unlockedAfterFirst=unlocked(2,kingdomProgress);
    $('overlay').querySelector<HTMLButtonElement>('#nextlevel')?.click();
    const nextLoadsTwo=currentLevel===2&&state==='playing'&&totalRequired>0&&LEVELS[currentLevel-1].castle==='citadel';
    showMap();const nodeTwo=$('overlay').querySelector<HTMLButtonElement>('.map-node[data-level="2"]:not(:disabled)');
    const selectable=!!nodeTwo;nodeTwo?.click();const selectionLoadsTwo=selectedLevel===2&&state==='selected';
    $('overlay').querySelector<HTMLButtonElement>('#playlevel')?.click();
    const mapLaunchesTwo=currentLevel===2&&state==='playing'&&totalRequired>0;
    const second=simulateCompletion(2,true),saved=parseProgress(localStorage.getItem(PROGRESS_KEY),null);
    $('overlay').querySelector<HTMLButtonElement>('#replay')?.click();
    const replayStaysTwo=currentLevel===2&&state==='playing'&&totalRequired===second.total;
    const result={initiallyLocked,first:first.complete,unlockedAfterFirst,nextLoadsTwo,selectable,selectionLoadsTwo,mapLaunchesTwo,second:second.complete,replayStaysTwo,levelOneStars:saved.records[1].stars,levelTwoStars:saved.records[2].stars,levelTwoScore:saved.records[2].score,levelThreeLocked:!unlocked(3,saved)};
    console.info('Progression check',JSON.stringify(result));return result;
  }finally{kingdomProgress=original;if(stored===null)localStorage.removeItem(PROGRESS_KEY);else localStorage.setItem(PROGRESS_KEY,stored);showMap();}
}
function checkUpgrades(id:LevelId=currentLevel){
  currentLevel=id;
  const results:Record<string,boolean>={};
  const prepare=(kind:Upgrade)=>{resetAndPlay(false);active=kind;upgradeClock=UPGRADE_SECONDS;camera.rotation.order='YXZ';camera.rotation.set(0,0,0);scene.updateMatrixWorld(true);};
  const affected=()=>pieces.filter(p=>p.hp<p.maxHp).length;
  prepare('rush');fire();drainDamage();results.rush=shotInterval('rush')<shotInterval(null)&&shotCount===1&&affected()>0;
  prepare('storm');fire();drainDamage();results.storm=shotCount===5&&affected()>0;
  prepare('pierce');camera.rotation.x=.045;camera.rotation.y=-.075;camera.updateMatrixWorld(true);fire();drainDamage();results.pierce=affected()>=2;
  prepare('rocks');fire();drainDamage();results.rocks=affected()>=2;
  prepare('gum');fire();const bubble=fx.some(f=>!!f.mesh.userData.grow);update(1.31);drainDamage();results.gum=bubble&&affected()>0;
  prepare('laser');fire();drainDamage();results.laser=shotInterval('laser')<shotInterval(null)&&affected()>0;
  active='rush';upgradeClock=.01;update(.02);results.expiry=active===null;
  console.info('Upgrade checks',JSON.stringify(results));return results;
}
function collapseBurstCheck(){
  resetAndPlay(false);
  const targets=pieces.filter(p=>!p.destroyed&&p.supports.length===0&&p.group.position.x<0&&p.group.position.x>-10).slice(0,8);
  targets.forEach(p=>releasePiece(p));
  const start=performance.now();
  for(const p of targets)explode(p.group.position.clone(),1.3,250);
  const queued=pendingDamage.length;
  for(let i=0;i<60&&(pendingDamage.length||supportDirty);i++)drainDamage();
  const stepStart=performance.now();world.step();const stepMs=performance.now()-stepStart;
  const result={released:targets.length,queued,destroyed:targets.filter(p=>p.destroyed).length,remaining:pendingDamage.length,bodies:world.bodies.len(),colliders:world.colliders.len(),damageMs:+(stepStart-start).toFixed(2),stepMs:+stepMs.toFixed(2),droppedDamage};
  console.info('Collapse burst check',JSON.stringify(result));return result;
}
function beginStress(){currentLevel=1;resetAndPlay(false);renderer.render(scene,camera);time=10000;active=null;upgradeClock=10000;firing=true;stressActive=true;stressStart=performance.now();stressShotStart=lifetimeShots;stressExplosionStart=explosions;stressFrames=0;stressFrameMs=0;stressRestarts=0;stressModeIndex=0;stressDroppedDamage=0;stressPeakShots=0;stressPeakBodies=0;stressPeakParticles=0;stressPeakGeometry=0;stressPeakPhysics=0;stressPeakQueue=0;stressPeakAudio=0;stressImpactEvents=0;stressBreaks=0;physicsStepMaxMs=0;stressBaselineGeometry=renderer.info.memory.geometries;if(stressButton)stressButton.textContent='STRESS RUNNING · 0/180s';}
function endStress(){stressActive=false;firing=false;const seconds=(performance.now()-stressStart)/1000;const result={seconds:+seconds.toFixed(1),shots:lifetimeShots-stressShotStart,explosions:explosions-stressExplosionStart,averageFps:+(stressFrames/seconds).toFixed(1),averageFrameMs:+(stressFrameMs/stressFrames).toFixed(1),maxPhysicsStepMs:+stressPeakPhysics.toFixed(2),peakQueuedDamage:stressPeakQueue,impactEvents:stressImpactEvents,fractures:stressBreaks,peakProjectiles:stressPeakShots,peakRigidBodies:stressPeakBodies,peakParticles:stressPeakParticles,peakAudioNodes:stressPeakAudio,peakGeometries:stressPeakGeometry,baselineGeometries:stressBaselineGeometry,restarts:stressRestarts,droppedDamage:stressDroppedDamage+droppedDamage};console.info('Stress result',JSON.stringify(result));if(stressButton)stressButton.textContent=`STRESS DONE · ${result.shots} SHOTS / ${result.averageFps} FPS`;showToast('STRESS TEST COMPLETE',5);}
function update(dt:number){
  physicsStepMs=0;impactEventsFrame=0;damageProcessedFrame=0;breaksFrame=0;supportReleasesFrame=0;
  ambientClock+=dt;ambientUpdateAccum+=dt;
  for(let i=0;i<ambientClouds.length;i++){const cloud=ambientClouds[i];cloud.position.x=cloud.userData.baseX+Math.sin(ambientClock*.09+i*1.4)*1.4;cloud.position.y=cloud.userData.baseY+Math.sin(ambientClock*.16+i)*.13;}
  for(let i=0;i<ambientGears.length;i++)ambientGears[i].rotation.z+=dt*(i?-.21:.21);
  if(ambientUpdateAccum>=.05){updateAmbientSparkles(ambientClock);ambientUpdateAccum=0;}
  projectiles.update(dt);
  for(const p of pickups){if(p.taken)continue;p.phase+=dt;p.mesh.rotation.y+=dt*.85;p.mesh.position.y+=Math.sin(p.phase*2)*dt*.08;}
  const targetSpin=firing&&state==='playing'?(active==='rush'?34:active==='laser'?29:21):0;spin+= (targetSpin-spin)*Math.min(1,dt*7);barrelCluster.rotation.z+=spin*dt;
  motorUpdateClock-=dt;if(audio&&motorGain&&motorOsc&&motorUpdateClock<=0){motorOsc.frequency.setTargetAtTime(58+spin*2.4,audio.currentTime,.035);motorGain.gain.setTargetAtTime(soundOn&&state==='playing'&&firing?.017:0,audio.currentTime,.055);motorUpdateClock=.08;}
  (modeLamp.material as THREE.MeshBasicMaterial).color.setHex(modeColors[active??'normal']);modeLamp.rotation.z+=dt*(spin*.24+1);
  recoil*=Math.exp(-dt*19);weapon.position.z=-1.45+recoil;weapon.position.y=-.83+recoil*.45;
  if(muzzleFlash.visible){muzzleFlash.userData.time-=dt;if(muzzleFlash.userData.time<=0)muzzleFlash.visible=false;else muzzleFlash.scale.setScalar(.8+Math.random()*.5);}
  if(state==='playing'){
    if(stressActive){const elapsed=(performance.now()-stressStart)/1000;if(elapsed>=180)endStress();else{const modeIndex=Math.floor(elapsed/20);if(modeIndex!==stressModeIndex){stressDroppedDamage+=droppedDamage;stressRestarts++;currentLevel=modeIndex%2?2:1;resetAndPlay(false);time=10000;firing=true;stressModeIndex=modeIndex;}yaw=Math.sin(elapsed*1.25)*.34;pitch=Math.sin(elapsed*.77)*.11;camera.rotation.y=yaw;camera.rotation.x=pitch;const modes:(Upgrade|null)[]=[null,'rush','storm','pierce','rocks','gum','laser'];active=modes[modeIndex%modes.length];upgradeClock=10000;if(stressButton&&Math.floor(elapsed)%10===0)stressButton.textContent=`STRESS RUNNING · ${Math.floor(elapsed)}/180s`;}}
    const gameDt=dt*(slowClock>0?.42:1);time=Math.max(0,time-gameDt);if(time<=0){finish(false);return;}
    if(active){upgradeClock-=gameDt;if(upgradeClock<=0){active=null;showToast('POWER-UP EXPIRED');}}
    if(comboClock>0){comboClock-=gameDt;if(comboClock<=0){combo=0;$('combo').classList.remove('show');}}
    if(slowClock>0)slowClock-=dt;
    if(firing){fireClock-=dt;let shots=0;while(fireClock<=0&&shots<4){fire();fireClock+=shotInterval(active);shots++;}}else fireClock=0;
    physicsAccum=Math.min(.15,physicsAccum+gameDt);while(physicsAccum>=1/60){const stepStart=performance.now();world.step();const stepMs=performance.now()-stepStart;physicsStepMs+=stepMs;physicsStepMaxMs=Math.max(physicsStepMaxMs,stepMs);physicsAccum-=1/60;}
    for(const p of pieces){
      if(!p.fallen||p.destroyed)continue;
      const t=p.body.translation(),r=p.body.rotation(),vy=p.body.linvel().y;
      p.group.position.set(t.x,t.y,t.z);p.group.quaternion.set(r.x,r.y,r.z,r.w);
      if(!p.impactDone&&p.previousVy< -3.5&&(vy>p.previousVy*.5||t.y<p.half.y+.18)){
        p.impactDone=true;const impact=v(t.x,Math.max(.1,t.y-p.half.y),t.z);
        burst(impact,p.material,12,1.45);noise(.23,.16,710);tone(78,.32,'sawtooth',.055,39);shake=Math.max(shake,.065);
        impactEventsFrame++;queueDamage(p,Math.min(24,-p.previousVy*1.3),impact,true);
        let nearby=0;for(const other of pieces){if(other===p||other.destroyed||nearby>=2)continue;if(other.group.position.distanceToSquared(p.group.position)<Math.max(2.1,p.half.x+1)**2){queueDamage(other,7,impact,true);nearby++;}}
      }
      p.previousVy=vy;
      if(t.y<-.5)p.body.setTranslation({x:t.x,y:Math.max(p.half.y,t.y),z:t.z},true);
    }
    for(let i=debris.length-1;i>=0;i--){const d=debris[i];d.life-=gameDt;const t=d.body.translation(),r=d.body.rotation();d.mesh.position.set(t.x,t.y,t.z);d.mesh.quaternion.set(r.x,r.y,r.z,r.w);if(d.life<=0){world.removeRigidBody(d.body);scene.remove(d.mesh);disposeObject(d.mesh);debris.splice(i,1);}}
    drainDamage();
    updateHud();
  }
  for(let i=fx.length-1;i>=0;i--){const f=fx[i];f.life-=dt;if(f.velocity){f.velocity.y-=dt*7;f.mesh.position.addScaledVector(f.velocity,dt);f.mesh.rotation.x+=dt*5;f.mesh.rotation.z+=dt*3;}
    if(f.mesh.userData.grow)f.mesh.userData.grow();
    if(f.recycle){const size=(f.baseScale??1)*Math.max(.01,f.life/f.max);f.mesh.scale.set(f.spark?size*.55:size,f.spark?size*2:size,f.spark?size*.55:size);}
    else{const material=(f.mesh as THREE.Mesh).material as THREE.MeshBasicMaterial;if(material?.opacity!==undefined)material.opacity=Math.max(0,f.life/f.max);}
    if(f.life<=0){recycleFX(f);fx.splice(i,1);}}
  if(messageClock>0){messageClock-=dt;if(messageClock<=0)$('message').classList.remove('show');}
  if(toastClock>0){toastClock-=dt;if(toastClock<=0)$('toast').classList.remove('show');}
  if(hitClock>0){hitClock-=dt;if(hitClock<=0)$('crosshair').classList.remove('hit');else $('crosshair').classList.add('hit');}
  shake*=Math.exp(-dt*17);camera.rotation.order='YXZ';camera.rotation.y=yaw+(shakeOn?(Math.random()-.5)*shake:0);camera.rotation.x=pitch+(shakeOn?(Math.random()-.5)*shake:0);
}
function animate(now:number){requestAnimationFrame(animate);if(state!=='playing'&&lastTime&&now-lastTime<33)return;const rawMs=lastTime?now-lastTime:16.7,dt=Math.min(.05,rawMs/1000);lastTime=now;update(dt);renderer.render(scene,camera);
  if(perfEl){perfFrames++;perfSeconds+=Math.min(.25,rawMs/1000);perfMaxFrame=Math.max(perfMaxFrame,rawMs);if(perfSeconds>=.5){const fps=perfFrames/perfSeconds,bodies=world.bodies.len(),colliders=world.colliders.len();perfEl.textContent=`${fps.toFixed(0)} FPS · ${(1000/fps).toFixed(1)} ms avg · ${perfMaxFrame.toFixed(1)} ms max\nphysics ${physicsStepMs.toFixed(2)} ms/frame · ${physicsStepMaxMs.toFixed(2)} ms step max · ${impactEventsFrame} impacts\n${projectiles.count} projectiles · ${bodies} bodies · ${colliders} colliders · ${activeAudioNodes} audio nodes\n${fx.length} FX · ${debris.length} debris · ${particlePool.length} particles pooled · ${rayTargets.length} targets\n${pendingDamage.length} damage queued · ${damageProcessedFrame} processed · ${breaksFrame} breaks · ${supportReleasesFrame} releases · ${droppedDamage} drops\n${renderer.info.memory.geometries} geometries · ${renderer.info.memory.textures} textures · ${renderer.info.render.calls} draws`;perfFrames=0;perfSeconds=0;perfMaxFrame=0;}}
  if(stressActive){stressFrames++;stressFrameMs+=rawMs;stressPeakShots=Math.max(stressPeakShots,projectiles.count);stressPeakBodies=Math.max(stressPeakBodies,world.bodies.len());stressPeakParticles=Math.max(stressPeakParticles,fx.length);stressPeakGeometry=Math.max(stressPeakGeometry,renderer.info.memory.geometries);stressPeakPhysics=Math.max(stressPeakPhysics,physicsStepMs);stressPeakQueue=Math.max(stressPeakQueue,pendingDamage.length);stressPeakAudio=Math.max(stressPeakAudio,activeAudioNodes);stressImpactEvents+=impactEventsFrame;stressBreaks+=breaksFrame;}
}
async function boot(){await RAPIER.init();world=new RAPIER.World({x:0,y:-17,z:0});try{kingdomProgress=parseProgress(localStorage.getItem(PROGRESS_KEY),localStorage.getItem('gingerbread-mayhem-best'));saveKingdom();}catch{kingdomProgress=emptyProgress();}initScene();projectiles=new CandyProjectiles(scene);applyLevelTheme();buildCastle();makeWeapon();camera.rotation.order='YXZ';camera.rotation.x=pitch;showHome();renderer.render(scene,camera);requestAnimationFrame(animate);
  if(import.meta.env.DEV&&new URLSearchParams(location.search).has('qa')){
    perfEl=document.createElement('div');perfEl.className='perf';app.append(perfEl);
    try{console.info('Saved progression audit',JSON.stringify({kingdom:localStorage.getItem(PROGRESS_KEY),legacy:localStorage.getItem('gingerbread-mayhem-best')}));}catch{/* unavailable storage */}
    for(const id of [1,2] as const){
      const qa=document.createElement('button');qa.textContent=`RUN LEVEL ${id} COMPLETION`;qa.className='primary';qa.style.cssText=`position:fixed;left:10px;bottom:${id===1?10:50}px;z-index:30;font-size:11px;padding:8px`;app.append(qa);
      qa.addEventListener('click',()=>{const r=simulateCompletion(id);qa.textContent=r.complete?`LEVEL ${id} PASS · ${r.total} TARGETS / ${r.shots} SHOTS`:`LEVEL ${id} FAIL · ${r.destroyed}/${r.total}`;});
      const upgrades=document.createElement('button');upgrades.textContent=`RUN LEVEL ${id} POWER-UPS`;upgrades.className='primary';upgrades.style.cssText=`position:fixed;left:10px;bottom:${id===1?90:130}px;z-index:30;font-size:11px;padding:8px`;app.append(upgrades);
      upgrades.addEventListener('click',()=>{const r=checkUpgrades(id);const count=Object.values(r).filter(Boolean).length;upgrades.textContent=`LEVEL ${id} ${count===7?'PASS':'FAIL'} · ${count}/7 ${Object.entries(r).filter(([,pass])=>!pass).map(([name])=>name).join(', ')}`;});
    }
    stressButton=document.createElement('button');stressButton.textContent='RUN 3-MINUTE FIRE STRESS';stressButton.className='primary';stressButton.style.cssText='position:fixed;left:10px;bottom:170px;z-index:30;font-size:11px;padding:8px';app.append(stressButton);stressButton.addEventListener('click',beginStress);
    const collapse=document.createElement('button');collapse.textContent='RUN COLLAPSE BURST';collapse.className='primary';collapse.style.cssText='position:fixed;left:10px;bottom:210px;z-index:30;font-size:11px;padding:8px';app.append(collapse);collapse.addEventListener('click',()=>{const r=collapseBurstCheck();collapse.textContent=`${r.destroyed===r.released&&r.remaining===0?'PASS':'CHECK'} · ${r.destroyed}/${r.released} FALLEN TARGETS · ${r.stepMs}ms`;});
    const restart=document.createElement('button');restart.textContent='RUN 8 LEVEL SWITCHES';restart.className='primary';restart.style.cssText='position:fixed;left:10px;bottom:250px;z-index:30;font-size:11px;padding:8px';app.append(restart);restart.addEventListener('click',()=>{currentLevel=1;resetAndPlay(false);renderer.render(scene,camera);const before=renderer.info.memory.geometries;for(let i=0;i<8;i++){currentLevel=i%2?1:2;resetAndPlay(false);renderer.render(scene,camera);}const after=renderer.info.memory.geometries;restart.textContent=`8 SWITCHES · G ${before} → ${after} · B ${world.bodies.len()}`;console.info('Level switch check',JSON.stringify({before,after,bodies:world.bodies.len(),colliders:world.colliders.len()}));});
    const progressQa=document.createElement('button');progressQa.textContent='RUN PROGRESSION FLOW';progressQa.className='primary';progressQa.style.cssText='position:fixed;left:10px;bottom:290px;z-index:30;font-size:11px;padding:8px';app.append(progressQa);progressQa.addEventListener('click',()=>{const r=progressionCheck();progressQa.textContent=`PROGRESSION ${Object.values(r).every(Boolean)?'PASS':'CHECK'} · L1 ${r.levelOneStars}★ L2 ${r.levelTwoStars}★`;});
  }
  $('sound').addEventListener('click',()=>{soundOn=!soundOn;$('sound').textContent=soundOn?'♪':'×';showToast(soundOn?'SOUND ON':'SOUND OFF');});
  $('shake').addEventListener('click',()=>{shakeOn=!shakeOn;$('shake').textContent=shakeOn?'✧':'·';showToast(shakeOn?'CAMERA SHAKE ON':'CAMERA SHAKE OFF');});
  $('pause').addEventListener('click',pause);
  document.addEventListener('pointerlockchange',()=>{if(!fallbackAim&&document.pointerLockElement!==renderer.domElement&&state==='playing')pause();});
  document.addEventListener('mousemove',e=>{if(state!=='playing')return;if(document.pointerLockElement===renderer.domElement){const delta=pointerAimDelta(e.movementX,e.movementY);yaw=Math.max(-1.12,Math.min(1.12,yaw+delta.yaw));pitch=Math.max(-.61,Math.min(.55,pitch+delta.pitch));}else if(fallbackAim){const aim=fallbackAimPosition(e.clientX,e.clientY,innerWidth,innerHeight);yaw=Math.max(-1.12,Math.min(1.12,aim.yaw));pitch=Math.max(-.61,Math.min(.55,aim.pitch));}});
  renderer.domElement.addEventListener('mousedown',e=>{if(e.button!==0)return;if(state==='playing'){if(document.pointerLockElement!==renderer.domElement)requestAimLock();firing=true;fireClock=0;}});
  document.addEventListener('mouseup',e=>{if(e.button===0)firing=false;});
  document.addEventListener('keydown',e=>{if(e.code==='Escape'&&state==='playing')pause();else if((e.code==='Space'||e.code==='Enter')&&state==='paused')resume();});
  window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
}
boot().catch(err=>{console.error(err);$('overlay').innerHTML=`<div class="menu-card"><h1>OH, CRUMBS!</h1><p>The game could not start. Please reload this page.</p></div>`;});
