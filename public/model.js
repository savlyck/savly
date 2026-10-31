/* Pure SAVLY data model. No DOM, network, login or storage dependencies. */
(function (root, factory) {
  const model=factory();
  if(typeof module==='object' && module.exports) module.exports=model;
  else root.SavlyModel=model;
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const types={g:['mass',1,'g'],kg:['mass',1000,'g'],ml:['volume',1,'ml'],cl:['volume',10,'ml'],dl:['volume',100,'ml'],l:['volume',1000,'ml'],stk:['pieces',1,'stk'],pk:['packages',1,'pk']};
  const normalized=x=>String(x||'').trim().toLocaleLowerCase('nb-NO').replace(/\s+/g,' ');
  const date=d=>{const n=new Date(d);return [n.getFullYear(),String(n.getMonth()+1).padStart(2,'0'),String(n.getDate()).padStart(2,'0')].join('-');};
  const weekStart=d=>{const result=new Date(d.getFullYear(),d.getMonth(),d.getDate());result.setDate(result.getDate()-(result.getDay()+6)%7);return result;};
  const day=(monday,index)=>{const d=new Date(monday.getFullYear(),monday.getMonth(),monday.getDate());d.setDate(d.getDate()+index);return date(d);};
  const id=()=> 'sv-'+(globalThis.crypto?.randomUUID?.() || (Date.now().toString(36)+Math.random().toString(36).slice(2)));
  const empty=()=>({meals:[],list:[],pantry:[],favorites:[],prefs:{people:1,allergies:[],onboarded:false}});
  const icon=title=>{
    const s=normalized(title);
    for(const [pattern,e] of [[/taco|burrito|tortilla/,'🌮'],[/biff|entrecote|entrecôte|steak/,'🥩'],[/pizza/,'🍕'],[/burger/,'🍔'],[/laks|torsk|fisk/,'🐟'],[/kylling/,'🍗'],[/pasta|spaghetti|spagetti|lasagne/,'🍝'],[/suppe/,'🍲'],[/salat/,'🥗'],[/risotto/,'🍚'],[/pannekak/,'🥞'],[/pølse/,'🌭']]) if(pattern.test(s))return e;
    return '🍽️';
  };
  const round=x=>Math.round(x*1000)/1000;
  const mealKey=m=>m.date+'|'+normalized(m.title);
  function suggested(meals,from,to){
    const groups=new Map();
    for(const m of meals){
      if(m.type && m.type!=='dinner')continue;
      if(m.date<from || m.date>to)continue;
      const ratio=(Number(m.portions)||1)/(Number(m.basePortions)||Number(m.portions)||1);
      for(let i=0;i<(m.ingredients||[]).length;i++){
        const ing=m.ingredients[i];
        const name=String(ing.name||'').trim();
        if(!name)continue;
        const raw=ing.quantity;
        const hasQuantity=raw!==null&&raw!==undefined&&String(raw).trim()!==''&&Number.isFinite(Number(raw))&&Number(raw)>0;
        const unit=normalized(ing.unit||'');
        const converted=types[unit];
        const normal=normalized(name);
        // Unknown or unmeasured items stay separate; never invent a quantity.
        const groupable=hasQuantity && Boolean(converted);
        const key=groupable?'quantity|'+normal+'|'+converted[0]:'unmeasured|'+m.id+'|'+i+'|'+normal;
        let row=groups.get(key);
        if(!row){
          row={id:'gen-'+stableHash(key),genKey:key,name,quantity:groupable?0:null,
               unit:groupable?converted[2]:unit,details:(!groupable?String(ing.note||raw||'Mengde ikke oppgitt'):''),originIds:[],originNames:[],source:'generated',done:false,haveHome:false};
          groups.set(key,row);
        }
        if(groupable)row.quantity=round(row.quantity+Number(raw)*ratio*converted[1]);
        if(!row.originIds.includes(m.id)){row.originIds.push(m.id);row.originNames.push(m.title);}
      }
    }
    return [...groups.values()];
  }
  function stableHash(s){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return (h>>>0).toString(36);}
  function reconcile(oldList, proposals){
    const expected=new Map(proposals.map(x=>[x.genKey,x]));
    const result=[],seen=new Set();
    for(const old of oldList){
      if(old.source!=='generated'){result.push(old);continue;}
      const next=expected.get(old.genKey);
      if(!next){
        // A generated row with a user action is kept as a clearly unlinked manual row.
        if(old.manualOverride||old.done||old.haveHome) result.push({...old,source:'manual',orphaned:true});
        continue;
      }
      if(seen.has(old.genKey))continue;
      result.push({...next,...old,quantity:old.manualOverride?old.quantity:next.quantity,
        unit:old.manualOverride?old.unit:next.unit,name:old.manualOverride?old.name:next.name,
        originIds:next.originIds,originNames:next.originNames,genKey:next.genKey,source:'generated'});
      seen.add(old.genKey);
      expected.delete(old.genKey);
    }
    result.push(...expected.values());
    return result;
  }
  function mergeGuest(remote,guest){
    const output=JSON.parse(JSON.stringify(remote));
    for(const kind of ['meals','list','pantry','favorites']){
      const ids=new Set(output[kind].map(x=>x.id));
      // Match stable ID only. Never collapse two intended meals based on their title.
      for(const item of guest[kind]||[]) if(!ids.has(item.id)){output[kind].push(JSON.parse(JSON.stringify(item)));ids.add(item.id);}
    }
    if(!output.prefs.onboarded && guest.prefs?.onboarded)output.prefs=JSON.parse(JSON.stringify(guest.prefs));
    return output;
  }
  return {types,normalized,date,weekStart,day,id,empty,icon,mealKey,suggested,reconcile,mergeGuest};
});
