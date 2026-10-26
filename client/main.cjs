const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,dialog,shell,safeStorage}=require('electron');
const path=require('node:path'),fs=require('node:fs');
const service=require('./service.cjs');
const mac=process.platform==='darwin';
// Lightweight self-use build: no API chat, 碎碎念 or balance (see DSH_PET_LITE in service.cjs).
const LITE=true;
const appIcon=path.join(__dirname,mac?'assets/app.png':'assets/app.ico');
app.setName('小小桌宠');fs.mkdirSync(path.join(service.HOME,'pet-control-client'),{recursive:true});app.setPath('userData',path.join(service.HOME,'pet-control-client'));
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
let window,tray,quitting=false;
// macOS: menu-bar-only by default (the bundle sets LSUIElement); the console or tray menu can turn the Dock icon back on.
const settingsFile=path.join(service.HOME,'pet-control-client','mac-settings.json');
function readSettings(){try{return {showDock:false,...JSON.parse(fs.readFileSync(settingsFile,'utf8'))};}catch{return {showDock:false};}}
let settings=readSettings();
if(!app.requestSingleInstanceLock()){app.quit();}else if(process.argv.includes('--quit')){app.quit();}else{
 app.on('second-instance',(_event,argv)=>{if(argv.includes('--quit')){void quitAll();return;}if(window){window.show();if(window.isMinimized())window.restore();window.focus();}});
 app.whenReady().then(async()=>{
  const ai=LITE?null:require('./ai.cjs').createAI({service,safeStorage,onChanged:id=>{if(window&&!window.isDestroyed())window.webContents.send('ai:changed',id);}});
  if(ai){const chatBridge=await require('./chat-bridge.cjs').startChatBridge({ai});service.setChatBridge(chatBridge.env);app.once('before-quit',()=>chatBridge.close());}
  await applyDock();
  try{await service.ensureServer();}catch(e){dialog.showErrorBox('桌宠启动失败',e.message);app.quit();return;}
  try{await service.restoreQuickHidden();}catch(e){console.error('[quick-hide]',e.message);}
  // A pet hidden with Cmd+Q writes this file; refresh the console's switches when it changes.
  fs.watchFile(service.quickHiddenFile,{interval:1000},()=>{service.list().then(publishRoles).catch(()=>{});});app.once('before-quit',()=>fs.unwatchFile(service.quickHiddenFile));
  try{const {startRoleAudit}=require(path.join(service.PACKAGE,'runtime/electron-helper/role-log.js'));const stopAudit=startRoleAudit({root:service.ROOT});app.once('before-quit',stopAudit);}catch(e){console.error('[pet-log] audit start failed:',e.message);}
  try{const broker=require(path.join(service.PACKAGE,'runtime/electron-helper/collision-link.cjs')).startBroker();broker.ready.catch(e=>console.error('[collision]',e.message));app.once('before-quit',()=>{void broker.close();});}catch(e){console.error('[collision] start failed:',e.message);}
  window=new BrowserWindow({width:1100,height:780,minWidth:800,minHeight:620,title:'小小桌宠',backgroundColor:'#faf8f4',autoHideMenuBar:true,show:false,icon:appIcon,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  window.setMenu(null);
  // macOS keeps one app-wide menu; without Edit roles, Cmd+C/V/A stop working in text fields.
  if(mac)Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'appMenu',submenu:[{role:'about'},{type:'separator'},{role:'hide'},{role:'hideOthers'},{role:'unhide'},{type:'separator'},{label:'退出全部桌宠',accelerator:'Command+Q',click:()=>quitAll()}]},{role:'editMenu'},{role:'windowMenu'}]));window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  // Installer/uninstaller requests a normal shutdown before replacing program files.
  if(process.platform==='win32')window.hookWindowMessage(0x8042,()=>{void quitAll();});
  window.webContents.on('will-navigate',event=>event.preventDefault());
  window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
  window.on('show',()=>service.list().then(publishRoles).catch(()=>{}));
  window.once('ready-to-show',()=>window.show());
  // trayColor.png (+@2x): 小克's head cut from the app icon, shown in colour on light and dark menu bars.
  // The monochrome alternative is assets/trayTemplate.png (needs image.setTemplateImage(true)).
  const image=mac?nativeImage.createFromPath(path.join(__dirname,'assets/trayColor.png')):nativeImage.createFromPath(appIcon).resize({width:24,height:24});
  tray=new Tray(image);tray.setToolTip('小小桌宠 · 宠物在后台陪伴');
  tray.on('click',show);tray.on('double-click',show);
  buildTrayMenu();
  const handle=(name,fn)=>ipcMain.handle(name,async(event,...args)=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw Error('无效的窗口');return fn(...args);});
  if(ai){
   handle('ai:settings',()=>ai.settings());
   handle('ai:save',input=>ai.save(input));
   handle('ai:test',()=>ai.test());
   handle('ai:history',id=>ai.history(id));
   handle('ai:send',(id,text)=>ai.send(id,text));
  }
  handle('characters:list',()=>service.list());
  handle('rhythm:get',()=>service.restSeconds());
  handle('rhythm:set',value=>service.setRestSeconds(value));
  handle('characters:resize',(id,size)=>service.resize(id,size).then(publishRoles));
  handle('characters:clone',id=>service.clone(id).then(publishRoles));
  handle('characters:remove-clone',id=>service.clone(id,true).then(publishRoles));
  handle('characters:toggle',(id,visible)=>service.toggle(id,visible));
  handle('characters:play',(id,name)=>service.play(id,name));
  handle('characters:folder',async id=>{const role=await service.find(id);const result=await shell.openPath(role.project);if(result)throw Error(result);return true;});
  handle('characters:hide-all',()=>hideAll());
  handle('characters:show-all',()=>showAll());
  handle('characters:import',async()=>{const result=await dialog.showOpenDialog(window,{title:'选择角色项目（包含 config.json 和 animations 文件夹）',properties:['openDirectory']});if(result.canceled)return null;return service.importProject(result.filePaths[0]);});
  handle('client:quit',()=>quitAll());
  handle('settings:dock-get',()=>settings.showDock);
  handle('settings:dock-set',value=>setShowDock(value));
  if(mac){app.on('activate',show);app.on('before-quit',event=>{if(!quitting){event.preventDefault();void quitAll();}});}
  await window.loadFile(path.join(__dirname,'index.html'),{query:LITE?{lite:'1'}:{}});
  if(ai&&process.argv.includes('--verify-ai'))void require('./verify-ai.cjs').verifyAI(window,ai,service);
 }).catch(e=>{dialog.showErrorBox('控制台出错',e.message);app.quit();});
}
// Without a Dock icon the app is an accessory app, so the console must take focus explicitly.
function show(){if(!window)return;if(mac)app.focus({steal:true});window.show();window.focus();}
function buildTrayMenu(){
 const items=[{label:'打开角色控制台',click:show},{label:'全部开启',click:()=>showAll().catch(e=>dialog.showErrorBox('开启失败',e.message))},{label:'隐藏全部角色',click:()=>hideAll().catch(e=>dialog.showErrorBox('隐藏失败',e.message))},{type:'separator'}];
 if(mac)items.push({label:'在 Dock 栏显示图标',type:'checkbox',checked:settings.showDock,click:item=>{setShowDock(item.checked).catch(e=>dialog.showErrorBox('设置失败',e.message));}},{type:'separator'});
 items.push({label:'退出全部桌宠',click:()=>quitAll()});
 tray.setContextMenu(Menu.buildFromTemplate(items));
}
async function applyDock(){if(!mac)return;if(settings.showDock)await app.dock.show();else app.dock.hide();}
async function setShowDock(value){
 settings={...settings,showDock:Boolean(value)};fs.writeFileSync(settingsFile,JSON.stringify(settings,null,1));
 const visible=window&&!window.isDestroyed()&&window.isVisible();
 await applyDock();
 // Switching activation policy can push the console behind other apps; bring it back.
 if(visible)show();
 if(tray)buildTrayMenu();
 if(window&&!window.isDestroyed())window.webContents.send('settings:dock-changed',settings.showDock);
 return settings.showDock;
}
function publishRoles(roles){if(window&&!window.isDestroyed())window.webContents.send('characters:changed',roles);return roles;}
async function hideAll(){for(const role of await service.list())if(role.visible)await service.toggle(role.id,false);return publishRoles(await service.list());}
async function showAll(){for(const role of await service.list())if(!role.visible)await service.toggle(role.id,true);return publishRoles(await service.list());}
async function quitAll(){try{await service.request('/shutdown','POST');quitting=true;app.quit();}catch(e){if(['ECONNREFUSED','ECONNRESET'].includes(e.code)){quitting=true;app.quit();}else dialog.showErrorBox('退出失败',e.message);}}
app.on('window-all-closed',()=>{});
module.exports={hideAll,showAll,quitAll};
