const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
function fixture(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'pet-client-audit-'));
 const http={request(_opts,callback){const req=new EventEmitter();req.setTimeout=()=>{};req.write=()=>{};req.end=()=>{queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;callback(res);res.emit('data',Buffer.from('{}'));res.emit('end');});};return req;}};
 const context={require:n=>n==='node:http'?http:require(n),process:{env:{...process.env,USERPROFILE:home,DSH_HOME:path.join(home,'.dsh')}},__dirname:__dirname,module:{exports:{}},Buffer,setTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'service.cjs'),'utf8'),context);
 const folder=path.join(home,'source');fs.mkdirSync(path.join(folder,'animations'),{recursive:true});fs.writeFileSync(path.join(folder,'animations','站立.webm'),'test');
 const cfg={pets:[{id:'testgirl',name:'test'}],animations:{idle:['站立'],turn:['站立'],drag:['站立'],clicks:['站立'],moves:{default:{minDist:0,maxDist:0,margin:20,leadSec:0,tailSec:0},actions:[]},categories:[{id:'小动作',actions:['站立'],weight:1}],events:{balance:Array(6).fill('站立')}}};
 return {home,folder,cfg,api:context.module.exports,save(){fs.writeFileSync(path.join(folder,'config.json'),JSON.stringify(cfg));},cleanup(){fs.rmSync(home,{recursive:true,force:true});}};
}
test('a stationary character pack can be imported without movement actions',async()=>{
 const f=fixture();try{fs.mkdirSync(f.api.ROOT,{recursive:true});f.save();await f.api.importProject(f.folder);assert.ok(fs.existsSync(path.join(f.api.ROOT,'testgirl/config.json')));}finally{f.cleanup();}
});
test('first import creates the character root on a fresh installation',async()=>{
 const f=fixture();try{f.cfg.animations.moves.actions=[{name:'站立',weight:1}];f.save();await f.api.importProject(f.folder);assert.ok(fs.existsSync(path.join(f.api.ROOT,'testgirl/animations/站立.webm')));}finally{f.cleanup();}
});
test('bad action paths are rejected before any project is installed',async()=>{
 const f=fixture();try{f.cfg.animations.moves.actions=[{name:'../escape'}];f.save();await assert.rejects(f.api.importProject(f.folder),/动作文件名/);assert.ok(!fs.existsSync(path.join(f.api.ROOT,'testgirl')));}finally{f.cleanup();}
});
test('new official actions reach an installed character once, keeping the user\'s edits (clips stay in the bundle)',()=>{
 const f=fixture();try{
  const src=path.join(f.home,'seed/testgirl'),dest=path.join(f.api.ROOT,'testgirl');
  for(const dir of [src,dest])fs.mkdirSync(path.join(dir,'animations'),{recursive:true});
  for(const n of ['站立','挥手','跳跳'])fs.writeFileSync(path.join(src,'animations',n+'.webm'),n);
  fs.writeFileSync(path.join(dest,'animations','站立.webm'),'old');fs.writeFileSync(path.join(dest,'animations','自制.webm'),'mine');
  const seed=structuredClone(f.cfg);seed.animations.categories[0].actions=['站立','挥手'];seed.animations.categories.push({id:'玩耍',actions:['跳跳'],weight:1});
  const installed=structuredClone(f.cfg);installed.pets[0].size=300;installed.animations.categories[0].actions=['站立','自制'];
  fs.writeFileSync(path.join(src,'config.json'),JSON.stringify(seed));fs.writeFileSync(path.join(dest,'config.json'),JSON.stringify(installed));
  const read=()=>JSON.parse(fs.readFileSync(path.join(dest,'config.json'),'utf8'));
  f.api.syncActions('testgirl',src,dest);
  let cfg=read();
  assert.deepEqual(cfg.animations.categories.map(c=>[c.id,c.actions]),[['小动作',['站立','自制','挥手']],['玩耍',['跳跳']]]);
  assert.equal(cfg.pets[0].size,300);
  assert.equal(fs.readFileSync(path.join(dest,'animations','站立.webm'),'utf8'),'old');
  assert.ok(!fs.existsSync(path.join(dest,'animations','挥手.webm')));
  cfg.animations.categories[0].actions=['站立','自制'];fs.writeFileSync(path.join(dest,'config.json'),JSON.stringify(cfg));
  f.api.syncActions('testgirl',src,dest);
  assert.deepEqual(read().animations.categories[0].actions,['站立','自制']);
 }finally{f.cleanup();}
});
test('old character folders and default names move to the new ones once, keeping ids and settings',()=>{
 const f=fixture();try{
  const {ROOT,HOME}=f.api,put=(rel,text)=>{const file=path.join(ROOT,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
  const read=rel=>fs.readFileSync(path.join(ROOT,rel),'utf8');
  put('main/config.jsonc','{\n  // 注释\n  "pets": [{"id": "main", "name": "蓝毛小女仆", "size": 300}, {"id": "main__clone_1", "name": "蓝毛小女仆 · 分身1"}]\n}');
  put('main/animations/自制.webm','mine');
  put('character3/config.json',JSON.stringify({pets:[{id:'character3',name:'黄毛该溜子'}]}));
  put('character4/config.json',JSON.stringify({pets:[{id:'character4',name:'我的龙'}]}));
  put('ojousama/config.json',JSON.stringify({pets:[{id:'ojousama1',name:'小克',workStatusEnabled:true}]}));
  const offered=path.join(HOME,'pet-control-client','offered-actions.json');fs.mkdirSync(path.dirname(offered),{recursive:true});
  fs.writeFileSync(offered,JSON.stringify({ojousama:['待机-翻书'],character3:['叉腰嚣张']}));
  assert.equal(f.api.migrationPending(),true);
  f.api.migrateCharacters();
  assert.deepEqual(fs.readdirSync(ROOT).sort(),['Claude','DeepSeek','GPT','Grok']);
  assert.match(read('DeepSeek/config.jsonc'),/\/\/ 注释[\s\S]*"id": "main", "name": "大肥鱼", "size": 300[\s\S]*"name": "大肥鱼 · 分身1"/);
  assert.equal(read('DeepSeek/animations/自制.webm'),'mine');
  assert.equal(JSON.parse(read('Grok/config.json')).pets[0].name,'Grok');
  assert.equal(JSON.parse(read('GPT/config.json')).pets[0].name,'我的龙');
  assert.deepEqual(JSON.parse(read('Claude/config.json')).pets[0],{id:'ojousama1',name:'小克',workStatusEnabled:true});
  assert.deepEqual(JSON.parse(fs.readFileSync(offered,'utf8')),{Claude:['待机-翻书'],Grok:['叉腰嚣张']});
  assert.equal(f.api.projectDir('main'),path.join(ROOT,'DeepSeek'));
  assert.equal(f.api.migrationPending(),false);
  // A later rename by the user stays; an old folder seeded again by an older build is parked, not doubled.
  put('Grok/config.json',JSON.stringify({pets:[{id:'character3',name:'黄毛该溜子'}]}));
  put('ojousama/config.json','{}');
  assert.equal(f.api.migrationPending(),true);
  f.api.migrateCharacters();
  assert.equal(JSON.parse(read('Grok/config.json')).pets[0].name,'黄毛该溜子');
  assert.deepEqual(JSON.parse(read('Claude/config.json')).pets[0].name,'小克');
  assert.ok(fs.readdirSync(ROOT).some(n=>/^ojousama\.old-\d+$/.test(n)));
  assert.ok(!fs.existsSync(path.join(ROOT,'ojousama')));
 }finally{f.cleanup();}
});
