/* SAVLY focused meal-to-shopping flow. Additive: legacy data is not migrated or removed. */
(function(){
'use strict';
const $=id=>document.getElementById(id);
const clean=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=> 'core-'+(globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2));
const norm=x=>String(x||'').trim().toLocaleLowerCase('nb').replace(/\s+/g,' ');
const units={g:['g',1],kg:['g',1000],ml:['ml',1],dl:['ml',100],l:['ml',1000],stk:['stk',1],pk:['pk',1]};
const emoji=title=> {let s=norm(title);for(const [re,icon] of [[/taco|tortilla|burrito/,'🌮'],[/pizza/,'🍕'],[/burger/,'🍔'],[/biff|steak|entrec[oô]te/,'🥩'],[/laks|fisk|torsk/,'🐟'],[/kylling/,'🍗'],[/pasta|spagetti|lasagne/,'🍝'],[/suppe/,'🍲'],[/risotto|ris/,'🍚'],[/salat/,'🥗'],[/pannekake/,'🥞'],[/pølse/,'🌭']])if(re.test(s))return icon;return '🍽️';};
const catalog=[
 {title:'Taco',portions:2,ingredients:[{name:'Kjøttdeig',quantity:400,unit:'g'},{name:'Tortillalefser',quantity:6,unit:'stk'},{name:'Tacokrydder',quantity:1,unit:'pk'},{name:'Salat',quantity:1,unit:'stk'}]},
 {title:'Pasta med kjøttdeig',portions:2,ingredients:[{name:'Pasta',quantity:250,unit:'g'},{name:'Kjøttdeig',quantity:400,unit:'g'},{name:'Hakkede tomater',quantity:1,unit:'pk'}]},
 {title:'Kylling og ris',portions:2,ingredients:[{name:'Kyllingfilet',quantity:400,unit:'g'},{name:'Ris',quantity:200,unit:'g'},{name:'Wokgrønnsaker',quantity:400,unit:'g'}]},
 {title:'Laks med poteter',portions:2,ingredients:[{name:'Laks',quantity:300,unit:'g'},{name:'Poteter',quantity:500,unit:'g'}]}
];
function remember(){try{localStorage.setItem('savly_core_settings',JSON.stringify(config));}catch{}}
let config={people:1,allergies:'',started:false};try{config={...config,...JSON.parse(localStorage.getItem('savly_core_settings')||'{}')};}catch{}
let selected=0,tab='home',show=false;
function ready(){return typeof state!=='undefined'&&Array.isArray(state.meals)&&Array.isArray(state.list)&&typeof saveMeals==='function'&&typeof saveList==='function';}
function iso(d){return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
function monday(date=new Date()){let d=new Date(date.getFullYear(),date.getMonth(),date.getDate());d.setDate(d.getDate()-(d.getDay()+6)%7);return d;}
function day(i,offset=0){let d=monday();d.setDate(d.getDate()+i+offset*7);return iso(d);}
function meals(){return state.meals.filter(x=>x.type==='dinner');}
function week(){return meals().filter(x=>x.date>=day(0)&&x.date<=day(6)).sort((a,b)=>a.date.localeCompare(b.date));}
function ingredients(meal){return Array.isArray(meal.ingredients)?meal.ingredients:[];}
function unitLine(ing,ratio){let q=Number(ing.quantity);if(!Number.isFinite(q)||q<=0)return {name:ing.name,quantity:null,unit:ing.unit||'',note:ing.quantity||'Mengde ikke angitt'};return {name:ing.name,quantity:Math.round(q*ratio*1000)/1000,unit:ing.unit||'stk'};}
function wish(){
 let out=new Map();
 for(const m of week())for(const ing of ingredients(m)){
   if(!ing?.name||!String(ing.name).trim())continue;
   const val=unitLine(ing,(Number(m.portions)||config.people)/(Number(m.basePortions)||Number(m.portions)||config.people));
   const conv=units[norm(val.unit)];const compatible=val.quantity!==null&&conv;
   const key=compatible?norm(val.name)+'|'+conv[0]:norm(val.name)+'|'+norm(val.unit)+'|'+m.id+'|'+JSON.stringify(val.note);
   let row=out.get(key);
   if(!row){row={name:val.name,quantity:compatible?0:val.quantity,unit:compatible?conv[0]:val.unit,note:val.note||'',sourceMealIds:[],sourceMealNames:[]};out.set(key,row);}
   if(compatible)row.quantity=Math.round((row.quantity+val.quantity*conv[1])*1000)/1000;
   if(!row.sourceMealIds.includes(m.id)){row.sourceMealIds.push(m.id);row.sourceMealNames.push(m.title);}
 }
 return [...out].map(([key,row])=>({...row,key,source:'meal',id:'generated-'+hash(key)}));
}
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return (h>>>0).toString(36);}
function syncList(){
 const goals=wish(),byKey=new Map(goals.map(x=>[x.key,x])),old=state.list||[],keep=[];
 for(const item of old){
  if(item.source!=='meal'&&item.source!=='core-generated'){keep.push(item);continue;}
  const next=byKey.get(item.sourceKey||item.key);
  if(!next){if(item.done||item.haveHome||item.manualOverride){keep.push({...item,source:'manual',sourceKey:undefined});}continue;}
  keep.push({...item,name:item.manualOverride?item.name:next.name,quantity:item.manualOverride?item.quantity:next.quantity,unit:item.manualOverride?item.unit:next.unit,source:'core-generated',sourceKey:next.key,sourceMealNames:next.sourceMealNames,note:next.note});
  byKey.delete(next.key);
 }
 for(const row of byKey.values())keep.push({id:row.id,name:row.name,quantity:row.quantity,unit:row.unit,source:'core-generated',sourceKey:row.key,sourceMealNames:row.sourceMealNames,done:false,haveHome:false,note:row.note});
 state.list=keep;saveList();
}
function addMeal(title,date,ings=[],portions=config.people,basePortions=portions){
 let m={id:uid(),title:String(title).trim(),date,type:'dinner',ingredients:ings,portions,basePortions,icon:emoji(title)};
 state.meals.push(m);saveMeals();return m;
}
function rowItem(x){return '<div class="core-row"><label><input type="checkbox" data-check="'+clean(x.id)+'" '+(x.done?'checked':'')+'><span style="'+(x.done?'text-decoration:line-through;opacity:.6':'')+'">'+clean(x.name)+'</span></label><small>'+clean(x.quantity==null?(x.note||'Mengde ukjent'):(x.quantity+' '+(x.unit||'')))+(x.sourceMealNames?.length?' · '+clean(x.sourceMealNames.join(', ')):'')+'</small><button data-home="'+clean(x.id)+'">'+(x.haveHome?'Hjemme ✓':'Har hjemme')+'</button></div>';}
function render(){
 if(!ready())return;
 let host=$('savly-core-app');if(!host)return;
 $('savly-core-launch').hidden=show;host.hidden=!show;
 if(!show)return;
 const today=day((new Date().getDay()+6)%7),todayMeal=week().find(x=>x.date===today),left=state.list.filter(x=>!x.done&&!x.haveHome).length;
 const nav=[['home','Hjem'],['week','Ukeplan'],['list','Handleliste'],['search','Søk']].map(([v,n])=>'<button data-tab="'+v+'" class="'+(tab===v?'sel':'')+'">'+n+'</button>').join('');
 let content='';
 if(!config.started){content='<h2>Planlegg første middag</h2><p>Kun to valg nå. Konto er valgfritt. Gjestedata lagres på denne enheten.</p><label>Antall personer<input id="core-people" type="number" min="1" max="30" value="'+config.people+'"></label><label>Allergier eller matvarer å unngå (valgfritt)<input id="core-allergies" value="'+clean(config.allergies)+'" placeholder="Kan hoppes over"></label><p><small>Allergivalg er ikke en garanti for at maten er trygg. Kontroller alltid ingrediensene.</small></p><button id="core-start">Velg første middag</button>';}
 else if(tab==='home')content='<h2>Dagens middag</h2><p>'+(todayMeal?emoji(todayMeal.title)+' '+clean(todayMeal.title):'Ingen middag planlagt i dag')+'</p><p>'+left+' varer gjenstår å handle.</p><button data-tab="week">Planlegg uka</button> <button data-tab="list">Se handleliste</button> <button data-tab="pantry">Har hjemme</button>';
 else if(tab==='week'){
  content='<h2>Dine middager denne uka</h2><label>Velg dag<select id="core-day">'+Array.from({length:7},(_,i)=>'<option value="'+day(i)+'" '+(i===selected?'selected':'')+'>'+['Mandag','Tirsdag','Onsdag','Torsdag','Fredag','Lørdag','Søndag'][i]+'</option>').join('')+'</select></label><label>Egen middag<input id="core-title" placeholder="F.eks. biff med ris"></label><label>Ingredienser (én per linje: 400 g kjøttdeig)<textarea id="core-ingredients" rows="3" placeholder="400 g kjøttdeig&#10;2 stk løk"></textarea></label><button id="core-add">Legg til middag</button><p>Velg en enkel oppskrift:</p><div class="core-catalog">'+catalog.map((m,i)=>'<button data-recipe="'+i+'">'+emoji(m.title)+' '+clean(m.title)+'</button>').join('')+'</div><p><button id="core-repeat">Kopier forrige uke</button> <button id="core-sync">Oppdater handleliste</button></p>'+week().map(m=>'<div class="core-row"><b>'+clean(m.date)+' '+emoji(m.title)+' '+clean(m.title)+'</b><div><label>Porsjoner <input type="number" min="1" max="30" style="width:4rem" data-portions="'+clean(m.id)+'" value="'+(m.portions||config.people)+'"></label><button data-copy="'+clean(m.id)+'">Kopier til valgt dag</button><button data-move="'+clean(m.id)+'">Flytt hit</button><button data-delete="'+clean(m.id)+'">Slett</button></div>'+(ingredients(m).length?'':'<small>Ingen ingredienser oppgitt. Retten bidrar ikke til handlelisten.</small>')+'</div>').join('');
 }else if(tab==='list'){
 content='<h2>Samlet handleliste</h2><p><button id="core-sync">Hent ingredienser fra uka</button></p><label>Legg til vare<input id="core-item" placeholder="F.eks. melk"></label><button id="core-manual">Legg til</button><p>'+left+' gjenstår.</p>'+state.list.map(rowItem).join('');
 }else if(tab==='pantry'){
 content='<h2>Har hjemme</h2><p>Marker varer i handlelisten som allerede finnes hjemme. De blir ikke automatisk fjernet.</p><button data-tab="list">Til handlelisten</button>';
 }else{
 content='<h2>Søk etter matvarer</h2><p>Bruk det eksisterende SAVLY-prissøket. Prisene kommer fra leverandøren og er ikke garantert lokalt.</p><button id="core-legacy-search">Åpne prissøket</button>';
 }
 host.innerHTML='<header><strong>SAVLY</strong><button id="core-close" aria-label="Lukk">Lukk</button></header><main>'+content+'</main><nav aria-label="Hovedfaner">'+nav+'</nav>';
}
function parseIngredients(input){
 return input.split(/\n/).map(x=>x.trim()).filter(Boolean).map(x=>{
 const m=x.match(/^(\d+(?:[.,]\d+)?)\s*(kg|g|ml|dl|l|stk|pk)\s+(.+)$/i);
 return m?{name:m[3],quantity:Number(m[1].replace(',','.')),unit:m[2].toLowerCase()}:{name:x,quantity:null,unit:'',note:'Mengde ikke oppgitt'};
 });
}
function run(){if(!ready()){alert('SAVLY er ikke lastet inn ennå.');return;}show=true;render();}
document.addEventListener('click',ev=>{
 const b=ev.target.closest('button');if(!b)return;
 if(b.id==='savly-core-launch')return run();
 if(b.id==='core-close'){show=false;render();return;}
 if(!show)return;
 if(b.dataset.tab){tab=b.dataset.tab;render();return;}
 if(b.id==='core-start'){let n=Number($('core-people').value);if(!Number.isInteger(n)||n<1||n>30){alert('Velg 1–30 personer');return;}config.people=n;config.allergies=$('core-allergies').value.trim();config.started=true;remember();tab='week';render();return;}
 if(b.id==='core-add'){let title=$('core-title').value.trim();if(!title)return alert('Skriv inn middag.');addMeal(title,$('core-day').value,parseIngredients($('core-ingredients').value));render();return;}
 if(b.dataset.recipe!==undefined){let m=catalog[Number(b.dataset.recipe)];addMeal(m.title,$('core-day').value,m.ingredients,config.people,m.portions);render();return;}
 if(b.id==='core-sync'){syncList();tab='list';render();return;}
 if(b.id==='core-manual'){let v=$('core-item').value.trim();if(!v)return;state.list.push({id:uid(),name:v,done:false});saveList();render();return;}
 if(b.id==='core-repeat'){const existing=new Set(week().map(x=>x.date+'|'+norm(x.title)));for(const m of meals().filter(x=>x.date>=day(0,-1)&&x.date<=day(6,-1))){let d=new Date(m.date+'T12:00:00');d.setDate(d.getDate()+7);let dt=iso(d);if(existing.has(dt+'|'+norm(m.title)))continue;state.meals.push({...m,id:uid(),date:dt});}saveMeals();render();return;}
 if(b.dataset.copy||b.dataset.move||b.dataset.delete){let id=b.dataset.copy||b.dataset.move||b.dataset.delete;let m=state.meals.find(x=>x.id===id);if(!m)return;if(b.dataset.delete){if(!confirm('Slette denne middagen?'))return;state.meals=state.meals.filter(x=>x.id!==id);}else if(b.dataset.copy){state.meals.push({...m,id:uid(),date:day(selected)});}else m.date=day(selected);saveMeals();render();return;}
 if(b.dataset.home){let x=state.list.find(x=>x.id===b.dataset.home);if(x){x.haveHome=!x.haveHome;saveList();render();}return;}
 if(b.id==='core-legacy-search'){show=false;render();if(typeof go==='function')go('search');return;}
});
document.addEventListener('change',e=>{
 if(!show)return;
 if(e.target.id==='core-day'){selected=Math.max(0,Array.from({length:7},(_,i)=>day(i)).indexOf(e.target.value));return;}
 if(e.target.dataset.check){let x=state.list.find(x=>x.id===e.target.dataset.check);if(x){x.done=e.target.checked;saveList();render();}return;}
 if(e.target.dataset.portions){let x=state.meals.find(x=>x.id===e.target.dataset.portions),n=Number(e.target.value);if(x&&Number.isInteger(n)&&n>0&&n<=30){x.portions=n;saveMeals();render();}return;}
});
const style=document.createElement('style');style.textContent=`
#savly-core-launch{position:fixed;right:14px;bottom:90px;z-index:998;background:#132a55;color:white;border:0;border-radius:24px;padding:13px 18px;box-shadow:0 5px 24px #0003;font-weight:700}
#savly-core-app{position:fixed;inset:0;z-index:9999;background:#f7f9fc;color:#132a55;overflow:auto;font:16px system-ui}
#savly-core-app[hidden],#savly-core-launch[hidden]{display:none!important}
#savly-core-app header{display:flex;justify-content:space-between;align-items:center;background:#132a55;color:white;padding:18px}
#savly-core-app main{max-width:640px;margin:0 auto;padding:20px 20px 100px}
#savly-core-app h2{font-size:24px}
#savly-core-app input,#savly-core-app textarea,#savly-core-app select{display:block;width:100%;box-sizing:border-box;border:1px solid #aab6cd;border-radius:10px;padding:10px;margin:5px 0 12px;font:inherit}
#savly-core-app button{border:1px solid #ced5e3;border-radius:12px;background:white;color:#132a55;padding:10px;min-height:44px;cursor:pointer}
#savly-core-app main>button,#savly-core-app #core-sync,#savly-core-app #core-add{background:#132a55;color:white}
#savly-core-app .core-row{border-bottom:1px solid #dae0e8;padding:12px 0;display:grid;gap:7px}
#savly-core-app .core-row label{display:flex;align-items:center;gap:10px}
#savly-core-app .core-row input[type=checkbox]{width:22px;height:22px;margin:0}
#savly-core-app .core-row small{color:#596579}
#savly-core-app .core-catalog{display:grid;grid-template-columns:1fr 1fr;gap:8px}
#savly-core-app nav{position:fixed;bottom:0;left:0;right:0;display:flex;justify-content:space-around;background:white;border-top:1px solid #dfe4ee;padding:6px}
#savly-core-app nav button{font-size:12px;flex:1;border:0}
#savly-core-app nav .sel{background:#132a55;color:white}
`;document.head.appendChild(style);
const launcher=document.createElement('button');launcher.id='savly-core-launch';launcher.textContent='Planlegg enkelt';launcher.hidden=false;document.body.appendChild(launcher);
const app=document.createElement('section');app.id='savly-core-app';app.hidden=true;document.body.appendChild(app);
})();
