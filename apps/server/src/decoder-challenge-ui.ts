// Runs inside the relayed official UI, using public DOM events only. As with
// mirror-controls, browser behavior is exercised separately by Playwright.
export const decoderChallengeCss = `
#mirror-decoder{color-scheme:dark;color:#eee;background:#181b20;border:1px solid #424953;border-radius:18px;width:min(720px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:24px;box-shadow:0 24px 90px #0009;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
#mirror-decoder::backdrop{background:#0009}
#mirror-decoder *{box-sizing:border-box}
#mirror-decoder h2{font-size:24px;font-weight:650;margin:0 0 4px}
#mirror-decoder p{margin:6px 0 16px;color:#b8c1cc}
#mirror-decoder .md-eyebrow{color:#86dfc5;font-size:11px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:5px}
#mirror-decoder .md-close{float:right;background:transparent;border:0;color:#ccc;font-size:22px;cursor:pointer}
#mirror-decoder .md-options{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0}
#mirror-decoder label{display:block;color:#cbd3dd;font-size:12px}
#mirror-decoder select,#mirror-decoder textarea{display:block;width:100%;border:1px solid #4b5360;border-radius:8px;background:#101318;color:#eee;font:inherit;padding:9px;margin-top:5px}
#mirror-decoder textarea{font:12px/1.5 ui-monospace,monospace;resize:vertical}
#mirror-decoder .md-actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
#mirror-decoder .md-actions button,#mirror-decoder .md-actions a{border:1px solid #4b5360;border-radius:8px;background:#2b313b;color:#eee;padding:9px 13px;font:inherit;text-decoration:none;cursor:pointer}
#mirror-decoder .md-actions .md-primary{background:#94e6cc;border-color:#94e6cc;color:#11281f;font-weight:600}
#mirror-decoder button:disabled{opacity:.45;cursor:wait}
#mirror-decoder .md-card{margin-top:18px;border-top:1px solid #39404a;padding-top:18px}
#mirror-decoder .md-meta{font-size:12px;color:#a5b1c0;overflow-wrap:anywhere}
#mirror-decoder .md-result{padding:12px;border:1px solid #4b5360;border-radius:9px;margin:12px 0;background:#232a33;white-space:pre-wrap}
#mirror-decoder .md-result:empty{display:none}
#mirror-decoder .md-result[data-verdict=exact]{border-color:#74d7b7;color:#9af1d3}
#mirror-decoder .md-result[data-verdict=partial]{border-color:#ddbc75;color:#f0d39a}
#mirror-decoder .md-result[data-verdict=mismatch]{border-color:#c87d85;color:#ffb5bc}
#mirror-decoder summary{cursor:pointer;color:#bccddd;margin-top:12px}
#mirror-decoder :focus-visible{outline:2px solid #94e6cc;outline-offset:3px}
@media(max-width:560px){#mirror-decoder{padding:18px}#mirror-decoder .md-options{grid-template-columns:1fr;gap:8px}}
`;

export const decoderChallengeJs = String.raw`(()=>{
if(window.__mirrorDecoderInstalled)return;
window.__mirrorDecoderInstalled=true;
var dialog=null,active=null,busy=false,history=[];
var storageKey='mirror-decoder-active-v1';
function save(){try{sessionStorage.setItem(storageKey,JSON.stringify({activeId:active.id,items:history}));}catch(e){}}
function remember(challenge){active=challenge;history.unshift(challenge);history=history.slice(0,16);save();render();field('answer').value='';}
function field(name){return dialog.querySelector('[data-md="'+name+'"]');}
function status(text,verdict){field('status').textContent=text;field('status').dataset.verdict=verdict||'';}
function render(){
  field('recent').replaceChildren();
  history.forEach(function(item){
    var option=document.createElement('option');option.value=item.id;
    option.textContent=item.label+' · '+item.guidance+' · '+item.id.slice(0,8);
    field('recent').appendChild(option);
  });
  field('recent-label').hidden=!active;
  field('challenge').hidden=!active;
  if(!active)return;
  field('recent').value=active.id;
  field('meta').textContent=active.label+' · '+active.guidance+' · '+active.payload+' payload · '+active.artifactBytes.toLocaleString()+' artifact bytes';
  field('expiry').textContent='Challenge '+active.id+' · Expires '+new Date(active.expiresAt).toLocaleString()+'. A Mirror restart or session change also expires it.';
  field('prompt').value=active.prompt;
  field('download').href='/api/decoder-challenges/'+active.id+'/artifact';
  field('download').download=active.filename;
  field('size-note').textContent=active.prompt.length>16000?'This is a large prompt. You can download prompt.txt and attach it in ChatGPT, then ask GPT to solve the challenge inside it.':'The prompt carries the original artifact as compressed base64. GPT needs code execution to reliably solve it. Inserting prepares a draft; you send it.';
}
async function request(url,body){
  var r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  var data=await r.json();
  if(!r.ok)throw Error(typeof data.error==='string'?data.error:(data.error&&data.error.message)||'Mirror request failed.');
  return data;
}
function downloadBlob(blob,filename){
  var url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;a.click();
  setTimeout(function(){URL.revokeObjectURL(url);},1000);
}
async function downloadKit(ids){
  var r=await fetch('/api/decoder-challenges/kit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:ids})});
  if(!r.ok){var error=await r.json();throw Error(error.error||'Could not download the kit.');}
  downloadBlob(await r.blob(),'mirror-decoder-kits.tar.gz');
}
async function run(action){
  if(busy)return;
  busy=true;
  dialog.querySelectorAll('button:not(.md-close),select').forEach(function(b){b.disabled=true;});
  try{await action();}catch(e){status(e.message||String(e));}
  finally{busy=false;dialog.querySelectorAll('button,select').forEach(function(b){b.disabled=false;});}
}
function markedAnswer(text){
  var marker='MIRROR_ANSWER_'+active.id+':';
  var lines=text.split(/\r?\n/).map(function(line){return line.trim();});
  var candidates=lines.filter(function(line){return line.startsWith(marker);});
  if(candidates.length!==1)throw Error('Expected one MIRROR_ANSWER line for this challenge. Ask GPT to include the marker shown in the prompt.');
  return candidates[0].slice(marker.length).trim();
}
async function verify(hex){
  hex=hex.replace(/\s/g,'');
  if(!/^(?:[0-9a-fA-F]{2})+$/.test(hex))throw Error('Paste complete hexadecimal byte pairs, or the marked answer line from GPT.');
  status('Checking recovered bytes…');
  var result=await request('/api/decoder-challenges/'+active.id+'/verify',{hex:hex});
  var title=result.verdict==='exact'?'Exact match — GPT recovered every byte.':result.verdict==='partial'?'Partial match — keep investigating.':'Mismatch — the recovered bytes differ.';
  status(title+'\n'+result.matchingBytes+' / '+result.expectedBytes+' bytes match at the same positions. Submitted: '+result.actualBytes+' bytes.',result.verdict);
}
function visible(el){return !!el&&el.getClientRects().length>0;}
function composer(){
  return Array.from(document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],textarea[placeholder*="Message"]')).find(function(el){return visible(el)&&(el.tagName==='TEXTAREA'||el.isContentEditable);});
}
function insertPrompt(){
  var el=composer();
  if(!el)throw Error('Could not find the ChatGPT composer. Use Copy prompt and paste it into your chat.');
  if((el.value||el.textContent||'').trim())throw Error('Your composer already has a draft. Copy the challenge, or clear the draft before inserting.');
  dialog.close();el.focus();
  if(el.tagName==='TEXTAREA'){
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,active.prompt);
    el.dispatchEvent(new Event('input',{bubbles:true}));
  }else{
    var selection=window.getSelection(),range=document.createRange();
    range.selectNodeContents(el);selection.removeAllRanges();selection.addRange(range);
    // Native insertText creates nested divs and can double blank lines in
    // contenteditable. Escaped text + explicit line breaks preserves the
    // exact transport while still going through the editor's input events.
    var text=document.createElement('div');text.textContent=active.prompt;
    document.execCommand('insertHTML',false,text.innerHTML.replace(/\n/g,'<br>'));
  }
  var value=el.tagName==='TEXTAREA'?el.value:el.innerText;
  if(value.replace(/\r\n/g,'\n')!==active.prompt){dialog.showModal();throw Error('ChatGPT did not accept the complete prompt. Use Copy prompt, and replace any partial draft before sending.');}
  status('Challenge inserted. Send it in ChatGPT, then reopen Decoder challenges to check the reply.');
}
function build(){
  dialog=document.createElement('dialog');dialog.id='mirror-decoder';
  dialog.setAttribute('aria-labelledby','mirror-decoder-title');
  dialog.innerHTML='<button class="md-close" aria-label="Close decoder challenges">×</button><div class="md-eyebrow">Mirror lab</div><h2 id="mirror-decoder-title">Decoder challenges</h2><p>Give GPT an encoded mystery. Let it write a decoder, then check whether it recovered every byte.</p>'
    +'<div class="md-options"><label>Format<select data-md="format"><option value="loaf">LoaF</option><option value="pngspeak" selected>PngSpeak</option><option value="gptgif">Original gptgif</option><option value="gptgif-v4">gptgif v4</option></select></label><label>Guidance<select data-md="guidance"><option value="guided">Include format guide</option><option value="independent">Let GPT investigate</option></select></label><label>Hidden payload<select data-md="payload"><option value="text">UTF-8 note</option><option value="binary">Random binary</option></select></label></div>'
    +'<div class="md-actions"><button class="md-primary" data-md="generate">Generate challenge</button></div><details><summary>Optional: get files and prompts</summary><p>Take a challenge kit with you: encoded artifact, matching GPT prompt, separate format guide, and instructions. The answer key stays here.</p><div class="md-actions"><button data-md="all-kits">Get all four kits</button></div><p>Uses your selected guidance and payload type. Downloads one .tar.gz archive you can open on your computer.</p></details><div class="md-result" data-md="status" role="status" aria-live="polite"></div><label data-md="recent-label" hidden>Recent challenges<select data-md="recent"></select></label>'
    +'<section class="md-card" data-md="challenge" hidden><strong>1. Challenge GPT</strong><div class="md-meta" data-md="meta"></div><div class="md-actions"><button class="md-primary" data-md="insert">Insert into chat</button><button data-md="copy">Copy prompt</button><a data-md="download">Download artifact</a><button data-md="packet">Download prompt</button><button data-md="kit">Download this kit</button></div>'
    +'<p data-md="size-note"></p>'
    +'<details><summary>Inspect challenge prompt</summary><textarea data-md="prompt" aria-label="Challenge prompt" rows="7" readonly></textarea></details>'
    +'<div class="md-card"><strong>2. Check the recovered bytes</strong><div class="md-actions"><button data-md="latest">Check latest GPT reply</button></div><label>Or paste recovered hex / the marked answer line<textarea data-md="answer" rows="3" maxlength="8192" spellcheck="false" placeholder="Paste GPT’s hexadecimal answer here"></textarea></label><div class="md-actions"><button data-md="verify">Check pasted answer</button></div><div class="md-meta" data-md="expiry"></div></div></section>';
  document.body.appendChild(dialog);
  dialog.querySelector('.md-close').onclick=function(){dialog.close();};
  field('generate').onclick=function(){run(async function(){
    status('Encoding a fresh challenge…');
    var next=await request('/api/decoder-challenges',{format:field('format').value,guidance:field('guidance').value,payload:field('payload').value});
    remember(next);
    status('Ready. Insert the challenge into ChatGPT. The answer key stays on Mirror’s server.');
  });};
  field('recent').onchange=function(){active=history.find(function(item){return item.id===field('recent').value;});save();render();field('answer').value='';status('Selected challenge. Check its matching GPT answer below.');};
  field('kit').onclick=function(){run(async function(){await downloadKit([active.id]);status('Kit downloaded: artifact, prompt, optional guide, and instructions.');});};
  field('all-kits').onclick=function(){run(async function(){
    var ids=[];
    for(var format of ['loaf','pngspeak','gptgif','gptgif-v4']){
      status('Preparing '+format+' kit…');
      var next=await request('/api/decoder-challenges',{format:format,guidance:field('guidance').value,payload:field('payload').value});
      remember(next);ids.push(next.id);
    }
    await downloadKit(ids);status('All four kits downloaded. Use Recent challenges to select the one you want to check.');
  });};
  field('insert').onclick=function(){run(async function(){insertPrompt();});};
  field('copy').onclick=function(){run(async function(){
    try{await navigator.clipboard.writeText(active.prompt);status('Prompt copied. Paste it into ChatGPT.');}
    catch(e){field('prompt').closest('details').open=true;field('prompt').focus();field('prompt').select();throw Error('Clipboard access unavailable. The prompt is selected; copy it with your keyboard.');}
  });};
  field('packet').onclick=function(){
    downloadBlob(new Blob([active.prompt],{type:'text/plain;charset=utf-8'}),'decoder-'+active.id+'-prompt.txt');
  };
  field('latest').onclick=function(){run(async function(){
    var messages=Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).filter(visible);
    if(!messages.length)throw Error('No visible GPT reply found. You can paste the recovered hex below.');
    var hex=markedAnswer(messages[messages.length-1].innerText);field('answer').value=hex;await verify(hex);
  });};
  field('verify').onclick=function(){run(async function(){
    var text=field('answer').value.trim();await verify(text.includes('MIRROR_ANSWER_')?markedAnswer(text):text);
  });};
  try{
    var saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');
    if(saved&&Array.isArray(saved.items)){
      history=saved.items.filter(function(item){return item&&/^[0-9a-f-]{36}$/.test(item.id)&&typeof item.prompt==='string'&&typeof item.artifactBytes==='number'&&item.expiresAt>Date.now();}).slice(0,16);
      active=history.find(function(item){return item.id===saved.activeId;})||history[0]||null;
    }
  }catch(e){}
  render();
}
window.addEventListener('mirror:decoder-open',function(){
  if(!dialog)build();
  if(!dialog.isConnected)document.body.appendChild(dialog);
  if(!dialog.open)dialog.showModal();
});
})();`;
