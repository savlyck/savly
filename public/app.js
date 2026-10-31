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
 if(localStorage.getItem('savly_legacy_migrated_v2')==='yes')return M.empty();
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
let serverBase=null,revision=0,dirty=false,busy=false,syncBlocked=false,saveTimer=0,changes=0;
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
 if(!identity||busy||!dirty||syncBlocked)return;
 busy=true;const current=changes,sent=deep(doc);
 try{
  const result=await request('/api/core?scope='+encodeURIComponent(scope),{data:sent,base:serverBase,revision});
  revision=result.revision;serverBase=deep(result.data);
  if(changes===current){doc=deep(result.data);dirty=false;localWrite(cacheKey(),doc);clearNotice();setStatus('Synkronisert');render();}
  else {
   try{doc=M.rebase(sent,doc,result.data);localWrite(cacheKey(),doc);saveTimer=setTimeout(sync,50);}
   catch(err){syncBlocked=true;notice(err.message+' Dine lokale endringer er beholdt.');}
  }
 }catch(e){
  setStatus('Ikke synkronisert');if(e.status===409){syncBlocked=true;notice('Samtidig redigering oppdaget. Dine lokale endringer er beholdt. Eksporter dem før du henter serverversjonen.');}else failed(e);
 }finally{busy=false;if(dirty&&changes!==current&&!syncBlocked)setTimeout(sync,200);}
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
 serverBase=deep(source);revision=data.revision;doc=merged;syncBlocked=false;
 dirty=JSON.stringify(merged)!==JSON.stringify(source);changes++;
 localWrite(cacheKey(),doc);
 authenticatedReady=true;
 if(dirty)await sync();
 if(!dirty){localStorage.setItem('savly_legacy_migrated_v2','yes');localStorage.removeItem(guestKey);}
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

function uiIcon(name){
 const paths={
  week:'<rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M7.5 3v4M16.5 3v4M3.5 10h17M8 15h8"/>',
  pantry:'<path d="M4 7.5h16v13H4zM3 4h18v3.5H3zM8 12h8M8 16h5"/>',
  product:'<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/>'
 };
 return '<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(paths[name]||paths.product)+'</svg>';
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
 else if(tab==='pantry')html=renderPantry();
 else html=renderSearch();
 $('main').innerHTML=html;
 renderProfile();
}
function renderWelcome(){
 return '<div class="page-intro"><span class="eyebrow">VELKOMMEN TIL SAVLY</span>'+
 '<h1>Planlegg middagen, handle det du trenger.</h1>'+
 '<p class="intro-copy">Mindre tid på å lure på hva du skal spise. Mer oversikt over det du faktisk trenger å handle.</p></div>'+
 '<div class="welcome-layout"><div class="welcome-panel"><span class="eyebrow">KOM I GANG</span><h2>Det starter med én middag.</h2>'+
 '<p class="help">To enkle valg nå, resten tar vi senere. Du trenger ingen konto.</p>'+
 '<label>Hvor mange personer?<input id="start-people" type="number" min="1" max="30" value="'+esc(doc.prefs.people)+'"></label>'+
 '<label>Allergier eller matvarer dere vil unngå (valgfritt)<input id="start-allergies" value="'+esc((doc.prefs.allergies||[]).join(', '))+'" placeholder="Hopp over hvis ingen"></label>'+
 '<p class="help">Allergivalg gir aldri garanti for at en rett er trygg. Sjekk ingredienser og emballasje.</p>'+
 button('Velg første middag →','onboard','','primary')+
 '<p class="help" style="margin-top:16px;margin-bottom:0">Fortsett som gjest. Planene lagres på denne enheten.</p></div>'+
 '<aside class="welcome-side" aria-hidden="true"><span class="eyebrow">ENKLERE HVERDAG</span><div class="meal-display">🍽️</div><div><h3>Fra middagsidé til ferdig handleliste.</h3><p>Én sammenhengende plan du kan bruke igjen neste uke.</p></div></aside></div>';
}
function renderHome(){
 const today=M.date(new Date()),todays=doc.meals.filter(x=>x.date===today&&(!x.type||x.type==='dinner'));
 const total=thisWeek().length;
 const first=todays[0];
 return '<div class="page-intro"><span class="eyebrow">DIN HVERDAG, LITT ENKLERE</span>'+
 '<h1>God dag! Hva skal vi spise?</h1><p class="intro-copy">Alt du trenger til ukas middager, samlet på ett sted.</p></div>'+
 '<div class="dashboard"><section class="hero-meal"><div class="hero-text"><span class="eyebrow">DAGENS MIDDAG</span>'+
 '<div class="meal-emoji" aria-hidden="true">'+(first?M.icon(first.title):'🍽️')+'</div>'+
 '<h2>'+(todays.length?todays.map(safeTitle).join(' · '):'Hva frister i dag?')+'</h2>'+
 '<p>'+(todays.length?'Allerede lagt inn i ukeplanen din.':'Planlegg en middag, så hjelper SAVLY deg med resten.')+'</p></div>'+
 button(todays.length?'Se ukeplanen →':'Planlegg middag →','goto','data-tab="week"')+'</section>'+
 '<section class="card stat-card"><div><span class="eyebrow">DIN HANDLELISTE</span>'+
 '<div class="stat-number">'+remaining()+'</div><p>varer igjen å handle</p></div>'+
 button('Åpne liste →','goto','data-tab="list"')+'</section></div>'+
 '<div class="section-header"><h2>Gjør hverdagen enklere</h2></div>'+
 '<div class="quick-links"><div class="quick-link"><span class="quick-link__icon" aria-hidden="true">'+uiIcon('week')+'</span><div><strong>Ukeplan</strong>'+
 '<small>'+(total?total+' middager denne uka':'Velg ukas første middag')+'</small></div>'+button('Åpne →','goto','data-tab="week"')+'</div>'+
 '<div class="quick-link"><span class="quick-link__icon" aria-hidden="true">'+uiIcon('pantry')+'</span><div><strong>Har hjemme</strong>'+
 '<small>Bruk maten du allerede har</small></div>'+button('Åpne →','pantry')+'</div></div>'+
 (!total?'<div class="empty"><h3>En god uke begynner med en middag.</h3><p>Legg inn det du har lyst på. Handlelisten bygger seg opp etter hvert.</p>'+
 button('Legg til middag →','open-add','','primary')+'</div>':'<p class="help">Du har '+total+' middag(er) i ukeplanen. Neste uke kan du gjenbruke planen med ett trykk.</p>')+
 '<p class="help">'+(identity?'Endringer lagres på kontoen din når du er på nett.':'Du bruker SAVLY som gjest. Dine data lagres bare på denne enheten.')+'</p>';
}
function renderWeek(){
 const d=days(),meals=thisWeek(),names=['Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag','Søndag'];
 return '<div class="page-intro"><span class="eyebrow">PLANLEGG MED OVERSIKT</span><h1>Ukeplan</h1>'+
 '<p class="intro-copy">Velg middager for de dagene du vil, så setter vi sammen handlelisten.</p></div>'+
 '<div class="date-nav">'+button('← Forrige','prev-week')+'<b>'+esc(d[0])+' – '+esc(d[6])+'</b>'+button('Neste →','next-week')+'</div>'+
 '<div class="actions">'+button('＋ Legg til middag','open-add','','primary')+button('Gjenbruk forrige uke','repeat')+
 button('Oppdater handleliste','generate','','secondary')+'</div>'+
 '<div class="section-header"><div><span class="eyebrow">INSPIRASJON</span><h2>Velg en middag</h2></div></div>'+
 '<label>Legg oppskriften på dag<select id="preset-day">'+d.map((date,i)=>'<option value="'+i+'" '+(selectedDay===i?'selected':'')+'>'+names[i]+'</option>').join('')+'</select></label>'+
 '<p class="help">Enkle SAVLY-forslag med ingredienser. Ingen oppskrifter er kopiert fra eksterne nettsider.</p>'+
 '<div class="catalog">'+presets.map((r,i)=>button('<span class="food-icon" aria-hidden="true">'+M.icon(r.title)+'</span><span>'+esc(r.title)+'</span>','preset','data-index="'+i+'"')).join('')+'</div>'+
 (doc.favorites.length?'<div class="section-header"><h2>Favorittene dine</h2></div><div class="catalog">'+
 doc.favorites.map(x=>button('<span class="food-icon" aria-hidden="true">'+M.icon(x.title)+'</span><span>'+safeTitle(x)+'</span>',
 'use-favorite','data-id="'+esc(x.id)+'"')).join('')+'</div>':'')+
 '<div class="section-header"><div><span class="eyebrow">DENNE UKA</span><h2>Din middagsplan</h2></div><span class="pill">'+meals.length+' middager</span></div>'+
 d.map((date,i)=>'<section class="day"><div class="day-title"><h2>'+names[i]+'</h2>'+button('＋ Legg til','open-add','data-date="'+date+'"')+'</div>'+
 (meals.filter(m=>m.date===date).map(m=>'<div class="card"><div class="row"><div class="meal-title-content">'+
 '<span class="meal-avatar" aria-hidden="true">'+M.icon(m.title)+'</span><div class="name">'+safeTitle(m)+
 '<div class="sub">'+(Number(m.portions)||1)+' porsjoner'+((m.ingredients||[]).length?' · '+m.ingredients.length+' ingredienser':' · Ingen ingredienser registrert')+'</div></div></div>'+
 '<label class="checklabel"><input type="checkbox" data-include="'+esc(m.id)+'" '+(m.include===false?'':'checked')+'>Til handleliste</label></div>'+
 '<div class="item-actions">'+button('Rediger','edit-meal','data-id="'+esc(m.id)+'"')+
 button('Kopier','copy-meal','data-id="'+esc(m.id)+'"')+button('Flytt','move-meal','data-id="'+esc(m.id)+'"')+
 button('☆ Favoritt','favorite','data-id="'+esc(m.id)+'"')+button('Slett','delete-meal','data-id="'+esc(m.id)+'"','danger')+'</div></div>').join('')||
 '<div class="day-empty">Ingen middag lagt inn</div>')+'</section>').join('')+
 '<p class="help">Middagene du huker av, bidrar til handlelisten når du oppdaterer den.</p>';
}
function renderList(){
 const rows=doc.list;
 const generated=rows.filter(x=>x.source==='generated').length;
 const left=remaining(),all=rows.length;
 return '<div class="page-intro"><span class="eyebrow">ALT PÅ ETT STED</span><h1>Handleliste</h1>'+
 '<p class="intro-copy">Fra middagsplan til en oversikt du faktisk kan stole på.</p></div>'+
 '<div class="list-banner"><div><span class="eyebrow" style="color:#c5d8f5">KLAR TIL HANDLING</span>'+
 '<h2>'+left+' '+(left===1?'vare':'varer')+' gjenstår</h2><p>'+generated+' varer hentet fra middagsplanen</p></div>'+
 '<div class="progress-ring" aria-label="'+(all?all-left:0)+' av '+all+' varer håndtert">'+(all?Math.round((all-left)/all*100):0)+'%</div></div>'+
 '<div class="actions">'+button('↻ Oppdater fra ukeplan','generate','','primary')+button('Har hjemme','pantry')+'</div>'+
 '<form id="add-item" class="inline-form"><label>Legg til en vare<input id="new-item" maxlength="200" required placeholder="F.eks. melk, bananer eller brød"></label>'+
 '<button class="primary" type="submit">＋ Legg til</button></form>'+
 (rows.length?'<div class="section-header"><h2>Varene dine</h2><span class="pill">'+all+' totalt</span></div><div class="item-list">'+
 rows.map(x=>'<div class="row"><label class="checklabel" style="flex:1"><input type="checkbox" data-done="'+esc(x.id)+'" '+(x.done?'checked':'')+'>'+
 '<span class="'+(x.done?'checked':'')+'"><strong>'+esc(x.name)+'</strong><span class="sub" style="display:block">'+
 esc(x.quantity==null?(x.details||'Ukjent mengde'):x.quantity+' '+(x.unit||''))+
 (x.originNames?.length?' · Til '+esc(x.originNames.join(', ')):'')+
 (x.orphaned?' · Ikke lenger i ukeplanen':'')+'</span></span></label>'+
 '<div class="item-actions">'+button(x.haveHome?'Hjemme ✓':'Har hjemme','have-home','data-id="'+esc(x.id)+'"')+
 button('Endre','edit-item','data-id="'+esc(x.id)+'"')+button('Slett','delete-item','data-id="'+esc(x.id)+'"','danger')+'</div></div>').join('')+
 '</div>':'<div class="empty"><h3>Handlelisten er tom</h3><p>Legg til en vare selv, eller hent ingredienser fra ukeplanen.</p>'+
 button('Gå til ukeplan →','goto','data-tab="week"','primary')+'</div>');
}
function renderSearch(){
 return '<div class="page-intro"><span class="eyebrow">KJENN PRISEN FØR DU HANDLER</span><h1>Søk etter matvarer</h1>'+
 '<p class="intro-copy">Finn relevante butikkvarer. Vi viser bare registrerte priser fra tilgjengelige kilder.</p></div>'+
 '<form id="product-search"><label>Søk i matvarer<input id="product-query" minlength="3" maxlength="100" required value="'+esc(searchText)+'" placeholder="Hva trenger du? F.eks. melk"></label>'+
 '<button class="primary">Søk etter produkt →</button></form>'+
 '<p class="help">Priser fra Kassalapp der datakilden har treff. Kjedenivå er ikke nødvendigvis din lokale butikk, og datagrunnlaget kan være ufullstendig.</p>'+
 (searchBusy?'<div class="empty" role="status">Henter produkter fra priskilden …</div>':searchError?
 '<div class="empty" role="alert"><h3>Vi fikk ikke hentet priser akkurat nå</h3><p>'+esc(searchError)+'</p>'+button('Prøv igjen','retry-search')+'</div>':
 searchResults.length?'<div class="item-list">'+searchResults.map((p,i)=>'<div class="row"><div class="meal-avatar" aria-hidden="true">'+uiIcon('product')+'</div>'+
 '<div class="name">'+esc(p.name)+'<div class="sub">'+esc(p.weight?(p.weight+' '+(p.unit||'')):'Ukjent pakning')+' · '+esc(p.store||'Ukjent butikk')+'<br>'+
 (Number.isFinite(p.price)?Number(p.price).toFixed(2)+' kr':'Pris mangler')+
 (Number.isFinite(p.unitPrice)?' · '+Number(p.unitPrice).toFixed(2)+' kr/enhet':'')+
 ' · Prisdato: '+esc(p.priceDate||'ukjent')+'</div></div>'+
 button('Legg til','add-product','data-index="'+i+'"')+'</div>').join('')+'</div>':
 '<div class="empty"><h3>Hva ser du etter?</h3><p>Skriv et produktnavn for å søke. Ukeplanen og handlelisten fungerer også når prissøket er utilgjengelig.</p></div>');
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
  scope=next;doc=result.data;serverBase=deep(result.data);revision=result.revision;dirty=false;syncBlocked=false;
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
 if(a==='pantry-preset'){addPreset(presets[Number(btn.dataset.index)]);tab='week';render();return;}
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
 const held=doc.pantry.filter(x=>!x.used).map(x=>M.normalized(x.name));
 const matches=presets.map((p,i)=>({...p,index:i})).filter(p=>p.ingredients.some(x=>held.some(word=>word.includes(M.normalized(x.name))||M.normalized(x.name).includes(word))));
 return '<h1>Har hjemme</h1><p class="help">Frivillig oversikt. En kjøpt vare legges ikke inn automatisk, og middag trekker ikke fra lageret.</p>'+
 '<form id="pantry-form"><label>Navn<input id="pantry-name" required maxlength="200" placeholder="F.eks. ris"></label>'+
 '<div class="kv"><label>Mengde (valgfritt)<input id="pantry-quantity" type="number" min="0" step="any"></label>'+
 '<label>Dato (valgfritt)<input id="pantry-date" type="date"></label></div><button class="primary">Legg til</button></form>'+
 doc.pantry.map(x=>'<div class="row"><span class="name '+(x.used?'checked':'')+'">'+esc(x.name)+'<small style="display:block">'+esc(x.quantity||'')+' '+esc(x.date||'')+'</small></span>'+
 button(x.used?'Brukt opp ✓':'Marker brukt opp','mark-used','data-id="'+esc(x.id)+'"')+'</div>').join('')+
 (matches.length?'<h2>Mulige middager med noe du har</h2><p class="help">Dette er forslag basert på varenavn, ikke en kontroll av tilgjengelige mengder eller allergener.</p><div class="catalog">'+matches.map(x=>button(M.icon(x.title)+' '+esc(x.title),'pantry-preset','data-index="'+x.index+'"')).join('')+'</div>':'')+
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
 if(e.target.id==='preset-day'){selectedDay=Number(e.target.value)||0;return;}
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