const {test,expect}=require('@playwright/test');
const {execFileSync}=require('node:child_process');
const url='http://127.0.0.1:8787/app';
test('New guest -> first dinner -> shared ingredients -> editable shopping list survives reload',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto(url);
 await expect(page.getByRole('heading',{name:'Planlegg middagen, handle det du trenger.'})).toBeVisible();
 await page.locator('#start-people').fill('2');
 await page.getByRole('button',{name:'Velg første middag'}).click();
 await expect(page.getByRole('heading',{name:'Ukeplan'})).toBeVisible();
 await page.getByRole('button',{name:/Taco/}).first().click();
 await page.locator('#tabs [data-tab=list]').click();
 await expect(page.locator('#main .row')).toHaveCount(4);
 await page.getByRole('button',{name:'Oppdater fra ukeplan'}).click();
 await expect(page.locator('#main .row')).toHaveCount(4);
 await page.locator('#main [data-action=have-home]').first().click();
 await expect(page.getByText('Hjemme ✓')).toBeVisible();
 await page.reload();
 await page.locator('#tabs [data-tab=list]').click();
 await expect(page.locator('#main .row')).toHaveCount(4);
 await expect(page.locator('#main [data-action=have-home]').first()).toHaveText('Hjemme ✓');
 await page.locator('#new-item').fill('Såpe');
 await page.locator('#add-item button').click();
 await expect(page.locator('#main .row')).toHaveCount(5);
 await page.getByRole('button',{name:'Oppdater fra ukeplan'}).click();
 await expect(page.locator('#main .row')).toHaveCount(5);
});
test('Two meals consolidate compatible quantities and scale portions',async({page})=>{
 await page.goto(url);
 await page.locator('#start-people').fill('2');
 await page.getByRole('button',{name:'Velg første middag'}).click();
 await page.getByRole('button',{name:/Taco/}).first().click();
 await page.getByRole('button',{name:/Pasta med kjøttdeig/}).first().click();
 await page.locator('#tabs [data-tab=list]').click();
 await expect(page.locator('#main .row')).toHaveCount(6);
 await expect(page.getByText('800 g',{exact:false})).toBeVisible();
});
test('Price API failure does not remove the meal plan',async({page})=>{
 await page.goto(url);
 await page.locator('#start-people').fill('1');
 await page.getByRole('button',{name:'Velg første middag'}).click();
 await page.getByRole('button',{name:/Taco/}).first().click();
 await page.locator('#tabs [data-tab=search]').click();
 await page.locator('#product-query').fill('melk');
 await page.locator('#product-search button').click();
 await expect(page.getByText(/API-nøkkel mangler|Prissøket|Kunne ikke hente/)).toBeVisible();
 await page.locator('#tabs [data-tab=list]').click();
 await expect(page.locator('#main .row')).toHaveCount(4);
});

function simulatedGoogleSession(){
 // Test-only session fixture: exercises real authenticated API/SQLite, not Google OAuth itself.
 const py="import households\n"+ 
 "t,s=households.session('')\n"+
 "user={'id':'g_ci_browser','name':'CI Test','provider':'google'}\n"+
 "with households.connection() as db: db.execute('INSERT OR IGNORE INTO users(id,name,provider) VALUES(?,?,?)',(user['id'],user['name'],user['provider']))\n"+
 "t,s=households.rotate(t,user)\nprint(t)\n";
 return execFileSync('python',['-c',py],{encoding:'utf8',env:{...process.env,SAVLY_DB:'/tmp/savly-ci.sqlite3'}}).trim();
}
test('Account-backed content survives reload and concurrent devices merge their shopping items',async({browser})=>{
 const one=await browser.newContext(),two=await browser.newContext();
 try{
  await one.addCookies([{name:'savly_session',value:simulatedGoogleSession(),url:'http://127.0.0.1:8787'}]);
  const first=await one.newPage();await first.goto(url);
  await expect(first.locator('#start-people')).toBeVisible();
  await first.locator('#start-people').fill('2');
  await first.getByRole('button',{name:'Velg første middag'}).click();
  await first.getByRole('button',{name:/Taco/}).first().click();
  await expect.poll(async()=>{const d=await first.evaluate(async()=>await (await fetch('/api/core')).json());return d.data?.meals?.length||0;}).toBe(1);
  await two.addCookies([{name:'savly_session',value:simulatedGoogleSession(),url:'http://127.0.0.1:8787'}]);
  const second=await two.newPage();await second.goto(url);
  await expect(second.getByRole('heading',{name:'Ukeplan'})).toBeVisible();
  await first.locator('#tabs [data-tab=list]').click();
  await second.locator('#tabs [data-tab=list]').click();
  await first.locator('#new-item').fill('Papir');
  await first.locator('#add-item button').click();
  await second.locator('#new-item').fill('Såpe');
  await second.locator('#add-item button').click();
  await expect.poll(async()=>{const d=await first.evaluate(async()=>await (await fetch('/api/core')).json());return d.data.list.filter(x=>x.name==='Papir'||x.name==='Såpe').length;}).toBe(2);
  await second.reload();await second.locator('#tabs [data-tab=list]').click();
  await expect(second.getByText('Papir',{exact:true})).toBeVisible();
  await expect(second.getByText('Såpe',{exact:true})).toBeVisible();
 }finally{await one.close();await two.close();}
});
