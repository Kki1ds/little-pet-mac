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
test('new official actions reach an installed character once, keeping the user\'s edits',()=>{
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
  assert.ok(fs.existsSync(path.join(dest,'animations','挥手.webm')));
  cfg.animations.categories[0].actions=['站立','自制'];fs.writeFileSync(path.join(dest,'config.json'),JSON.stringify(cfg));
  f.api.syncActions('testgirl',src,dest);
  assert.deepEqual(read().animations.categories[0].actions,['站立','自制']);
 }finally{f.cleanup();}
});
