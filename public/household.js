/* Shared household state and six-step onboarding. No credentials in browser storage. */
var hhHome=null,hhUser=null,hhBase=null,hhPersonal=null,hhDirty=false,hhBusy=false,hhProblem='',hhTimer=null,hhEdits=0,hhEpoch=0,hhStep=1,hhMode='choice',hhWorking=false,hhEditingSetup=false;
var hhConfig=null,hhBest=[];
var hhJoinCode=new URLSearchParams(location.hash.replace(/^#/,'')).get('join')||'';
if(hhJoinCode)history.replaceState(null,'',location.pathname);
const hhClone=x=>JSON.parse(JSON.stringify(x));
const hhEsc=x=>esc(String(x??''));
const hhIcons={cart:'<path d="M3 3h2l3 12h10l3-9H6M9 20h.01M18 20h.01"/>',store:'<path d="M3 8l2-5h14l2 5v3a3 3 0 0 1-4 2 3 3 0 0 1-5 0 3 3 0 0 1-5 0 3 3 0 0 1-4-2V8zm2 6v7h14v-7M9 21v-6h6v6M3 8h18"/>',heart:'<path d="M20 4c-3-3-7-1-8 1C8-1 0 4 3 10c2 4 9 10 9 10s7-6 9-10c1-2 1-4-1-6z"/>',wallet:'<path d="M19 7V4H5a2 2 0 0 0 0 4h15v12H5a2 2 0 0 1-2-2V6m17 6h-5v4h5"/>',home:'<path d="M3 10l9-7 9 7v11h-6v-8H9v8H3z"/>',users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4M16 3a4 4 0 0 1 0 8"/><circle cx="9" cy="7" r="4"/>',share:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 10 6-4m-6 8 6 4"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',check:'<path d="m4 12 5 5L21 5"/>'};
function hhIcon(kind){return '<svg viewBox="0 0 24 24" aria-hidden="true">'+hhIcons[kind]+'</svg>';}
document.querySelectorAll('[data-icon]').forEach(x=>x.innerHTML=hhIcon(x.dataset.icon));
async function hhRequest(path,body,requestCsrf){
 const opts={credentials:'same-origin',signal:AbortSignal.timeout(15000)};
 if(body!==undefined){opts.method='POST';opts.headers={'Content-Type':'application/json','X-SAVLY-CSRF':requestCsrf??hhConfig?.csrf??''};opts.body=JSON.stringify(body);}
 let response;
 try{response=await fetch(path,opts);}catch{throw new Error('Ingen kontakt med SAVLY-serveren. Endringene er ikke sendt.');}
 let data;try{data=await response.json();}catch{throw new Error('Start den nye server.py og åpne appen via serveradressen.');}
 if(!response.ok){const err=new Error(data.error||'Kunne ikke fullføre.');err.status=response.status;err.code=data.code;throw err;}
 if(data.csrf)hhConfig={...hhConfig,csrf:data.csrf,nonce:data.nonce};return data;
}
var hhReady=hhRequest('/api/session').then(data=>{hhConfig=data;hhSetupGoogle();return data;}).catch(e=>{document.getElementById('googleStatus').textContent=e.message;return null;});
function hhGoogleUnavailable(){document.getElementById('googleStatus').textContent='Google må aktiveres med en klient-ID på serveren. Du kan bruke testkontoen under i mellomtiden.';}
function hhSetupGoogle(){
 const status=document.getElementById('googleStatus');
 if(!hhConfig?.googleClientId){status.textContent='Google er ikke aktivert på denne serveren ennå.';return;}
 const render=()=>{
  const attempt={...hhConfig};
  google.accounts.id.initialize({client_id:attempt.googleClientId,callback:result=>hhGoogleLogin(result,attempt),nonce:attempt.nonce,auto_select:false});
  document.getElementById('googleButton').innerHTML='';google.accounts.id.renderButton(document.getElementById('googleButton'),{theme:'outline',size:'large',text:'continue_with',shape:'pill',width:280});
  document.getElementById('googleFallback').hidden=true;status.textContent='Logg inn for å finne igjen husstanden din.';
 };
 if(window.google?.accounts?.id){render();return;}
 if(document.getElementById('googleIdentityScript'))return;
 const script=document.createElement('script');script.id='googleIdentityScript';script.src='https://accounts.google.com/gsi/client?hl=nb';script.async=true;script.onload=render;script.onerror=()=>{status.textContent='Google kunne ikke lastes. Prøv igjen senere.';};document.head.appendChild(script);
}
async function hhGoogleLogin(result,attempt){
 if(hhWorking)return;hhWorking=true;
 const err=document.getElementById('authErr');err.textContent='';
 try{
  if(!attempt?.loginAttempt)throw new Error('Innloggingsknappen må oppdateres. Last siden på nytt.');
  const data=await hhRequest('/api/auth/google',{credential:result.credential,loginAttempt:attempt.loginAttempt},attempt.csrf);
  // Do not claim success unless the new authenticated cookie is retained.
  const check=await hhRequest('/api/session');
  if(check.user?.id!==data.user.id)throw new Error('Nettleseren beholdt ikke innloggingen. Feilkode: AUTH_COOKIE_NOT_RETAINED.');
  hhConfig=check;hhAuthenticated(check);
 }catch(e){err.textContent=e.message;
  // Prepare a fresh single-use attempt without automatically resubmitting.
  try{hhConfig=await hhRequest('/api/session');hhSetupGoogle();}catch{}
 }finally{hhWorking=false;}
}
async function authSubmit(){
 if(hhWorking)return;const err=document.getElementById('authErr');err.textContent='';
 const email=document.getElementById('authEmail').value.trim(),password=document.getElementById('authPass').value,name=document.getElementById('authName').value.trim();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){err.textContent='Skriv inn en gyldig e-postadresse.';return;}
 if(password.length<8){err.textContent='Bruk minst 8 tegn i testpassordet.';return;}
 if(state.authMode==='signup'&&!name){err.textContent='Skriv inn navnet ditt.';return;}
 hhWorking=true;document.getElementById('authBtn').disabled=true;
 try{
  await hhReady;if(!hhConfig)throw new Error('Ingen kontakt med serveren. Last inn siden på nytt.');
  const data=await hhRequest('/api/auth/demo',{name:name||'Testbruker'});
  ['authName','authEmail','authPass'].forEach(id=>document.getElementById(id).value='');hhAuthenticated(data);
 }catch(e){err.textContent=e.message;}finally{hhWorking=false;document.getElementById('authBtn').disabled=false;}
}
async function startLocalApp(){
 if(hhWorking)return;hhWorking=true;
 try{await hhReady;const data=await hhRequest('/api/auth/demo',{name:document.getElementById('localName').value.trim()||'Testbruker'});hhAuthenticated(data);}catch(e){document.getElementById('authErr').textContent=e.message;}finally{hhWorking=false;}
}
function hhAuthenticated(data){
 hhUser=data.user;state.user={name:data.user.name,email:'',verified:true,provider:data.user.provider,prototype:data.user.provider==='demo'};state.prototypeSetupComplete=false;
 hhEpoch++;hhDirty=false;hhBusy=false;hhProblem='';hhHome=null;hhBase=null;
 if(data.home)hhEnter(data.home);renderUser();showAuth();go('home');openSetup();
}
var hhOldLogout=logout;
logout=async function(){
 if(hhDirty&&!confirm('Du har endringer som ikke er delt. Logge ut og forkaste disse?'))return;
 try{await hhRequest('/api/auth/logout',{});}catch(e){toast(e.message);return;}
 hhExit();hhUser=null;hhOldLogout();hhSetupGoogle();
}
async function openAccountSetup(){if(state.user){await logout();if(state.user)return;}setAuthMode('signup');showAuth();}
function hhSnapshot(){
 for(const kind of ['list','fridge','meals'])for(const item of state[kind])if(!item.id)item.id='item-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
 return hhClone({list:state.list,fridge:state.fridge,meals:state.meals});
}
function hhDisplay(){renderList();renderFridge();renderMealHome();if(document.getElementById('screen-meals').classList.contains('active'))renderMealPlan();hhRenderProfile();hhStatus();}
function hhEnter(home){
 if(!hhHome)hhPersonal=hhSnapshot();hhHome=home;hhBase=hhClone(home.data);
 for(const key of ['list','fridge','meals'])state[key]=hhClone(home.data[key]);
 hhResetUndo();hhDisplay();
}
function hhResetUndo(){listBackup=null;rfBackup=null;mealUndo=null;for(const id of ['listUndo','rfUndo']){const e=document.getElementById(id);if(e)e.hidden=true;}}
function hhExit(){
 hhEpoch++;clearTimeout(hhTimer);hhDirty=false;hhBusy=false;hhProblem='';hhHome=null;hhBase=null;
 if(hhPersonal)for(const key of ['list','fridge','meals'])state[key]=hhClone(hhPersonal[key]);
 hhPersonal=null;hhResetUndo();hhDisplay();
}
var hhSaveList=saveList,hhSaveFridge=saveFridge,hhSaveMeals=saveMeals;
saveList=function(){if(hhHome)hhQueue();else hhSaveList();}
saveFridge=function(){if(hhHome)hhQueue();else hhSaveFridge();}
saveMeals=function(){if(hhHome){hhQueue();renderMealHome();}else hhSaveMeals();}
function hhQueue(){hhSnapshot();hhDirty=true;hhEdits++;hhProblem='';hhStatus();clearTimeout(hhTimer);hhTimer=setTimeout(hhSync,350);}
async function hhSync(){
 if(!hhHome||!hhDirty||hhBusy)return;hhBusy=true;hhStatus();
 const epoch=hhEpoch,edits=hhEdits,sent=hhSnapshot(),homeId=hhHome.id;
 try{
  const d=await hhRequest('/api/household/sync',{homeId,base:hhBase,data:sent});if(epoch!==hhEpoch)return;
  hhHome=d.home;hhProblem='';
  if(hhEdits===edits){hhDirty=false;hhBase=hhClone(d.home.data);for(const k of ['list','fridge','meals'])state[k]=hhClone(d.home.data[k]);hhDisplay();}
  else hhBase=sent;
 }catch(e){if(epoch===hhEpoch)hhProblem=e.message;}
 finally{if(epoch===hhEpoch){hhBusy=false;hhStatus();if(hhDirty&&!hhProblem)hhTimer=setTimeout(hhSync,300);}}
}
function hhStatus(){
 const e=document.getElementById('householdSyncBar');if(!e)return;e.hidden=!hhHome;
 if(!hhHome)return;
 e.innerHTML='<b>'+hhEsc(hhHome.name)+'</b> · '+(hhBusy?'Deler endringer …':hhProblem?hhEsc(hhProblem):hhDirty?'Endringer venter på deling':'Handleliste, kjøleskap og ukeplan er felles.')+(hhProblem?'<div><button onclick="hhSync()">Prøv igjen</button><button onclick="exportSavlyData()">Last ned din kopi</button><button onclick="hhReloadShared()">Hent felles versjon</button></div>':'');
}
async function hhReloadShared(){
 if(hhDirty&&!confirm('Erstatte dine usendte endringer med husstandens lagrede versjon? Du kan laste ned din kopi først.'))return;
 try{const d=await hhRequest('/api/household');hhDirty=false;hhProblem='';if(d.home)hhEnter(d.home);else hhExit();}catch(e){toast(e.message);}
}
setInterval(async()=>{
 if(!hhHome||hhBusy||hhDirty||document.hidden||document.querySelector('.overlay.show')||document.body.classList.contains('savly-onboarding-active')||rfEdit)return;
 const epoch=hhEpoch;
 try{const d=await hhRequest('/api/household');if(epoch!==hhEpoch||hhBusy||hhDirty)return;if(!d.home){hhExit();toast('Du er ikke lenger med i husstanden.');}else if(d.home.revision!==hhHome.revision){hhEnter(d.home);}else{hhHome=d.home;hhRenderProfile();}hhProblem='';hhStatus();}
 catch(e){if(epoch===hhEpoch){hhProblem=e.message;hhStatus();}}
},4000);
window.addEventListener('beforeunload',e=>{if(hhDirty){e.preventDefault();e.returnValue='';}});

function openSetup(){
 closeModal();hhEditingSetup=Boolean(state.prototypeSetupComplete);
 obDraft={stores:[...(state.prefs.favoriteStores||[])],household:hhHome?.size||state.prefs.householdSize||1,priority:state.prefs.shoppingPriority||'balanced',diet:[...(state.prefs.diet||[])],allergies:[...(state.prefs.allergies||[])]};
 document.getElementById('obArea').value=state.prefs.area||'';hhSetPriority(obDraft.priority);hhBudget(state.budget||2500);hhSetCount(obDraft.household);
 obDraft.diet=[...new Set(obDraft.diet.map(x=>x==='keto'?'lowcarb':x).filter(x=>!['paleo','Rødt kjøtt sjelden'].includes(x)))];renderStoreChoices();hhRenderDiet();renderAllergenChoices();hhMode=hhJoinCode&&!hhHome?'join':'choice';lockAppForOnboarding();obNext(1);
}
function obNext(step){
 if(step<1){if(hhEditingSetup)unlockAppAfterOnboarding();return;}
 if(step>2&&!obDraft.stores.length){toast('Velg minst én butikk.');step=2;}
 if(step>4){const b=Number(document.getElementById('setupBudget').value);if(!Number.isFinite(b)||b<500||b>30000){toast('Velg et budsjett mellom 500 og 30 000 kr.');step=4;}}
 if(state.isPro&&step>=7){finishSavlyOnboarding('pro');return;}
 const stepCount=state.isPro?6:7;
 hhStep=Math.min(stepCount,step);
 const finishButton=document.querySelector('[data-step="6"] .setup-next');
 finishButton.textContent=state.isPro?'Lagre og fortsett →':'Velg din versjon →';
 document.querySelectorAll('#savlyOnboarding [data-step]').forEach(x=>x.hidden=Number(x.dataset.step)!==hhStep);
 document.querySelectorAll('.setup-progress i').forEach((x,i)=>{x.hidden=i>=stepCount;x.classList.toggle('active',i<hhStep);x.classList.toggle('current',i===hhStep-1);});
 document.querySelector('.setup-progress').setAttribute('aria-label','Steg '+hhStep+' av '+stepCount);
 document.querySelector('.setup-back').style.visibility=hhStep===1&&!hhEditingSetup?'hidden':'visible';
 if(hhStep===5)hhRenderHouseholds();if(hhStep===6)hhSummary();
 document.getElementById('savlyOnboarding').scrollTop=0;const heading=document.querySelector('[data-step="'+hhStep+'"] h2');heading.tabIndex=-1;heading.focus({preventScroll:true});
}
function hhBudget(value,numberField=false){
 if(!numberField)document.getElementById('setupBudget').value=value;
 document.getElementById('setupBudgetRange').value=value;
}
function hhSetCount(count){
 if(!Number.isInteger(count)||count<1||count>30){toast('Velg mellom 1 og 30 personer.');return;}
 obDraft.household=count;document.getElementById('setupCount').innerHTML=[1,2,3,4,5].map(n=>'<button type="button" class="'+((n===5?count>=5:n===count)?'selected':'')+'" aria-pressed="'+(n===5?count>=5:n===count)+'" onclick="hhSetCount('+n+')">'+(n===5?'5+':n)+'</button>').join('');
 document.getElementById('setupExactCount').hidden=count<5;document.getElementById('setupCountNumber').value=Math.max(5,count);
}
function hhSetPriority(value){
 const choices=[['balanced','Balanser pris og butikkvaner','Veier registrerte priser opp mot butikker du pleier å velge.'],['price','Lavest mulig pris','Prioriterer laveste sammenlignbare pris. Kan foreslå flere butikker.'],['time','Færrest butikkstopp','Prioriterer å samle handelen i én butikk, selv om noen varer koster mer.']];
 const chosen=choices.some(x=>x[0]===value)?value:'balanced';
 obDraft.priority=chosen;document.getElementById('setupPriority').value=chosen;
 document.getElementById('setupPriorityChoices').innerHTML=choices.map(([key,label,description])=>'<button type="button" class="priority-choice" aria-pressed="'+(key===chosen)+'" onclick="hhSetPriority(\''+key+'\')"><span><b>'+label+'</b><small>'+description+'</small></span><span aria-hidden="true">'+(key===chosen?'✓':'○')+'</span></button>').join('');
}
function hhRenderDiet(){
 const labels={...DIET_LABELS,lowcarb:'Karbohydratfattig',lowfodmap:'FODMAP-fattig'};
 const options=[...new Set([...DIET_OPTS,'lowcarb','lowfodmap',...obDraft.diet])].filter(x=>!['keto','paleo','Rødt kjøtt sjelden'].includes(x));
 document.getElementById('setupDietChoices').innerHTML=options.map((x,i)=>'<button class="'+(obDraft.diet.includes(x)?'selected':'')+'" aria-pressed="'+obDraft.diet.includes(x)+'" onclick="hhToggleDiet('+i+')">'+hhEsc(labels[x]||x)+'</button>').join('')+'<button class="'+(!obDraft.diet.length?'selected':'')+'" onclick="hhToggleDiet(-1)">Ingen spesielle</button>';
 window.hhDietOptions=options;
}
function hhToggleDiet(i){const x=window.hhDietOptions[i];obDraft.diet=i<0?[]:obDraft.diet.includes(x)?obDraft.diet.filter(v=>v!==x):[...obDraft.diet,x];hhRenderDiet();}
function renderAllergenChoices(){
 const main=[...new Set([...ALLERGY_OPTS,...obDraft.allergies])];window.hhAllergyOptions=[...main,...ALLERGEN_DETAILS];
 const button=(x,i)=>'<button class="'+(obDraft.allergies.includes(x)?'selected':'')+'" aria-pressed="'+obDraft.allergies.includes(x)+'" onclick="hhToggleAllergy('+i+')">'+hhEsc(ALLERGEN_LABELS[x]||x)+'</button>';
 document.getElementById('setupMainAllergens').innerHTML=main.map(button).join('')+'<button class="'+(!obDraft.allergies.length?'selected':'')+'" onclick="hhToggleAllergy(-1)">Ingen</button>';
 document.getElementById('setupExtraAllergens').innerHTML='';
}
function hhToggleAllergy(i){const x=window.hhAllergyOptions[i];obDraft.allergies=i<0?[]:obDraft.allergies.includes(x)?obDraft.allergies.filter(v=>v!==x):[...obDraft.allergies,x];renderAllergenChoices();}
function hhSummary(){document.getElementById('setupSummary').innerHTML='<div><span>Butikker</span><b>'+obDraft.stores.map(id=>hhEsc(STORE_NAMES[id])).join(', ')+'</b></div><div><span>Budsjett</span><b>'+hhEsc(document.getElementById('setupBudget').value)+' kr/mnd</b></div><div><span>Personer</span><b>'+obDraft.household+'</b></div><div><span>Husstand</span><b>'+hhEsc(hhHome?.name||'Kan settes opp senere')+'</b></div>';}
async function finishSavlyOnboarding(plan=state.isPro?'pro':'free'){
 if(hhWorking)return;const budget=Number(document.getElementById('setupBudget').value);
 if(!obDraft.stores.length){obNext(2);return;}if(!Number.isFinite(budget)||budget<500||budget>30000){obNext(4);return;}
 hhWorking=true;
 try{
  if(hhHome?.owner&&hhHome.size!==obDraft.household){const d=await hhRequest('/api/household/update',{name:hhHome.name,size:obDraft.household});hhHome=d.home;}
  state.budget=budget;savlyStore('ms_budget',String(budget));
  Object.assign(state.prefs,{favoriteStores:[...obDraft.stores],householdSize:hhHome?.size||obDraft.household,shoppingPriority:document.getElementById('setupPriority').value,diet:[...obDraft.diet],allergies:[...obDraft.allergies],area:document.getElementById('obArea').value.trim(),onboarded:true});
  savlyStore('ms_prefs',JSON.stringify(state.prefs));state.storeFilter=Object.fromEntries(Object.keys(STORE_NAMES).map(id=>[id,obDraft.stores.includes(id)]));savlyStore('ms_stores',JSON.stringify(state.storeFilter));renderStoreFilter();state.prototypeSetupComplete=true;unlockAppAfterOnboarding();renderPrefs();renderHomeBudget();renderList();state.isPro=plan==='pro';if(state.isPro){savlyStore('ms_pro','1');}else{localStorage.removeItem('ms_pro');}go('home');hhRenderProfile();toast(plan==='pro'?'Pro-demo er aktivert. Ingen betaling eller abonnement.':'SAVLY Gratis er klar for deg.');
 }catch(e){toast(e.message);}finally{hhWorking=false;}
}

function hhCard(compact=false){
 const h=hhHome;if(!h)return '';
 return '<div class="hh-panel"><h3><span class="hh-icon">'+hhIcon('home')+'</span>'+hhEsc(h.name)+'</h3><p>Medlemmer · '+h.members.length+' kontoer · '+h.size+' personer i husstanden</p><div class="hh-members">'+h.members.map(m=>'<span class="hh-member">'+hhEsc(m.name)+(m.owner?' · admin':'')+'</span>').join('')+'</div><div class="hh-code"><div><small>Invitasjonskode</small><strong>'+hhEsc(h.code||'Utløpt')+'</strong></div>'+(h.code?'<button aria-label="Kopier invitasjonskode" onclick="hhCopyCode()"><span class="hh-icon">'+hhIcon('copy')+'</span></button>':'')+'</div><div class="hh-row"><button class="hh-primary" onclick="hhShare()" '+(!h.code?'disabled':'')+'><span class="hh-icon">'+hhIcon('share')+'</span>Del link</button><button class="hh-danger" onclick="hhLeave()">Forlat</button></div>'+
 (!compact&&h.owner?'<details><summary class="hh-link">Administrer husstanden</summary><label>Navn<input id="hhEditName" maxlength="80" value="'+hhEsc(h.name)+'"></label><label>Antall personer<input id="hhEditSize" type="number" min="1" max="30" value="'+h.size+'"></label><button class="hh-primary" onclick="hhUpdate()">Lagre</button><button class="hh-link" onclick="hhRotate()">Lag ny invitasjonskode</button></details>':'')+
 (!compact?'<p class="hh-session-note">'+(hhUser?.provider==='demo'?'Testkonto: Medlemskapet gjelder denne økten. Bruk Google når du vil finne igjen husstanden senere.':'Google-kontoen din finner igjen husstanden ved neste innlogging.')+'</p>':'')+'</div>';
}
function hhChoice(){
 return '<button class="hh-primary" onclick="hhSetMode(\'create\')"><span class="hh-icon">'+hhIcon('home')+'</span> Opprett husstand</button><button class="hh-secondary" onclick="hhSetMode(\'join\')"><span class="hh-icon">'+hhIcon('users')+'</span>Bli med i husstand</button><p class="setup-note hh-session-note">Du kan også hoppe over og sette opp husstand senere i profilen.</p>';
}
function hhForm(where){
 const join=hhMode==='join';return '<div class="hh-form"><label class="hh-session-note" for="'+where+'Input">'+(join?'Invitasjonskode':'Navn på husstand')+'</label><input id="'+where+'Input" type="text" maxlength="'+(join?'20':'80')+'" placeholder="'+(join?'INVITASJONSKODE':'F.eks. Familien Hansen')+'" value="'+(join?hhEsc(hhJoinCode):'')+'" autocomplete="off" '+(join?'autocapitalize="characters"':'')+'>'+
 (!join?'<label class="hh-session-note" for="'+where+'Size">Antall personer</label><input type="number" id="'+where+'Size" min="1" max="30" value="'+(obDraft.household||state.prefs.householdSize||1)+'"><label class="check"><input type="checkbox" id="'+where+'Import" checked> Ta med min handleliste, ukeplan og kjøleskap i den nye husstanden.</label>':'<p class="hh-session-note">Husstandens data vises når du blir med. Dine personlige lister beholdes separat.</p>')+
 '<button class="hh-primary" onclick="hhSubmitHome(\''+where+'\')" '+(hhWorking?'disabled':'')+'>'+(hhWorking?'Et øyeblikk …':join?'Bli med i husstand':'Opprett husstand')+'</button><button class="hh-link" onclick="hhSetMode(\'choice\')">Tilbake</button></div>';
}
function hhSetMode(mode){hhMode=mode;hhRenderHouseholds();}
function hhRenderHouseholds(){
 for(const [id,key] of [['setupHousehold','setupHome'],['householdContent','profileHome']]){
  const e=document.getElementById(id);if(e)e.innerHTML=hhHome?hhCard(id==='setupHousehold'):hhMode==='choice'?hhChoice():hhForm(key);
 }
 hhRenderProfile();
}
function hhRenderProfile(){const e=document.getElementById('profileHousehold');if(e)e.innerHTML=hhHome?'<h4>HUSSTAND</h4>'+hhCard(true):'';}
function openHousehold(){closeModal();hhMode='choice';hhRenderHouseholds();openModal('householdSheet');}
var hhOldProfile=openProfile;
openProfile=function(){hhRenderProfile();hhOldProfile();document.getElementById('pfStatus').textContent=hhUser?.provider==='google'?'Google-konto':'Testkonto';}
async function hhSubmitHome(where){
 if(hhWorking)return;const input=document.getElementById(where+'Input'),value=input.value.trim();if(!value){input.focus();toast('Fyll inn feltet først.');return;}
 const join=hhMode==='join';const body=join?{code:value}:{name:value,size:Number(document.getElementById(where+'Size').value),data:document.getElementById(where+'Import').checked?hhSnapshot():{list:[],fridge:[],meals:[]}};
 hhWorking=true;
 try{const d=await hhRequest('/api/household/'+(join?'join':'create'),body);hhEnter(d.home);hhJoinCode='';obDraft.household=d.home.size;hhSetCount(d.home.size);hhMode='choice';toast(join?'Du er med i husstanden.':'Husstanden er opprettet.');}
 catch(e){toast(e.message);hhWorking=false;return;}finally{hhWorking=false;}hhRenderHouseholds();
}
async function hhCopy(text){try{await navigator.clipboard.writeText(text);toast('Kopiert.');}catch{prompt('Kopier denne teksten:',text);}}
function hhCopyCode(){if(hhHome?.code)hhCopy(hhHome.code);}
async function hhShare(){
 if(!hhHome?.code)return;const url=location.origin+'/#join='+encodeURIComponent(hhHome.code);
 const text='Bli med i '+hhHome.name+' på SAVLY. Kode: '+hhHome.code;
 if(navigator.share){try{await navigator.share({title:'SAVLY · husstand',text,url});return;}catch(e){if(e.name==='AbortError')return;}}
 hhCopy(text+'\n'+url);
}
async function hhLeave(){
 if(hhWorking||!hhHome)return;
 if(!confirm('Forlate '+hhHome.name+'? Dine personlige lister vises igjen.'+(hhDirty?' Usendte endringer forkastes.':'')))return;
 hhWorking=true;
 try{await hhRequest('/api/household/leave',{});hhExit();hhMode='choice';hhRenderHouseholds();toast('Du har forlatt husstanden.');}catch(e){toast(e.message);}finally{hhWorking=false;}
}
async function hhUpdate(){
 if(hhWorking)return;hhWorking=true;
 try{const d=await hhRequest('/api/household/update',{name:document.getElementById('hhEditName').value,size:Number(document.getElementById('hhEditSize').value)});hhHome=d.home;hhRenderHouseholds();hhStatus();toast('Husstanden er oppdatert.');}catch(e){toast(e.message);}finally{hhWorking=false;}
}
async function hhRotate(){
 if(!confirm('Lage en ny kode? Gamle invitasjoner vil slutte å virke.'))return;
 try{const d=await hhRequest('/api/household/rotate',{});hhHome=d.home;hhRenderHouseholds();toast('Ny invitasjonskode er klar.');}catch(e){toast(e.message);}
}
async function hhLoadBest(){
 const button=document.getElementById('weeklyBestButton'),host=document.getElementById('weeklyBestItems');if(!button||!host||button.disabled)return;
 button.disabled=true;host.innerHTML='<p role="status">Henter utvalgte varer …</p>';hhBest=[];
 const queries=(state.prefs.favoriteItems?.length?state.prefs.favoriteItems:['Kylling','Egg','Melk']).slice(0,3);
 const ids=state.prefs.favoriteStores||[];let error='';
 for(const q of queries){try{const d=await apiGet('/api/products?q='+encodeURIComponent(q));const choices=d.products.filter(p=>ids.includes(p.store)&&apiFresh(p)).sort((a,b)=>(b.relevance||0)-(a.relevance||0)||a.price-b.price);const p=choices[0];if(p&&!hhBest.some(x=>x.id===p.id))hhBest.push(p);}catch(e){error=e.message;break;}}
 host.innerHTML=hhBest.map((p,i)=>'<div class="weekly-buy">'+(p.image?'<img alt="" loading="lazy" src="'+hhEsc(p.image)+'" referrerpolicy="no-referrer" onerror="this.hidden=true">':'')+'<div><b>'+hhEsc(p.name)+'</b><small>'+hhEsc(STORE_NAMES[p.store])+' · '+hhEsc(apiPack(p))+' · '+apiDate(p.priceDate)+'</small><strong>'+fmt(p.price)+'</strong><br><button onclick="hhBestAdd('+i+')">Legg i handlelista</button></div></div>').join('')+(error?'<p>'+hhEsc(error)+'</p>':!hhBest.length?'<p>Ingen nyere priser i dette utvalget hos dine favorittbutikker. Du kan søke etter en bestemt vare.</p>':'<p>Registrerte priser fra Kassalapp. Ingen rabatt eller laveste pris på tvers av hele markedet er garantert.</p>');
 button.disabled=false;button.textContent='Oppdater utvalget';
}
function hhBestAdd(index){const p=hhBest[index];if(!p)return;apiTarget=null;apiResults=[p];apiPick(0);}
// Replace old offers shortcuts without exposing a second offers tab.
hhRenderProfile();

document.getElementById("avatarBtn").removeEventListener("click",hhOldProfile);
document.getElementById("avatarBtn").addEventListener("click",openProfile);
