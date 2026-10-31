/* SAVLY main application: guests local, signed-in accounts in server DB. */
(function(){
'use strict';
const M=window.SavlyModel, $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const guestKey='savly_guest_v2',cachePrefix='savly_cache_v2_';
const presets=[
 {title:'Taco',basePortions:2,ingredients:[{name:'Kjøttdeig',quantity:400,unit:'g'},{name:'Tortillalefser',quantity:6,unit:'stk'},{name:'Tacokrydder',quantity:1,unit:'pk'},{name:'Salat',quantity:1,unit:'stk'}]},
 {title:'Pasta med kjøttdeig',basePortions:2,ingredients:[{name:'Pasta',quantity:250,unit:'g'},{name:'Kjøttdeig',quantity:400,unit:'g'},{name:'Hakkede tomater',quantity:1,unit:'pk'}]},
 {title:'Kylling med ris',basePortions:2,ingredients:[{name:'Kyllingfilet',quantity:400,unit:'g'},{name:'Ris',quantity:200,unit:'g'},{name:'Wokgrønnsaker',quantity:400,unit:'g'}]},
 {title:'Laks med poteter',basePortions:2,ingredients:[{name:'Laks',quantity:300,unit:'g'},{name:'Poteter',quantity:500,unit:'g'}]}
];
const deep=x=>JSON.parse(JSON.stringify(x));
function read(key){try{const v=JSON.parse(localStorage.getItem(key)||'null');return v&&Array.isArray(v.meals)&&Array.isArray(v.list)&&Array.isArray(v.pantry)&&Array.isArray(v.favorites)&&v.prefs?v:null;}catch{return null;}}
function localWrite(key,data){try{localStorage.setItem(key,JSON.stringify(data));return true;}catch{notice('Lagringen på enheten er full eller blokkert. Eksporter data før du fortsetter.');return false;}}
function legacyItem(x,kind){const label=String((kind==='meals'?x.title:x.name)||'').trim();if(!label)return null;
 const item={...x,id:typeof x.id==='string'&&/^[\w-]{1,80}$/.test(x.id)?x.id:M.id()};
 if(kind==='meals'){item.title=label;item.type=item.type||'dinner';item.ingredients=Array.isArray(item.ingredients)?item.ingredients:[];item.portions=Number(item.portions)||2;item.basePortions=Number(item.basePortions)||item.portions;}
 return item;
}
function migrateGuest(){
 const saved=read(guestKey);if(saved)return saved;
 const base=M.empty();
 // Non-destructive best-effort import; original legacy keys are never removed.
 try{
  for(const [key,kind] of [['ms_meals','meals'],['ms_list','list'],['ms_fridge','pantry']]){
   const raw=JSON.parse(localStorage.getItem(key)||'[]');
   if(Array.isArray(raw))base[kind]=raw.map(x=>legacyItem(x,kind)).filter(Boolean);
  }
  const preferences=JSON.parse(localStorage.getItem('ms_prefs')||'{}');
  if(Number.isInteger(preferences.householdSize)&&preferences.householdSize>0&&preferences.householdSize<=30)base.prefs.people=preferences.householdSize;
  if(Array.isArray(preferences.allergies))base.prefs.allergies=preferences.allergies.filter(x=>typeof x==='string').slice(0,30);
  if(preferences.onboarded||base.meals.length||base.list.length)base.prefs.onboarded=true;
 }catch{/* Legacy storage can contain old formats; never delete it. */}
 localWrite(guestKey,base);return base;
}
let doc=migrateGuest(),session=null,identity=null,scope='personal',home=null;
let serverBase=null,revision=0,dirty=false,busy=false,saveTimer=0,changes=0;
let tab='home',weekOffset=0,selectedDay=0,editing=null,searchResults=[],searchText='',searchBusy=false,searchError='';
let undo=null,authenticatedReady=false;
function range(){let d=M.weekStart(new Date());d.setDate(d.getDate()+7*weekOffset);return {first:M.day(d,0),last:M.day(d,6),monday:d};}
function days(){let m=range().monday;return Array.from({length:7},(_,i)=>M.day(m,i));}
function thisWeek(){const r=range();return doc.meals.filter(m=>(!m.type||m.type==='dinner')&&m.date>=r.first&&m.date<=r.last).sort((a,b)=>a.date.localeCompare(b.date));}
function remaining(){return doc.list.filter(x=>!x.done&&!x.haveHome).length;}
function cacheKey(){return identity?cachePrefix+identity.id+'_'+scope:guestKey;}
function notice(text,undoable=false){const n=$('notice');n.hidden=false;n.innerHTML=esc(text)+(undoable?'<button data-action="undo" class="secondary">Angre</button>':'');}
function clearNotice(){const n=$('notice');n.hidden=true;n.textContent='';}
function failed(e){notice((e&&e.message)||'Noe gikk galt. Innholdet ditt er beholdt på enheten.');}
function request(url,body){
 const options={credentials:'same-origin',signal:AbortSignal.timeout(17000)};
 if(body!==undefined){options.method='POST';options.headers={'Content-Type':'application/json','X-SAVLY-CSRF':session?.csrf||''};options.body=JSON.stringify(body);}
 return fetch(url,options).then(async r=>{let result;try{result=await r.json();}catch{throw Error('Serveren ga et uventet svar.');}
   if(!r.ok){const err=Error(result.error||'Kunne ikke gjennomføre handlingen.');err.status=r.status;err.code=result.code;throw err;}
   if(result.csrf)session={...session,csrf:result.csrf,nonce:result.nonce};
   return result;});
}
function changed(){
 changes++;dirty=Boolean(identity);
 localWrite(cacheKey(),doc);
 if(identity){setStatus('Lagrer endringer …');clearTimeout(saveTimer);saveTimer=setTimeout(sync,450);}
 render();
}
function setStatus(message){const el=$('sync-status');if(el)el.textContent=message;}
function regenerate(){const {first,last}=range();doc.list=M.reconcile(doc.list,M.suggested(doc.meals.filter(x=>x.include!==false),first,last));}
async function sync(){
 if(!identity||busy||!dirty)return;
 busy=true;const current=changes,sent=deep(doc);
 try{
  const result=await request('/api/core?scope='+encodeURIComponent(scope),{data:sent,base:serverBase,revision});
  revision=result.revision;serverBase=deep(result.data);
  if(changes===current){doc=deep(result.data);dirty=false;localWrite(cacheKey(),doc);clearNotice();setStatus('Synkronisert');render();}
  else {saveTimer=setTimeout(sync,50);}
 }catch(e){
  setStatus('Ikke synkronisert');if(e.status===409)notice('Samtidig redigering oppdaget. Dine lokale endringer er beholdt. Eksporter dem før du henter serverversjonen.');else failed(e);
 }finally{busy=false;if(dirty&&changes!==current)setTimeout(sync,200);}
}
function adoptLegacyAccount(data){
 if(!data?.personal)return M.empty();
 const out=M.empty();
 for(const [from,to] of [['meals','meals'],['list','list'],['fridge','pantry']]){
  const items=data.personal[from];if(!Array.isArray(items))continue;
  out[to]=items.map(x=>legacyItem(x,from==='fridge'?'pantry':from)).filter(Boolean);
 }
 if(data.prefs){out.prefs.people=data.prefs.householdSize||1;out.prefs.allergies=Array.isArray(data.prefs.allergies)?data.prefs.allergies:[];out.prefs.onboarded=Boolean(data.prefs.onboarded);}
 return out;
}
async function enterCloud(user,oldAccount){
 identity=user;authenticatedReady=false;scope='personal';
 const guest=read(guestKey)||M.empty();
 const cached=read(cacheKey());
 let data;
 try{data=await request('/api/core?scope=personal');}
 catch(e){identity=null;doc=guest;failed(e);render();return;}
 const source=data.data,legacy=adoptLegacyAccount(oldAccount);
 // Legacy account import runs only when no core document exists.
 const emptyCloud=data.revision===0 && !source.meals.length&&!source.list.length&&!source.pantry.length;
 const base=emptyCloud?M.mergeGuest(source,legacy):source;
 const merged=M.mergeGuest(base,guest);
 serverBase=deep(source);revision=data.revision;doc=merged;
 dirty=JSON.stringify(merged)!==JSON.stringify(source);changes++;
 localWrite(cacheKey(),doc);
 authenticatedReady=true;
 if(dirty){await sync();if(!dirty){localStorage.removeItem(guestKey);}}
 if(!dirty)localStorage.removeItem(guestKey);
 render();
}
async function boot(){
 try{
   session=await request('/api/session');
   home=session.home||null;
   if(session.user?.provider==='google')await enterCloud(session.user,session.account?.data);
   else {identity=null;doc=migrateGuest();}
 }catch(e){identity=null;doc=migrateGuest();failed(e);}
 render();
}
function startGoogle(){
 if(!session?.googleClientId){notice('Google-innlogging er ikke konfigurert på serveren. Du kan fortsatt planlegge som gjest.');return;}
 if(!window.google?.accounts?.id){notice('Google sin innloggingsknapp kunne ikke lastes. Prøv senere.');return;}
 const place=$('google-holder');if(!place)return;
 window.google.accounts.id.initialize({
  client_id:session.googleClientId,nonce:session.nonce,auto_select:false,
  callback:async response=>{
   if(!response?.credential)return;
   try{
    const data=await request('/api/auth/google',{credential:response.credential,loginAttempt:session.loginAttempt});
    const check=await request('/api/session');
    if(check.user?.id!==data.user.id)throw Error('Innloggingsøkten kunne ikke bekreftes. Gjestedata er fortsatt lagret.');
    session=check;home=check.home||null;
    await enterCloud(check.user,check.account?.data);
    if(identity)$('profile').close();
   }catch(e){failed(e);try{session=await request('/api/session');renderProfile();}catch{}}
  }
 });
 place.innerHTML='';window.google.accounts.id.renderButton(place,{theme:'outline',size:'large',shape:'pill',text:'continue_with'});
}
async function logout(){
 if(dirty){await sync();if(dirty){notice('Endringer er ikke synkronisert. Eksporter en kopi før du logger ut.');return;}}
 try{await request('/api/auth/logout',{});}catch(e){failed(e);return;}
 identity=null;scope='personal';serverBase=null;revision=0;dirty=false;doc=migrateGuest();session=await request('/api/session');
 $('profile').close();render();
}
function safeTitle(x){return esc(x.title||x.name||'');}
function button(text,action,details='',cls=''){return '<button type="button" data-action="'+action+'" '+details+' class="'+cls+'">'+text+'</button>';}
function render(){
 if(!M)return;
 for(const btn of document.querySelectorAll('#tabs [data-tab]'))btn.setAttribute('aria-current',btn.dataset.tab===tab?'page':'false');
 let html='';
 if(!doc.prefs.onboarded)html=renderWelcome();
 else if(tab==='home')html=renderHome();
 else if(tab==='week')html=renderWeek();
 else if(tab==='list')html=renderList();
 else html=renderSearch();
 $('main').innerHTML=html;
 renderProfile();
}
function renderWelcome(){
 return '<h1>Planlegg middagen, handle det du trenger.</h1><p>Start med to enkle valg. Ingen konto eller betaling.</p>'+
 '<label>Hvor mange personer?<input id="start-people" type="number" min="1" max="30" value="'+esc(doc.prefs.people)+'"></label>'+
 '<label>Allergier eller matvarer dere vil unngå (valgfritt)<input id="start-allergies" value="'+esc((doc.prefs.allergies||[]).join(', '))+'" placeholder="Kan hoppes over"></label>'+
 '<p class="help">Preferansene er bare hjelp til planlegging, ingen allergigaranti. Kontroller alltid innholdet i maten.</p>'+
 button('Velg første middag','onboard','','primary')+
 '<p class="help">Som gjest lagres innholdet på denne enheten. Opprett konto senere for synkronisering.</p>';
}
function renderHome(){
 const today=M.date(new Date()),todays=doc.meals.filter(x=>x.date===today&&(!x.type||x.type==='dinner'));
 const total=thisWeek().length;
 return '<h1>God dag! Hva skal vi spise?</h1>'+
 '<div class="card"><span class="pill">Dagens middag</span><h2>'+ (todays.length?todays.map(x=>M.icon(x.title)+' '+safeTitle(x)).join('<br>'):'Ingen middag planlagt')+'</h2>'+
 button('Planlegg uka','goto','data-tab="week"','primary')+'</div>'+
 '<div class="card"><span class="count">'+remaining()+'</span><p>varer gjenstår på handlelisten.</p>'+
 button('Åpne handleliste','goto','data-tab="list"')+'</div>'+
 (!total?'<div class="empty">Start med én middag, så bygger vi handlelisten derfra.<p>'+button('Legg inn første middag','open-add','','primary')+'</p></div>':
 '<p>'+total+' middag(er) planlagt denne uka. Du kan gjenbruke planen neste uke.</p>')+
 '<div class="actions">'+button('Har hjemme','pantry')+button('Favorittmiddager','goto','data-tab="week"')+'</div>'+
 '<p class="help">'+(identity?'Kontoen synkroniseres når du er på nett.':'Gjestedata lagres bare på enheten. Bruk profilikonet for å lagre i konto.')+'</p>';
}
function renderWeek(){
 const d=days(),meals=thisWeek();
 return '<h1>Ukeplan</h1><div class="date-nav">'+button('← Forrige','prev-week')+
 '<b>'+esc(d[0])+' til '+esc(d[6])+'</b>'+button('Neste →','next-week')+'</div>'+
 '<div class="actions">'+button('Legg til middag','open-add','','primary')+button('Gjenbruk forrige uke','repeat')+button('Oppdater handleliste','generate')+'</div>'+
 '<h2>Velg en oppskrift</h2><p class="help">Enkle SAVLY-eksempler, ikke kopiert fra oppskriftssider.</p><div class="catalog">'+presets.map((r,i)=>button(M.icon(r.title)+' '+esc(r.title),'preset','data-index="'+i+'"')).join('')+'</div>'+
 '<h2>Favoritter</h2>'+(doc.favorites.length?'<div class="catalog">'+doc.favorites.map(x=>button(M.icon(x.title)+' '+safeTitle(x),'use-favorite','data-id="'+esc(x.id)+'"')).join('')+'</div>':'<p class="muted">Ingen favoritter lagret ennå.</p>')+
 d.map((date,i)=>'<section class="day"><div class="day-title"><h2>'+['Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag','Søndag'][i]+'</h2>'+
 button('Legg til','open-add','data-date="'+date+'"')+'</div>'+
 (meals.filter(m=>m.date===date).map(m=>'<div class="card"><div class="row"><div class="name">'+M.icon(m.title)+' '+safeTitle(m)+
 '<div class="sub">'+(Number(m.portions)||1)+' porsjoner'+((m.ingredients||[]).length?' · '+m.ingredients.length+' ingredienser':' · Ingen ingredienser til handlelisten')+'</div></div>'+
 '<label class="checklabel"><input type="checkbox" data-include="'+esc(m.id)+'" '+(m.include===false?'':'checked')+'>Handle</label></div>'+
 '<div class="item-actions">'+button('Rediger','edit-meal','data-id="'+esc(m.id)+'"')+
 button('Kopier','copy-meal','data-id="'+esc(m.id)+'"')+button('Flytt','move-meal','data-id="'+esc(m.id)+'"')+
 button('☆ Favoritt','favorite','data-id="'+esc(m.id)+'"')+button('Slett','delete-meal','data-id="'+esc(m.id)+'"','danger')+'</div></div>').join('')||
 '<p class="muted">Ingen middag denne dagen.</p>')+'</section>').join('')+
 '<p class="help">Velg «Handle» på middagene som skal bidra til ukas handleliste.</p>';
}
function renderList(){
 const rows=doc.list;
 const generated=rows.filter(x=>x.source==='generated').length;
 return '<h1>Handleliste</h1><p>'+remaining()+' varer gjenstår. '+generated+' fra middagsplanen.</p>'+
 '<div class="actions">'+button('Oppdater fra ukeplan','generate','','primary')+button('Har hjemme','pantry')+'</div>'+
 '<form id="add-item"><label>Legg til egen vare<input id="new-item" maxlength="200" required placeholder="F.eks. melk"></label><button class="primary" type="submit">Legg til</button></form>'+
 (rows.length?rows.map(x=>'<div class="row"><label class="checklabel" style="flex:1"><input type="checkbox" data-done="'+esc(x.id)+'" '+(x.done?'checked':'')+'><span class="'+(x.done?'checked':'')+'"><strong>'+esc(x.name)+'</strong><span class="sub" style="display:block">'+
 esc(x.quantity==null?(x.details||'Ukjent mengde'):x.quantity+' '+(x.unit||''))+
 (x.originNames?.length?' · Til '+esc(x.originNames.join(', ')):'')+(x.orphaned?' · Ikke lenger i ukeplanen':'')+'</span></span></label>'+
 '<div class="item-actions">'+button(x.haveHome?'Hjemme ✓':'Har hjemme','have-home','data-id="'+esc(x.id)+'"')+
 button('Endre','edit-item','data-id="'+esc(x.id)+'"')+
 button('Slett','delete-item','data-id="'+esc(x.id)+'"','danger')+'</div></div>').join(''):'<div class="empty">Ingen varer ennå. Velg en middag i ukeplanen eller legg til noe her.</div>');
}
function renderSearch(){
 return '<h1>Søk etter butikkvarer</h1><p class="help">Priser fra Kassalapp når datakilden er tilgjengelig. En kjedepris er ikke garantert i din lokale butikk. Ingen oppdiktede priser.</p>'+
 '<form id="product-search"><label>Hva leter du etter?<input id="product-query" minlength="3" maxlength="100" required value="'+esc(searchText)+'" placeholder="F.eks. melk"></label><button class="primary">Søk etter produkt</button></form>'+
 (searchBusy?'<p role="status">Henter produkter …</p>':searchError?'<p role="alert">'+esc(searchError)+' '+button('Prøv igjen','retry-search')+'</p>':
 searchResults.length?searchResults.map((p,i)=>'<div class="row"><div class="icon">'+(p.image&&p.image.startsWith('https://')?'<img src="'+esc(p.image)+'" alt="" loading="lazy" width="60" height="60" onerror="this.outerHTML=\\'🛒\\'">':'🛒')+'</div>'+
 '<div class="name">'+esc(p.name)+'<div class="sub">'+esc(p.weight?(p.weight+' '+(p.unit||'')):'Ukjent pakning')+' · '+esc(p.store||'Ukjent butikk')+'<br>'+
 (Number.isFinite(p.price)?Number(p.price).toFixed(2)+' kr':'Pris mangler')+
 (Number.isFinite(p.unitPrice)?' · '+Number(p.unitPrice).toFixed(2)+' kr/enhet':'')+
 ' · Prisdato: '+esc(p.priceDate||'ukjent')+'</div></div>'+
 button('Legg til','add-product','data-index="'+i+'"')+'</div>').join(''):
 '<div class="empty">Søk etter et konkret produkt. Ukeplan og handleliste fungerer også når pris-API-et er nede.</div>');
}
function renderProfile(){
 const host=$('profile-body');if(!host)return;
 host.innerHTML='<p><strong>'+(identity?'Innlogget: '+esc(identity.name):'Gjest på denne enheten')+'</strong></p>'+
 '<p id="sync-status" class="help">'+(identity?(dirty?'Endringer venter på synkronisering':'Kontodata lagres på serveren'):'Gjestedata lagres lokalt, ikke i skyen.')+'</p>'+
 (!identity?'<div id="google-holder"></div><p class="help">Logg inn når du ønsker sikkerhetskopi eller delt husholdning. Gjestedata blir da overført.</p>':
 '<div class="actions">'+button('Synkroniser nå','sync')+button('Logg ut','logout')+'</div>')+
 '<h2>Innstillinger</h2><label>Personer<input id="profile-people" type="number" min="1" max="30" value="'+esc(doc.prefs.people)+'"></label>'+
 '<label>Allergier / matvarer å unngå<input id="profile-allergies" value="'+esc((doc.prefs.allergies||[]).join(', '))+'"></label>'+
 button('Lagre innstillinger','settings')+'<p class="help">Allergivalg er aldri en garanti for at en rett er trygg.</p>'+
 '<h2>Dine data</h2><div class="actions">'+button('Eksporter JSON','export')+button('Importer JSON','import')+
 '</div><input id="import-file" type="file" accept="application/json" hidden>'+
 (identity?'<h2>Delt husholdning</h2><p class="help">Husstandsmedlemmer har tilgang til den delte planen. Endringer synkroniseres med konfliktkontroll.</p>'+
 (home?'<p>'+esc(home.name)+' · '+esc(home.members?.length||0)+' medlemmer</p>'+
 '<p>Invitasjonskode: '+esc(home.code||'utløpt')+'</p><div class="actions">'+button(scope==='household'?'Vis personlige data':'Vis delt plan','switch-scope')+
 (scope==='household'?button('Kopier personlige data til delt plan','copy-personal'):'')+'</div>':
 '<form id="create-house"><label>Navn på husholdning<input id="house-name" maxlength="80" placeholder="F.eks. Familien" required></label><button type="submit">Opprett husholdning</button></form><form id="join-house"><label>Invitasjonskode<input id="join-code" required></label><button type="submit">Bli med</button></form>'):'<p class="help">Logg inn for å bruke delt husholdning.</p>')+
 '<p class="help"><a href="/legacy">Åpne den tidligere SAVLY-versjonen</a>. Den gamle lagringen beholdes uendret.</p>';
 if($('profile').open&&!identity)startGoogle();
}
function ingredientsToText(items){return (items||[]).map(x=>x.quantity==null?(x.name+(x.note?' ('+x.note+')':'')):x.quantity+' '+(x.unit||'stk')+' '+x.name).join('\n');}
function parseIngredients(text){return text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).slice(0,100).map(line=>{
 const match=line.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|ml|cl|dl|l|stk|pk)\s+(.+)$/i);
 return match?{quantity:Number(match[1].replace(',','.')),unit:match[2].toLowerCase(),name:match[3].trim()}:{quantity:null,unit:'',name:line,note:'Mengde ikke oppgitt'};
});}
function openMeal(id,date){
 const m=doc.meals.find(x=>x.id===id),d=days();
 editing=m?.id||null;
 $('editor-title').textContent=m?'Rediger middag':'Ny middag';
 $('meal-title').value=m?.title||'';
 $('meal-portions').value=m?.portions||doc.prefs.people;
 $('meal-ingredients').value=ingredientsToText(m?.ingredients);
 $('meal-date').innerHTML=d.map(x=>'<option value="'+x+'">'+x+'</option>').join('');
 $('meal-date').value=m?.date||date||d[selectedDay]||d[0];
 $('editor').showModal();
 $('meal-title').focus();
}
function addPreset(recipe){
 const d=days();
 const m={id:M.id(),title:recipe.title,type:'dinner',date:d[selectedDay],ingredients:deep(recipe.ingredients),basePortions:recipe.basePortions||doc.prefs.people,portions:doc.prefs.people,include:true};
 doc.meals.push(m);regenerate();changed();
}
function setTab(next){tab=next;if(next==='week')weekOffset=0;render();$('main').focus();}
function storeUndo(label){undo=deep(doc);notice(label,true);}
function commit(){regenerate();changed();}
function toastSave(label){changed();notice(label);}
async function search(){
 const v=$('product-query')?.value.trim()||searchText;searchText=v;if(v.length<3){searchError='Skriv minst tre tegn.';render();return;}
 searchBusy=true;searchError='';render();
 try{const data=await request('/api/products?q='+encodeURIComponent(v));searchResults=Array.isArray(data.products)?data.products:[];}
 catch(e){searchError=e.message;searchResults=[];}
 finally{searchBusy=false;render();}
}
function download(){
 const blob=new Blob([JSON.stringify(doc,null,2)],{type:'application/json'});
 const href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;a.download='savly-sikkerhetskopi-'+M.date(new Date())+'.json';
 a.click();setTimeout(()=>URL.revokeObjectURL(href),1000);
}
async function switchScope(){
 if(dirty){await sync();if(dirty){notice('Dine endringer må synkroniseres eller eksporteres før du bytter.');return;}}
 const next=scope==='personal'?'household':'personal';
 try{
  const result=await request('/api/core?scope='+next);
  scope=next;doc=result.data;serverBase=deep(result.data);revision=result.revision;dirty=false;
  localWrite(cacheKey(),doc);$('profile').close();render();
 }catch(e){failed(e);}
}
async function copyPersonal(){
 if(scope!=='household')return;
 try{
  const source=await request('/api/core?scope=personal');doc=M.mergeGuest(doc,source.data);regenerate();changed();
  notice('Dine personlige data er kopiert til den delte planen. Originalene er beholdt.');
 }catch(e){failed(e);}
}
document.addEventListener('click',async e=>{
 const btn=e.target.closest('button');if(!btn)return;
 if(btn.id==='profile-button'){$('profile').showModal();renderProfile();return;}
 if(btn.dataset.tab){setTab(btn.dataset.tab);return;}
 const a=btn.dataset.action,id=btn.dataset.id;
 if(!a)return;
 if(a==='close-profile'){$('profile').close();return;}
 if(a==='close-editor'){$('editor').close();return;}
 if(a==='undo'){if(undo){doc=undo;undo=null;changed();clearNotice();}return;}
 if(a==='onboard'){
  const people=Number($('start-people')?.value);if(!Number.isInteger(people)||people<1||people>30){notice('Velg mellom 1 og 30 personer.');return;}
  doc.prefs={people,allergies:$('start-allergies').value.split(',').map(x=>x.trim()).filter(Boolean).slice(0,30),onboarded:true};
  tab='week';changed();return;
 }
 if(a==='goto'){setTab(btn.dataset.tab||'home');return;}
 if(a==='open-add'){openMeal(null,btn.dataset.date);return;}
 if(a==='prev-week'){weekOffset--;selectedDay=0;render();return;}
 if(a==='next-week'){weekOffset++;selectedDay=0;render();return;}
 if(a==='preset'){addPreset(presets[Number(btn.dataset.index)]);return;}
 if(a==='use-favorite'){const r=doc.favorites.find(x=>x.id===id);if(r)addPreset(r);return;}
 if(a==='repeat'){
  const d=days(),prev=new Date(range().monday);prev.setDate(prev.getDate()-7);
  const first=M.day(prev,0),last=M.day(prev,6),existing=new Set(thisWeek().map(M.mealKey));
  let added=0;
  for(const x of doc.meals.filter(m=>m.date>=first&&m.date<=last)){
   const nd=new Date(x.date+'T12:00:00');nd.setDate(nd.getDate()+7);
   const m={...deep(x),id:M.id(),date:M.date(nd)};
   if(existing.has(M.mealKey(m)))continue;
   existing.add(M.mealKey(m));doc.meals.push(m);added++;
  }
  commit();notice(added?added+' middager kopiert fra forrige uke.':'Denne ukas middager var allerede lagt inn.');return;
 }
 if(a==='generate'){regenerate();changed();notice('Handlelisten er oppdatert uten duplikater.');return;}
 if(a==='edit-meal'){openMeal(id);return;}
 if(a==='copy-meal'||a==='move-meal'){
  const m=doc.meals.find(x=>x.id===id);if(!m)return;
  const date=prompt('Dato (ÅÅÅÅ-MM-DD)',days()[selectedDay]);
  if(!date)return;if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){notice('Bruk datoformat ÅÅÅÅ-MM-DD.');return;}
  if(a==='move-meal')m.date=date;else doc.meals.push({...deep(m),id:M.id(),date});
  commit();return;
 }
 if(a==='delete-meal'){if(!confirm('Slette middagen?'))return;storeUndo('Middagen ble slettet.');doc.meals=doc.meals.filter(x=>x.id!==id);commit();return;}
 if(a==='favorite'){
  const m=doc.meals.find(x=>x.id===id);if(!m)return;
  if(!doc.favorites.some(x=>M.normalized(x.title)===M.normalized(m.title)))doc.favorites.push({id:M.id(),title:m.title,ingredients:deep(m.ingredients||[]),basePortions:m.basePortions||m.portions||1});
  changed();return;
 }
 if(a==='have-home'){const x=doc.list.find(x=>x.id===id);if(x){x.haveHome=!x.haveHome;changed();}return;}
 if(a==='edit-item'){
  const x=doc.list.find(x=>x.id===id);if(!x)return;
  const name=prompt('Varenavn',x.name);if(name===null)return;
  const qty=prompt('Mengde (tomt = ukjent)',x.quantity==null?'':x.quantity);
  if(qty===null)return;
  const unit=prompt('Enhet (g, kg, ml, l, stk eller pk)',x.unit||'');if(unit===null)return;
  if(!name.trim()){notice('Varen må ha et navn.');return;}
  const amount=qty.trim()?Number(qty.replace(',','.')):null;
  if(amount!==null&&(!Number.isFinite(amount)||amount<=0)){notice('Skriv et positivt antall.');return;}
  x.name=name.trim();x.quantity=amount;x.unit=unit.trim();x.manualOverride=true;changed();return;
 }
 if(a==='delete-item'){storeUndo('Varen ble slettet.');doc.list=doc.list.filter(x=>x.id!==id);changed();return;}
 if(a==='pantry'){tab='pantry';$('main').innerHTML=renderPantry();return;}
 if(a==='mark-used'){const x=doc.pantry.find(x=>x.id===id);if(x){x.used=!x.used;changed();tab='pantry';$('main').innerHTML=renderPantry();}return;}
 if(a==='settings'){
  const n=Number($('profile-people')?.value);
  if(!Number.isInteger(n)||n<1||n>30){failed(Error('Velg 1–30 personer.'));return;}
  doc.prefs.people=n;doc.prefs.allergies=$('profile-allergies').value.split(',').map(x=>x.trim()).filter(Boolean).slice(0,30);changed();notice('Innstillingene er lagret.');return;
 }
 if(a==='sync'){await sync();return;}
 if(a==='logout'){await logout();return;}
 if(a==='export'){download();return;}
 if(a==='import'){$('import-file').click();return;}
 if(a==='switch-scope'){await switchScope();return;}
 if(a==='copy-personal'){await copyPersonal();return;}
 if(a==='retry-search'){render();await search();return;}
 if(a==='add-product'){
  const p=searchResults[Number(btn.dataset.index)];if(!p)return;
  doc.list.push({id:M.id(),source:'manual',name:p.name,quantity:1,unit:'pk',done:false,haveHome:false,apiProduct:{id:p.id,ean:p.ean,name:p.name}});
  tab='list';changed();return;
 }
});
function renderPantry(){
 return '<h1>Har hjemme</h1><p class="help">Frivillig oversikt. En kjøpt vare legges ikke inn automatisk, og middag trekker ikke fra lageret.</p>'+
 '<form id="pantry-form"><label>Navn<input id="pantry-name" required maxlength="200" placeholder="F.eks. ris"></label>'+
 '<div class="kv"><label>Mengde (valgfritt)<input id="pantry-quantity" type="number" min="0" step="any"></label>'+
 '<label>Dato (valgfritt)<input id="pantry-date" type="date"></label></div><button class="primary">Legg til</button></form>'+
 doc.pantry.map(x=>'<div class="row"><span class="name '+(x.used?'checked':'')+'">'+esc(x.name)+'<small style="display:block">'+esc(x.quantity||'')+' '+esc(x.date||'')+'</small></span>'+
 button(x.used?'Brukt opp ✓':'Marker brukt opp','mark-used','data-id="'+esc(x.id)+'"')+'</div>').join('')+
 '<p><button data-tab="home">Tilbake til Hjem</button></p>';
}
document.addEventListener('submit',async e=>{
 if(e.target.id==='meal-form'){
  e.preventDefault();const title=$('meal-title').value.trim(),portions=Number($('meal-portions').value),date=$('meal-date').value;
  if(!title||!Number.isInteger(portions)||portions<1||portions>30)return;
  const ingredients=parseIngredients($('meal-ingredients').value);
  if(editing){const m=doc.meals.find(x=>x.id===editing);if(m){Object.assign(m,{title,date,portions,basePortions:portions,ingredients});}}
  else doc.meals.push({id:M.id(),title,date,type:'dinner',portions,basePortions:portions,ingredients,include:true});
  $('editor').close();commit();return;
 }
 if(e.target.id==='add-item'){e.preventDefault();const name=$('new-item').value.trim();if(name){doc.list.push({id:M.id(),name,source:'manual',done:false,haveHome:false});changed();}return;}
 if(e.target.id==='pantry-form'){e.preventDefault();const name=$('pantry-name').value.trim();if(!name)return;
  const q=$('pantry-quantity').value,quantity=q===''?null:Number(q);
  doc.pantry.push({id:M.id(),name,quantity,date:$('pantry-date').value,used:false});changed();$('main').innerHTML=renderPantry();return;
 }
 if(e.target.id==='product-search'){e.preventDefault();await search();return;}
 if(e.target.id==='create-house'||e.target.id==='join-house'){
  e.preventDefault();
  try{
   const create=e.target.id==='create-house';
   const body=create?{name:$('house-name').value.trim(),size:doc.prefs.people,data:{list:[],fridge:[],meals:[]}}:{code:$('join-code').value.trim()};
   const response=await request('/api/household/'+(create?'create':'join'),body);
   home=response.home;renderProfile();notice(create?'Husstand opprettet. Bruk «Vis delt plan» for å dele.':'Du er med i husstanden.');}
  catch(err){failed(err);}
 }
});
document.addEventListener('change',async e=>{
 if(e.target.dataset.include){const m=doc.meals.find(x=>x.id===e.target.dataset.include);if(m){m.include=e.target.checked;commit();}}
 if(e.target.dataset.done){const x=doc.list.find(x=>x.id===e.target.dataset.done);if(x){x.done=e.target.checked;changed();}}
 if(e.target.id==='import-file'){const f=e.target.files[0];if(!f)return;try{
  if(f.size>400000)throw Error('Filen er for stor.');
  const parsed=JSON.parse(await f.text());if(!Array.isArray(parsed.meals)||!Array.isArray(parsed.list)||!Array.isArray(parsed.pantry)||!Array.isArray(parsed.favorites)||!parsed.prefs)throw Error('Ugyldig SAVLY-fil.');
  if(!confirm('Slå sammen innholdet med dagens data? Eksisterende data beholdes.'))return;
  doc=M.mergeGuest(doc,parsed);commit();notice('Data importert.');$('profile').close();
 }catch(err){failed(err);}}
});
window.addEventListener('beforeunload',e=>{if(identity&&dirty){e.preventDefault();e.returnValue='';}});
window.addEventListener('online',()=>{if(identity&&dirty)sync();});
window.addEventListener('visibilitychange',()=>{if(!document.hidden&&identity&&dirty)sync();});
boot();
})();