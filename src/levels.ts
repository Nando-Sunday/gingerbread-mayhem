export type LevelId = 1 | 2;
export type LevelTheme = 'gingerbread' | 'chocolate';
export type StarThresholds = { twoTime:number; twoScore:number; threeTime:number; threeScore:number; threeCombo:number };
export type LevelDefinition = { id:number; name:string; subtitle:string; theme:LevelTheme; castle:'gate'|'citadel'|null; seconds:number; thresholds:StarThresholds; icon:string };
const gateStars:StarThresholds={twoTime:30,twoScore:9000,threeTime:60,threeScore:19000,threeCombo:8};
const citadelStars:StarThresholds={twoTime:30,twoScore:10500,threeTime:58,threeScore:23000,threeCombo:9};
export const LEVELS:readonly LevelDefinition[]=[
  {id:1,name:'Gingerbread Gate',subtitle:'The royal candy defenses',theme:'gingerbread',castle:'gate',seconds:120,thresholds:gateStars,icon:'⌂'},
  {id:2,name:'Chocolate Citadel',subtitle:'Break the wafer bastions',theme:'chocolate',castle:'citadel',seconds:125,thresholds:citadelStars,icon:'♜'},
  {id:3,name:'Marshmallow Marsh',subtitle:'Coming soon',theme:'gingerbread',castle:null,seconds:120,thresholds:gateStars,icon:'◌'},
  {id:4,name:'Caramel Canyon',subtitle:'Coming soon',theme:'chocolate',castle:null,seconds:120,thresholds:gateStars,icon:'◇'},
  {id:5,name:'Jellybean Junction',subtitle:'Coming soon',theme:'gingerbread',castle:null,seconds:120,thresholds:gateStars,icon:'✦'},
  {id:6,name:'Lollipop Heights',subtitle:'Coming soon',theme:'gingerbread',castle:null,seconds:120,thresholds:gateStars,icon:'◉'},
  {id:7,name:'Nougat Factory',subtitle:'Coming soon',theme:'chocolate',castle:null,seconds:120,thresholds:gateStars,icon:'⚙'},
  {id:8,name:'Sugar Glass Palace',subtitle:'Coming soon',theme:'gingerbread',castle:null,seconds:120,thresholds:gateStars,icon:'◆'},
  {id:9,name:'Candy Cloud Fortress',subtitle:'Coming soon',theme:'gingerbread',castle:null,seconds:120,thresholds:gateStars,icon:'☁'},
  {id:10,name:"Sugar Lord's Castle",subtitle:'Coming soon',theme:'chocolate',castle:null,seconds:120,thresholds:gateStars,icon:'♛'}
];
export const playableLevel=(id:number):id is LevelId=>id===1||id===2;
export function levelStars(secondsRemaining:number,score:number,bestCombo:number,thresholds:StarThresholds):1|2|3{
  if(secondsRemaining>=thresholds.threeTime&&score>=thresholds.threeScore&&bestCombo>=thresholds.threeCombo)return 3;
  if(secondsRemaining>=thresholds.twoTime&&score>=thresholds.twoScore)return 2;
  return 1;
}
export type LevelRecord={completed:boolean;stars:number;score:number;bestTime:number|null};
export type KingdomProgress={version:2;records:Record<LevelId,LevelRecord>};
export const PROGRESS_KEY='gingerbread-mayhem-kingdom-v1';
export function emptyProgress():KingdomProgress{return {version:2,records:{1:{completed:false,stars:0,score:0,bestTime:null},2:{completed:false,stars:0,score:0,bestTime:null}}};}
const nonnegative=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)?Math.max(0,value):0;
const completionTime=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
export function parseProgress(raw:string|null,legacy:string|null):KingdomProgress{
  const result=emptyProgress();
  try{if(raw){const saved=JSON.parse(raw);for(const id of [1,2] as const){const value=saved?.records?.[id];if(value&&typeof value==='object'){
    const stars=Math.min(3,Math.floor(nonnegative(value.stars))),bestTime=completionTime(value.bestTime);
    result.records[id]={completed:value.completed===true||stars>0||bestTime!==null,stars:Math.max(stars,value.completed===true||bestTime!==null?1:0),score:nonnegative(value.score),bestTime};
  }}}}
  catch{/* corrupt current data falls back to legacy data */}
  try{if(legacy){const value=JSON.parse(legacy),legacyTime=completionTime(value?.time),current=result.records[1];result.records[1]={completed:current.completed||legacyTime!==null,stars:Math.max(current.stars,legacyTime!==null?1:0),score:Math.max(current.score,nonnegative(value?.score)),bestTime:legacyTime===null?current.bestTime:current.bestTime===null?legacyTime:Math.min(current.bestTime,legacyTime)};}}
  catch{/* ignore corrupt legacy data */}
  return result;
}
export function unlocked(id:number,progress:KingdomProgress):boolean{return id===1||(id===2&&progress.records[1].completed);}
export function recordVictory(progress:KingdomProgress,id:LevelId,earnedStars:number,score:number,elapsed:number):KingdomProgress{
  const current=progress.records[id];
  return {...progress,records:{...progress.records,[id]:{completed:true,stars:Math.max(current.stars,earnedStars,1),score:Math.max(current.score,score),bestTime:current.bestTime===null?elapsed:Math.min(current.bestTime,elapsed)}}};
}
