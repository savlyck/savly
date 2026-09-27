/* Kassalapp integration. The browser only talks to the local SAVLY gateway. */
var apiResults=[], apiTarget=null, apiSearchSerial=0, apiCompareSerial=0;
var apiOffers={}, apiBusy=false, apiError='', apiFetchedAt=null;
var API_CODES={rem:'REMA_1000',kiwi:'KIWI',obs:'COOP_OBS',extra:'COOP_EXTRA',meny:'MENY_NO',spar:'SPAR_NO',bunnpris:'BUNNPRIS',joker:'JOKER_NO',mega:'COOP_MEGA',prix:'COOP_PRIX',marked:'COOP_MARKED',matkroken:'MATKROKEN',narbutikken:'NAERBUTIKKEN',holdbart:'HOLDBART'};
var API_UNITS={g:'g',kg:'kg',ml:'ml',l:'l',liter:'l',piece:'stk',pieces:'stk'};
function apiEscape(v){return esc(String(v??''));}
function apiDate(v){const d=new Date(v);return v&&Number.isFinite(d.getTime())?d.toLocaleDateString('nb-NO'):'Ukjent dato';}
function apiFresh(p){const t=Date.parse(p.priceDate);return Number.isFinite(p.price)&&Number.isFinite(t)&&Date.now()-t<=7*86400000&&t<=Date.now()+86400000;}
async function apiGet(path){
 if(location.protocol==='file:')throw new Error('Start server.py og åpne http://localhost:8787 for å hente priser.');
 const r=await fetch(path,{signal:AbortSignal.timeout(20000)});let d;
 try{d=await r.json();}catch{throw new Error('Prisserveren svarte ikke som forventet. Start appen via server.py.');}
 if(!r.ok)throw new Error(d.error||'Kunne ikke hente priser.');return d;
}
function apiPack(p){return p.weight?String(p.weight)+' '+(API_UNITS[p.unit]||p.unit||''):'';}
function renderUsage(){document.getElementById('usageTxt').textContent='Priser fra Kassalapp · dekning varierer mellom butikker';}
function runSearch(){doSearch();}
function setCat(k){state.searchCat=state.searchCat===k?null:k;document.getElementById('searchInput').value=state.searchCat?(CATS[k]||k).split(' & ')[0]:'';renderCats();doSearch();}
async function doSearch(allStores=false){
 const serial=++apiSearchSerial, box=document.getElementById('searchResults'),q=document.getElementById('searchInput').value.trim();
 apiResults=[];
 if(q.length<3){box.innerHTML='<div class="studio-empty">Skriv minst tre tegn for å søke etter et produkt.</div>';return;}
 const selected=Object.keys(STORE_NAMES).filter(k=>allStores===true||state.storeFilter[k]);
 if(!selected.length){box.innerHTML='<div class="studio-empty">Velg minst én butikk.</div>';return;}
 const supported=selected.filter(k=>API_CODES[k]);
 if(!supported.length){box.innerHTML='<div class="studio-empty">Ingen bekreftet API-kobling for valgte butikker ennå. <button class="btn" onclick="doSearch(true)">Søk i alle tilknyttede butikker</button></div>';return;}
 box.innerHTML='<p role="status">Henter produkter fra Kassalapp …</p>';
 try{
 const only=supported.length===1?API_CODES[supported[0]]:null;
 const d=await apiGet('/api/products?q='+encodeURIComponent(q)+(only?'&store='+only:''));if(serial!==apiSearchSerial)return;
 let found=d.products.filter(p=>selected.includes(p.store)),limited=d.limited,checked=0,fallbackError='';
 // The first global page can contain only stores outside the chosen filters.
 // Search those chains directly before reporting an empty result. Bound API use.
 if(!found.length&&!only&&allStores!==true&&(d.limited||d.products.length)){
  for(const id of supported.slice(0,3)){
   if(serial!==apiSearchSerial)return;
   box.innerHTML='<p role="status">Sjekker '+apiEscape(STORE_NAMES[id])+' for «'+apiEscape(q)+'» …</p>';
   try{
    const extra=await apiGet('/api/products?q='+encodeURIComponent(q)+'&store='+API_CODES[id]);if(serial!==apiSearchSerial)return;
    checked++;limited=limited||extra.limited;found.push(...extra.products.filter(p=>selected.includes(p.store)));
   }catch(e){if(serial!==apiSearchSerial)return;fallbackError=e.message;break;}
   if(found.length)break;
  }
 }
 if(serial!==apiSearchSerial)return;
 apiResults=found.sort((a,b)=>(b.relevance??0)-(a.relevance??0)||(a.price??Infinity)-(b.price??Infinity));
 const scope=allStores===true?'Alle tilknyttede butikker':selected.map(id=>STORE_NAMES[id]).join(', ');
 const notice='<p class="studio-data-note">Søk: «'+apiEscape(q)+'» · '+apiEscape(scope)+'. '+(allStores===true?'Favorittbutikkene dine er ikke endret. ':'')+(checked?'Sjekket også '+checked+' kjeder direkte. ':'')+(limited?'Datakilden viser et begrenset utvalg. ':'')+(q.toLowerCase()==='ost'?'Viser gjenkjente osteprodukter. Osteprodukter med ukjente navn kan mangle.':q.toLowerCase()==='melk'?'Viser gjenkjente melkeprodukter. Produkter med ukjente navn kan mangle.':q.toLowerCase()==='smør'?'Viser gjenkjente smørprodukter. Produkter med ukjente navn kan mangle.':'')+'</p>';
 const broaden=allStores!==true?'<button class="btn" onclick="doSearch(true)">Søk i alle tilknyttede butikker</button>':'';
 const empty=fallbackError?'Butikksøket kunne ikke fullføres: '+apiEscape(fallbackError):d.products.length?'Det finnes treff på «'+apiEscape(q)+'», men ingen hos '+apiEscape(scope)+' i utvalget som ble hentet.':'Ingen relevante treff på «'+apiEscape(q)+'» i utvalget som ble hentet. Prøv et annet produktnavn.';
 box.innerHTML=(apiTarget?'<p class="studio-data-note">Velg produkt til «'+apiEscape(apiTarget.name)+'». <button onclick="apiCancelTarget()">Avbryt valg</button></p>':'')+notice+
 (apiResults.length?'<p class="studio-data-note">Ulike produkter og pakninger. Registrerte priser er ikke garantert i din lokale butikk.</p>'+apiResults.map((p,i)=>apiCard(p,i)).join(''):'<div class="studio-empty" role="status">'+empty+'<br>'+broaden+'</div>');
 }catch(e){if(serial===apiSearchSerial)box.innerHTML='<div class="studio-empty" role="alert">'+apiEscape(e.name==='TimeoutError'?'Prissøket tok for lang tid. Prøv igjen.':e.message)+'<br><button class="btn" onclick="doSearch()">Prøv igjen</button></div>';}
}

function apiCard(p,i){
 const price=Number.isFinite(p.price)?fmt(p.price):'Pris mangler';
 return '<article class="api-card"><div class="api-product">'+(p.image?'<img loading="lazy" referrerpolicy="no-referrer" src="'+apiEscape(p.image)+'" alt="" onerror="this.hidden=true">':'')+'<div><b>'+apiEscape(p.name)+'</b><small>'+apiEscape(STORE_NAMES[p.store])+' · '+apiEscape(apiPack(p))+'</small><strong>'+price+'</strong><small>Pris registrert: '+apiDate(p.priceDate)+'</small>'+(!apiFresh(p)?'<small>Dato mangler eller prisen er eldre enn 7 dager. Ikke brukt i butikksummen.</small>':'')+'</div></div><div class="api-actions"><button class="btn" onclick="apiPick('+i+')">'+(apiTarget?'Velg dette produktet':'Legg i handlelista')+'</button>'+(p.ean?'<button class="btn" onclick="apiShowComparison('+i+')">Sammenlign samme vare</button>':'')+'</div><div id="api-comparison-'+i+'"></div></article>';
}
function apiCancelTarget(){apiTarget=null;doSearch();}
async function apiShowComparison(index){
 const p=apiResults[index],host=document.getElementById('api-comparison-'+index);if(!p||!host)return;
 host.textContent='Henter priser …';
 try{const d=await apiGet('/api/compare?ean='+encodeURIComponent(p.ean));const offers=d.products.filter(x=>state.storeFilter[x.store]).sort((a,b)=>(a.price??Infinity)-(b.price??Infinity));
 host.innerHTML='<p>Samme strekkode · '+apiEscape(p.ean)+'</p>'+(offers.length?offers.map(x=>'<p><b>'+apiEscape(STORE_NAMES[x.store])+'</b> '+(Number.isFinite(x.price)?fmt(x.price):'Pris mangler')+' · '+apiDate(x.priceDate)+'</p>').join(''):'Ingen priser hos valgte butikker.');
 }catch(e){host.textContent=e.message;}
}
function apiPick(index){
 const p=apiResults[index];if(!p)return;
 let item=apiTarget&&state.list.includes(apiTarget)&&!apiTarget.done?apiTarget:null;
 if(apiTarget&&!item){toast('Varen er endret eller fjernet. Velg den på nytt.');apiTarget=null;return;}
 const duplicate=state.list.find(x=>!x.done&&x!==item&&(p.ean?x.apiProduct?.ean===p.ean:x.apiProduct?.id===p.id));
 if(duplicate){toast('Produktet er allerede knyttet til en vare på handlelista.');return;}
 if(!item)item=state.list.find(x=>!x.done&&norm(x.name)===norm(p.name));
 if(!item){item={name:p.name,done:false};state.list.push(item);}
 item.apiProduct={id:p.id,ean:p.ean,name:p.name};apiTarget=null;apiOffers={};apiFetchedAt=null;apiCompareSerial++;apiBusy=false;
 saveList();renderList();go('list');toast('Produktet er valgt. Trykk «Hent butikkpriser» for å sammenligne.');
}
function apiLinkItem(index){apiTarget=state.list[index];if(!apiTarget)return;go('search');state.searchCat=null;renderCats();document.getElementById('searchInput').value=apiTarget.name;doSearch();}
function apiLivePlan(){
 const ids=(state.prefs.favoriteStores||[]).filter(id=>STORE_NAMES[id]),rows=state.list.filter(x=>!x.done);
 const common=rows.filter(x=>x.apiProduct?.ean&&ids.length&&ids.every(id=>(apiOffers[x.apiProduct.ean]||[]).some(p=>p.store===id&&apiFresh(p))));
 const offer=(x,id)=>(apiOffers[x.apiProduct.ean]||[]).filter(p=>p.store===id&&apiFresh(p)).sort((a,b)=>a.price-b.price)[0];
 const learned=learningData(),priority=state.prefs.shoppingPriority||'balanced';
 const ranked=ids.map(id=>({id,visits:Number(learned.stores[id])||0,total:common.length?common.reduce((s,x)=>s+offer(x,id).price,0):null})).sort((a,b)=>(a.total??Infinity)-(b.total??Infinity)||b.visits-a.visits);
 const min=ranked[0]?.total,tolerance=priority==='time'?.10:.05;
 if(priority!=='price')ranked.sort((a,b)=>{if(min===null)return b.visits-a.visits;const an=a.total<=min*(1+tolerance),bn=b.total<=min*(1+tolerance);return an!==bn?(an?-1:1):an?b.visits-a.visits||a.total-b.total:a.total-b.total;});
 const split={};let splitTotal=0;for(const x of common){const p=ids.map(id=>offer(x,id)).sort((a,b)=>a.price-b.price)[0];(split[p.store]??=[]).push(x.name);splitTotal+=p.price;}
 return {ids,rows,common,ranked,priority,split,splitTotal};
}
async function apiRefreshList(){
 if(apiBusy)return;const serial=++apiCompareSerial;
 apiBusy=true;apiError='';apiOffers={};apiFetchedAt=null;renderTripCompare();
 const eans=[...new Set(state.list.filter(x=>!x.done).map(x=>x.apiProduct?.ean).filter(Boolean))];
 for(const ean of eans){
  try{const d=await apiGet('/api/compare?ean='+encodeURIComponent(ean));if(serial!==apiCompareSerial)return;apiOffers[ean]=d.products;}
  catch(e){if(serial!==apiCompareSerial)return;apiError=e.message;break;}
 }
 if(serial!==apiCompareSerial)return;apiBusy=false;apiFetchedAt=new Date();renderTripCompare();
}
function renderTripCompare(){
 const host=document.getElementById('tripCompare');if(!host)return;const p=apiLivePlan();
 let h='<div class="f-card"><span class="studio-eyebrow">DIN HANDLEPLAN · KASSALAPP</span><h3>Butikkpriser for varene dine</h3><p class="studio-data-note">Sammenligner samme strekkode. '+p.common.length+' av '+p.rows.length+' varer har priser med dato fra siste 7 dager hos alle valgte butikker. Én pakke per vare; oppskriftsmengder og reise er ikke beregnet.</p>';
 h+='<div class="api-plan-actions"><button class="btn" onclick="openSetup()">Tilpass butikker og matvalg</button> <button class="btn" onclick="apiRefreshList()" '+(apiBusy?'disabled':'')+'>'+(apiBusy?'Henter priser …':'Hent butikkpriser')+'</button></div>';
 if(apiError)h+='<p role="alert">'+apiEscape(apiError)+'</p>';
 if(apiFetchedAt)h+='<p>Sist hentet: '+apiFetchedAt.toLocaleTimeString('nb-NO')+' · priser mellomlagres i inntil 5 minutter.</p>';
 if(!p.ids.length)h+='<p>Velg butikker i oppsettet.</p>';
 h+=p.rows.map(x=>'<div class="api-list-link"><b>'+apiEscape(x.name)+'</b><small>'+(x.apiProduct?apiEscape(x.apiProduct.name)+(x.apiProduct.ean?'':' · mangler strekkode'):'Velg et konkret produkt for prissammenligning')+'</small><button class="btn-ghost-sm" onclick="apiLinkItem('+state.list.indexOf(x)+')">'+(x.apiProduct?'Bytt produkt':'Finn produkt')+'</button></div>').join('');
 h+=p.ranked.map(x=>'<div class="smart-plan-store"><div><b>'+apiEscape(STORE_NAMES[x.id])+'</b><small>'+(x.visits?'Valgt '+x.visits+' ganger':'Valgt i oppsettet')+'</small></div><div><strong>'+(x.total===null?'Mangler sammenlignbare priser':fmt(x.total)+' · delsum')+'</strong><button onclick="chooseShoppingStore(\''+x.id+'\')">Handle her</button></div></div>').join('');
 if(p.common.length)h+='<p>Inkludert i delsummen: '+p.common.map(x=>apiEscape(x.name)).join(', ')+'.</p>';
 const missing=p.rows.filter(x=>!p.common.includes(x));if(missing.length)h+='<p>Utenfor summen: '+missing.map(x=>apiEscape(x.name)).join(', ')+'. Manglende data betyr ikke at butikken mangler varen.</p>';
 if(p.common.length&&p.priority!=='time'&&Object.keys(p.split).length>1)h+='<details><summary>Fordel varene mellom butikker · '+fmt(p.splitTotal)+'</summary>'+Object.entries(p.split).map(([id,names])=>'<p>'+apiEscape(STORE_NAMES[id])+': '+names.map(apiEscape).join(', ')+'</p>').join('')+'</details>';
 if((state.prefs.diet||[]).length||(state.prefs.allergies||[]).length)h+='<p>Matvalgene dine er lagret. Denne prissammenligningen kontrollerer ikke allergener; sjekk produktet før kjøp.</p>';
 h+='<button class="btn-ghost-sm" onclick="resetShoppingLearning()">Nullstill lærte butikkvalg</button></div>';host.innerHTML=h;
}
renderUsage();renderList();doSearch();
