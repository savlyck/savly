const test=require('node:test');
const assert=require('node:assert/strict');
const M=require('../public/model.js');
function meal(id,title,date,ingredients,portions=2,basePortions=2){
 return {id,title,date,type:'dinner',ingredients,portions,basePortions};
}
test('Taco, biff and unknown meals show distinct icons',()=>{
 assert.equal(M.icon('Fredagstaco'),'🌮');
 assert.equal(M.icon('Biff med saus'),'🥩');
 assert.equal(M.icon('Hjemmelaget overraskelse'),'🍽️');
});
test('Compatible metric ingredients add up exactly',()=>{
 const list=M.suggested([
  meal('a','Taco','2026-10-31',[{name:'Kjøttdeig',quantity:400,unit:'g'}]),
  meal('b','Pasta','2026-10-31',[{name:'kjøttdeig',quantity:0.5,unit:'kg'}])
 ],'2026-10-26','2026-11-01');
 assert.equal(list.length,1);
 assert.equal(list[0].quantity,900);
 assert.equal(list[0].unit,'g');
 assert.deepEqual(list[0].originNames,['Taco','Pasta']);
});
test('Portion scaling uses original recipe portions',()=>{
 const rows=M.suggested([meal('x','Taco','2026-10-31',[{name:'Ris',quantity:200,unit:'g'}],4,2)],
 '2026-10-26','2026-11-01');
 assert.equal(rows[0].quantity,400);
});
test('Incompatible units and uncertain amounts are never guessed',()=>{
 const rows=M.suggested([meal('a','Middag','2026-10-31',[
  {name:'Melk',quantity:1,unit:'l'},
  {name:'Melk',quantity:3,unit:'stk'},
  {name:'Melk',quantity:null,unit:'',note:'en skvett'}
 ])],'2026-10-26','2026-11-01');
 assert.equal(rows.length,3);
 assert.equal(rows.find(x=>x.unit==='ml').quantity,1000);
 assert.equal(rows.find(x=>x.unit==='stk').quantity,3);
 assert.equal(rows.find(x=>x.quantity===null).details,'en skvett');
});
test('Grocery generation is repeatable and preserves manually entered goods',()=>{
 const proposals=M.suggested([meal('a','Taco','2026-10-31',[{name:'Ris',quantity:200,unit:'g'}])],
 '2026-10-26','2026-11-01');
 const first=M.reconcile([{id:'custom',name:'Såpe',source:'manual',done:false}],proposals);
 const second=M.reconcile(first,proposals);
 assert.deepEqual(second,first);
 assert.equal(second.length,2);
});
test('Recipe edits update generated quantities without losing checkboxes or manual overrides',()=>{
 const old=M.reconcile([],M.suggested([meal('a','Taco','2026-10-31',[{name:'Ris',quantity:200,unit:'g'}])],
 '2026-10-26','2026-11-01'));
 old[0].done=true;
 const newer=M.reconcile(old,M.suggested([meal('a','Taco','2026-10-31',[{name:'Ris',quantity:300,unit:'g'}])],
 '2026-10-26','2026-11-01'));
 assert.equal(newer[0].quantity,300);
 assert.equal(newer[0].done,true);
 newer[0].manualOverride=true;
 newer[0].quantity=1000;
 const preserve=M.reconcile(newer,M.suggested([meal('a','Taco','2026-10-31',[{name:'Ris',quantity:600,unit:'g'}])],
 '2026-10-26','2026-11-01'));
 assert.equal(preserve[0].quantity,1000);
});
test('Deleted planned ingredient with a user checkbox survives as unlinked',()=>{
 let old=M.reconcile([],M.suggested([meal('a','Taco','2026-10-31',[{name:'Ris',quantity:200,unit:'g'}])],
 '2026-10-26','2026-11-01'));
 old[0].haveHome=true;
 const result=M.reconcile(old,[]);
 assert.equal(result.length,1);
 assert.equal(result[0].source,'manual');
 assert.equal(result[0].orphaned,true);
});
test('Guest migration only adds missing stable IDs',()=>{
 const remote=M.empty(),guest=M.empty();
 guest.meals=[meal('same','Taco','2026-10-31',[])];
 const first=M.mergeGuest(remote,guest);
 const second=M.mergeGuest(first,guest);
 assert.equal(second.meals.length,1);
});
test('Monday-based weeks are deterministic',()=>{
 const monday=M.weekStart(new Date(2026,9,31));
 assert.equal(M.day(monday,0),'2026-10-26');
 assert.equal(M.day(monday,6),'2026-11-01');
});

test('Rebasing local pending edits keeps remote rows and local checkbox edits',()=>{
 const base=M.empty();base.list=[{id:'x',name:'Ris',done:false}];
 const local=JSON.parse(JSON.stringify(base));local.list[0].done=true;
 const remote=JSON.parse(JSON.stringify(base));remote.list.push({id:'remote',name:'Melk',done:false});
 const result=M.rebase(base,local,remote);
 assert.equal(result.list.length,2);
 assert.equal(result.list.find(x=>x.id==='x').done,true);
 assert.equal(result.list.find(x=>x.id==='remote').name,'Melk');
});
