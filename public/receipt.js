/* Receipt images are processed locally by Tesseract; only engine/language files are downloaded. */
var receiptBusy=false,receiptEpoch=0,receiptWorker=null,receiptLoader=null,receiptImage=null;
function receiptEscape(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function parseReceipt(text){
 const items=[];let store='',total=null;
 const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
 for(const line of lines){
  if(!store){const m=line.match(/\b(REMA\s*1000|KIWI|EUROSPAR|SPAR|MENY|OBS|EXTRA|COOP|BUNNPRIS|JOKER|PRIX|MATKROKEN|NÆRBUTIKKEN|HOLDBART)\b/i);if(m)store=m[0];}
  const m=line.match(/^(.*?)\s+(-?\d+(?:[ .]\d{3})*[,\.]\d{2})\s*(?:[A-D*])?$/i);if(!m)continue;
  let name=m[1].trim(),price=Number(m[2].replace(/ (\d)/g,'$1').replace(/\.(?=\d{3}[,.])/g,'').replace(',','.'));
  if(/^(?:total(?:t)?|sum(?:ma)?|å betale|å betala|beløp)\b/i.test(name)){total=price;continue;}
  if(!/[a-zæøå]/i.test(name)||/^(?:mva|moms|vat|kontant|bank|visa|mastercard|kort|betalt|betaling|tilbake|veksel|rabatt|du spar|bonus|pant|subtotal|avrunding|org|tlf|terminal|saldo)\b/i.test(name)||price<0||price>100000)continue;
  if(/\b(?:kg|stk)\s*[xX*à@]/.test(name))continue;
  let quantity=1;const qty=name.match(/^(\d{1,2})\s*[xX*]\s*(.+)$/);if(qty){quantity=Number(qty[1]);name=qty[2];}
  items.push({name:name.slice(0,80),quantity:quantity||1,price});
 }
 return {store,total,items:items.slice(0,150)};
}
function receiptLoadEngine(){
 if(window.Tesseract)return Promise.resolve();
 if(receiptLoader)return receiptLoader;
 receiptLoader=new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js';
  const timer=setTimeout(()=>{script.remove();receiptLoader=null;reject(Error('Kunne ikke laste skanneren. Sjekk nettet og prøv igjen.'));},30000);
  script.onload=()=>{clearTimeout(timer);resolve();};script.onerror=()=>{clearTimeout(timer);script.remove();receiptLoader=null;reject(Error('Skanneren kunne ikke lastes. Sjekk nettet og prøv igjen.'));};document.head.appendChild(script);
 });return receiptLoader;
}
function receiptHome(){
 document.getElementById('v5ScanStage').innerHTML='<h3>Skann kvitteringen din</h3><p>Legg kvitteringen flatt i godt lys. Få med hele teksten og hold kameraet rett over.</p><p>Bildet behandles på enheten din. Første skann laster ned språkfiler og kan ta litt tid.</p><label class="receipt-pick">Ta bilde<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onchange="receiptSelect(this)"></label><label class="receipt-pick receipt-secondary">Velg bilde<input type="file" accept="image/jpeg,image/png,image/webp" onchange="receiptSelect(this)"></label><p class="muted">JPG, PNG eller WebP · maks 15 MB. PDF og HEIC støttes ikke; bruk et skjermbilde i stedet.</p><p id="receiptError" role="alert"></p>';
}
openV5Scan=function(){document.getElementById('v5ScanSheet').classList.add('show');if(!document.getElementById('receiptStatus')&&!document.getElementById('receiptRows'))receiptHome();};
closeV5Scan=function(){receiptEpoch++;receiptBusy=false;if(receiptWorker){receiptWorker.terminate();receiptWorker=null;}if(receiptImage){URL.revokeObjectURL(receiptImage);receiptImage=null;}document.getElementById('v5ScanSheet').classList.remove('show');document.getElementById('v5ScanStage').innerHTML='';};
async function receiptSelect(input){
 const file=input.files[0];if(!file||receiptBusy)return;
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>15*1024*1024){document.getElementById('receiptError').textContent='Velg et JPG-, PNG- eller WebP-bilde under 15 MB.';input.value='';return;}
 receiptBusy=true;const epoch=++receiptEpoch;let worker=null,timeout;
 const host=document.getElementById('v5ScanStage');host.innerHTML='<h3>Leser kvitteringen …</h3><p id="receiptStatus" role="status" aria-live="polite">Klargjør bildet</p><p>Du kan avbryte ved å lukke vinduet.</p>';
 try{
  receiptImage=URL.createObjectURL(file);const img=new Image();img.src=receiptImage;await img.decode();if(epoch!==receiptEpoch)return;
  const scale=Math.min(1,2400/Math.max(img.width,img.height));const canvas=document.createElement('canvas');canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);
  const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(img,0,0,canvas.width,canvas.height);URL.revokeObjectURL(receiptImage);receiptImage=null;
  const work=async()=>{
   await receiptLoadEngine();if(epoch!==receiptEpoch)return null;
   worker=await Tesseract.createWorker('nor+eng',1,{logger:m=>{if(epoch===receiptEpoch){const el=document.getElementById('receiptStatus');if(el)el.textContent=m.status==='recognizing text'?'Leser tekst: '+Math.round(m.progress*100)+' %':'Laster skanner og språkfiler …';}}});
   if(epoch!==receiptEpoch){await worker.terminate();return null;}receiptWorker=worker;
   const result=await worker.recognize(canvas);return result.data.text;
  };
  const text=await Promise.race([work(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Skanningen tok for lang tid. Prøv et skarpere eller mindre bilde.')),120000);})]);
  if(epoch===receiptEpoch&&text!==null)receiptReview(text);
 }catch(e){if(epoch===receiptEpoch){receiptEpoch++;receiptHome();document.getElementById('receiptError').textContent=e.message||'Bildet kunne ikke leses. Prøv et nytt bilde.';}}
 finally{clearTimeout(timeout);if(worker)await worker.terminate().catch(()=>{});if(receiptWorker===worker)receiptWorker=null;if(receiptImage&&epoch===receiptEpoch){URL.revokeObjectURL(receiptImage);receiptImage=null;}if(epoch===receiptEpoch||!document.getElementById('receiptStatus'))receiptBusy=false;}
}
function receiptRow(item={name:'',quantity:1,price:''}){
 const row=document.createElement('div');row.className='receipt-row';row.innerHTML='<input type="checkbox" aria-label="Velg vare"><label>Vare<input class="receipt-name" maxlength="80" value="'+receiptEscape(item.name)+'"></label><label>Antall<input class="receipt-quantity" type="number" min="1" max="999" step="1" value="'+item.quantity+'"></label><label>Linjepris (kr)<input class="receipt-price" type="number" min="0" step="0.01" value="'+item.price+'"></label>';document.getElementById('receiptRows').appendChild(row);
}
function receiptReview(text){
 const result=parseReceipt(text);document.getElementById('v5ScanStage').innerHTML='<h3>Kontroller kvitteringen</h3><p>'+receiptEscape(result.store||'Butikk ikke gjenkjent')+(result.total!==null?' · Lest total: '+result.total.toFixed(2)+' kr':'')+'</p><p>Tekstlesing kan ta feil. Rett navn og antall, og kryss av matvarene du vil legge i kjøleskapet. Priser er kun til kontroll; forbruk lagres ikke her.</p><div id="receiptRows"></div><button class="btn receipt-secondary" onclick="receiptRow()">Legg til manglende vare</button><details><summary>Se og korriger lest tekst</summary><textarea id="receiptRaw" rows="9"></textarea><button class="btn receipt-secondary" onclick="receiptReview(document.getElementById(\'receiptRaw\').value)">Les varelinjene på nytt</button></details><p id="receiptReviewError" role="alert"></p><button id="receiptSave" class="btn primary" onclick="receiptSaveItems()">Legg valgte varer i kjøleskapet</button><button class="btn receipt-secondary" onclick="receiptHome()">Skann en ny kvittering</button>';
 document.getElementById('receiptRaw').value=text;
 result.items.forEach(receiptRow);
 if(!result.items.length){receiptRow();document.getElementById('receiptReviewError').textContent='Ingen sikre varelinjer funnet. Du kan skrive dem inn eller prøve et tydeligere bilde.';}
}
function receiptSaveItems(){
 const selected=[...document.querySelectorAll('#receiptRows .receipt-row')].filter(row=>row.querySelector('[type=checkbox]').checked);
 const error=document.getElementById('receiptReviewError');
 if(!selected.length){error.textContent='Kryss av minst én matvare først.';return;}
 const items=selected.map(row=>({name:row.querySelector('.receipt-name').value.trim(),quantity:Number(row.querySelector('.receipt-quantity').value)}));
 if(items.some(x=>!x.name||!Number.isInteger(x.quantity)||x.quantity<1||x.quantity>999)){error.textContent='Alle valgte varer må ha navn og et helt antall mellom 1 og 999.';return;}
 const before=state.fridge;state.fridge=[...(before||[]),...items.map(x=>({...x,id:'receipt-'+crypto.randomUUID()}))];
 try{saveFridge();}catch(e){state.fridge=before;error.textContent='Kunne ikke lagre. Prøv igjen eller frigjør lagringsplass i nettleseren.';return;}
 document.getElementById('receiptSave').disabled=true;closeV5Scan();renderFridge();updateHomeOverview();go('scan');toast(items.length+' varer lagt til. Legg inn utløpsdatoene selv.');
}
