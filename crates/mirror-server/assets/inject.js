(()=>{
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
  status('Challenge inserted. Send it in ChatGPT, then reopen Format Lab to check the reply.');
}
function build(){
  dialog=document.createElement('dialog');dialog.id='mirror-decoder';
  dialog.setAttribute('aria-labelledby','mirror-decoder-title');
  dialog.innerHTML='<button class="md-close" aria-label="Close decoder challenges">×</button><div class="md-eyebrow">Mirror lab · GPT co-creation</div><h2 id="mirror-decoder-title">Format Lab</h2><p>Give GPT an encoded mystery, or ask it to build and transform a tiny artifact with one of Mirror’s four unusual formats.</p>'
    +'<div class="md-options"><label>Format<select data-md="format"><option value="loaf">LoaF</option><option value="pngspeak" selected>PngSpeak</option><option value="gptgif">Original gptgif</option><option value="gptgif-v4">gptgif v4</option></select></label><label>Guidance<select data-md="guidance"><option value="guided">Include format guide</option><option value="independent">Let GPT investigate</option></select></label><label>Hidden payload<select data-md="payload"><option value="text">UTF-8 note</option><option value="binary">Random binary</option></select></label></div>'
    +'<div class="md-actions"><button class="md-primary" data-md="generate">Generate challenge</button></div><details><summary>Optional: get files and prompts</summary><p>Take a challenge kit with you: encoded artifact, matching GPT prompt, separate format guide, and instructions. The answer key stays here.</p><div class="md-actions"><button data-md="all-kits">Get all four kits</button></div><p>Uses your selected guidance and payload type. Downloads one .tar.gz archive you can open on your computer.</p></details><div class="md-result" data-md="status" role="status" aria-live="polite"></div><label data-md="recent-label" hidden>Recent challenges<select data-md="recent"></select></label>'
    +'<section class="md-card" data-md="workshop"><strong>GPT workshop</strong><p>Describe something for GPT to make, remix, or explain. Mirror gives it an exact format-aware brief that asks for a useful artifact and a compact change log.</p><label>Creative brief<textarea data-md="brief" rows="3" placeholder="Make a tiny choose-your-own-adventure with three rooms and a secret ending."></textarea></label><div class="md-actions"><button class="md-primary" data-md="build">Ask GPT to build it</button><button data-md="remix">Ask GPT to remix this format</button><button data-md="explain">Ask GPT to explain a format</button></div></section>'
    +'<section class="md-card" data-md="challenge" hidden><strong>Decoder challenge</strong><div class="md-meta" data-md="meta"></div><div class="md-actions"><button class="md-primary" data-md="insert">Insert into chat</button><button data-md="copy">Copy prompt</button><a data-md="download">Download artifact</a><button data-md="packet">Download prompt</button><button data-md="kit">Download this kit</button></div>'
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
  function briefBase64(text){
    var bytes=new TextEncoder().encode(text),binary='';
    for(var i=0;i<bytes.length;i++)binary+=String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  async function workshopPrompt(kind){
    var format=field('format').value, brief=field('brief').value.trim()||'a tiny interactive story with a surprising ending';
    var lead=kind==='build'?'Create':kind==='remix'?'Remix':'Explain';
    var note=kind==='explain'?'Explain how the format represents bytes, then demonstrate with a tiny valid example. If code execution is available, generate and inspect the exact bytes.':'Produce the actual artifact bytes or a complete reproducible script that creates them. Keep a manifest of files/bytes, describe format-specific tradeoffs, and end with a short CHANGELOG for the next iteration. Do not pretend an image is ordinary visual art if it is carrying data.';
    var response=await fetch('/api/convert/gpt-prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({dataBase64:briefBase64(brief),format:format,filename:'format-lab-brief.txt',note:note})});
    var data=await response.json();
    if(!response.ok)throw Error(data.error||'The conversion API could not build this format prompt.');
    return data.prompt+'\n\nYou are collaborating with Mirror Format Lab. '+lead+' a '+format+' artifact for this brief: '+brief+'\nUse the format exactly as described above, preserve Unicode and binary bytes, and clearly label anything that is a lossy visual experiment. Mirror will display the resulting file and can feed a later remix back to you.';
  }
  async function putWorkshopPrompt(kind){var text=await workshopPrompt(kind);field('prompt').value=text;field('prompt').closest('details').open=true;status('Workshop brief ready. Insert it into the chat or copy it for GPT.');}
  field('build').onclick=function(){run(async function(){await putWorkshopPrompt('build');});};
  field('remix').onclick=function(){run(async function(){await putWorkshopPrompt('remix');});};
  field('explain').onclick=function(){run(async function(){await putWorkshopPrompt('explain');});};
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
function findComposerAnchor(){
  var candidates=Array.from(document.querySelectorAll('#prompt-textarea,[data-testid="prompt-textarea"],textarea[placeholder*="Message"],textarea[placeholder*="Send"]'));
  return candidates.find(function(el){return el.getClientRects().length>0;});
}
function mountFormatLauncher(){
  if(document.getElementById('mirror-format-lab-launcher'))return true;
  var composer=findComposerAnchor();if(!composer)return false;
  var host=composer.closest('form')||composer.parentElement;
  if(!host||!host.parentElement)return false;
  var button=document.createElement('button');button.id='mirror-format-lab-launcher';button.type='button';button.innerHTML='<span class="mfl-spark">✦</span><span>Format Lab</span>';
  button.title='Open Mirror’s GPT format workshop';button.onclick=function(){window.dispatchEvent(new Event('mirror:decoder-open'));};
  host.parentElement.insertBefore(button,host);
  return true;
}
mountFormatLauncher();
var launchTimer=setInterval(function(){if(mountFormatLauncher())clearInterval(launchTimer);},500);
})();
(()=>{
var widgetRoot=null;
function buildWidget(){
  var root=document.createElement('div');
  root.id='mirror-launcher';
  root.innerHTML='<button type="button" class="mirror-row"><span class="mirror-dot"></span><span>Mirror controls</span></button>'
    +'<div class="mirror-panel"><strong>Mirror controls</strong><p>Connect with a sessionToken. <a class="mirror-session-link" href="https://chatgpt.com/api/auth/session" target="_blank" rel="noopener noreferrer">Get it from ChatGPT</a>. The credential stays encrypted on this server and is never inserted into ChatGPT page scripts.</p><label>sessionToken</label><textarea autocomplete="off" spellcheck="false" placeholder="Paste sessionToken"></textarea><div class="mirror-actions"><button class="mirror-save">Save &amp; reload</button><a class="mirror-play" href="/mirror/playground" target="_blank" rel="noopener noreferrer">API tester</a><a class="mirror-docs" href="/mirror/api-docs" target="_blank" rel="noopener noreferrer">API docs</a></div><div class="mirror-status"></div><div class="mirror-egress">Egress: checking…</div></div>';
  var decoder=document.createElement('button');
  decoder.type='button';decoder.className='mirror-docs';decoder.textContent='Decoder challenges';
  decoder.onclick=function(){root.querySelector('.mirror-panel').classList.remove('open');window.dispatchEvent(new Event('mirror:decoder-open'));};
  root.querySelector('.mirror-actions').appendChild(decoder);
  return root;
}
function getWidget(){if(!widgetRoot)widgetRoot=buildWidget();return widgetRoot;}
function positionPanel(row,panel){
  var r=row.getBoundingClientRect();
  panel.style.left=Math.max(8,Math.round(r.left))+'px';
  panel.style.bottom=Math.round(window.innerHeight-r.top+8)+'px';
}
function openPanel(root){
  var row=root.querySelector('.mirror-row'),panel=root.querySelector('.mirror-panel');
  positionPanel(row,panel);
  panel.classList.add('open');
  var area=root.querySelector('textarea');
  if(area)area.focus();
}
function wireWidget(root){
  if(root.dataset.wired)return;
  root.dataset.wired='1';
  var row=root.querySelector('.mirror-row'),panel=root.querySelector('.mirror-panel'),
      status=root.querySelector('.mirror-status'),area=root.querySelector('textarea');
  row.onclick=function(){
    var willOpen=!panel.classList.contains('open');
    if(willOpen)positionPanel(row,panel);
    panel.classList.toggle('open',willOpen);
  };
  window.addEventListener('resize',function(){if(panel.classList.contains('open'))positionPanel(row,panel);});
  window.addEventListener('scroll',function(){if(panel.classList.contains('open'))positionPanel(row,panel);},true);
  var apiLinks=root.querySelectorAll('a.mirror-play,a.mirror-docs');
  for(var li=0;li<apiLinks.length;li++)(function(link){
    link.addEventListener('click',function(e){
      e.preventDefault();
      window.open(link.href,'_blank','noopener,noreferrer');
    });
  })(apiLinks[li]);
  root.querySelector('.mirror-save').onclick=async function(){
    var token=area.value.trim();if(!token)return;
    status.textContent='Verifying…';
    try{
      var r=await fetch('/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionToken:token})});
      var b=await r.json();
      if(!r.ok)throw Error(b.error||'Could not connect');
      area.value='';status.textContent='Connected. Reloading…';location.reload();
    }catch(e){status.textContent=e.message||String(e);}
  };
  fetch('/api/session').then(function(r){return r.json();}).then(function(s){
    root.querySelector('.mirror-dot').style.background=s.configured?'#19c59a':'#e7a83d';
  }).catch(function(){});
  fetch('/api/health').then(function(r){return r.json();}).then(function(h){
    var e=h&&h.egress,el=root.querySelector('.mirror-egress');
    if(!e){el.textContent='Egress: unavailable';return;}
    el.textContent=e.mode==='warp'&&e.verified?'Egress: WARP verified':'Egress: direct';
    el.style.color=e.required&&!e.verified?'#f0a28a':'#aaa';
  }).catch(function(){root.querySelector('.mirror-egress').textContent='Egress: unavailable';});
}
function isReallyVisible(el){
  if(el.offsetParent===null)return false;
  // Only walk ancestors for opacity and display: those two visually/structurally
  // compound down the tree and can never be un-done by a descendant (an
  // ancestor at opacity:0 or display:none makes everything under it
  // genuinely invisible, no override possible). visibility and pointer-events
  // are NOT safe to check this way -- both are routinely reset back by a
  // descendant (e.g. a modal sets pointer-events:none on <body> for a focus
  // trap, then explicitly re-enables pointer-events:auto on the dialog/
  // popover itself), so walking those flagged the real, currently-visible
  // sidebar popover as hidden just because <body> had pointer-events:none.
  var n=el;
  for(var i=0;i<12&&n;i++){
    var cs=getComputedStyle(n);
    if(cs.opacity==='0'||cs.display==='none')return false;
    n=n.parentElement;
  }
  return el.getBoundingClientRect().width>0;
}
function findLoggedOutAnchor(){
  // Logged-out users have no accounts-profile-button in the visible sidebar
  // (only a hidden copy inside the collapsed icon rail, which stays present
  // but invisible in the DOM regardless of login state). Instead the
  // expanded sidebar shows a dedicated "log in" promo pane pinned to its
  // bottom, with a full-width "Log in" button. We anchor above that button
  // instead. There's a second "Log in" button in the top-right page header
  // (shown for logged-out users on every screen) -- that one isn't part of
  // the sidebar chrome at all, so it's explicitly excluded.
  var buttons=document.querySelectorAll('button');
  for(var i=0;i<buttons.length;i++){
    var b=buttons[i];
    if((b.textContent||'').trim()!=='Log in')continue;
    if(b.closest('#page-header'))continue;
    if(!isReallyVisible(b))continue;
    return b;
  }
  return null;
}
function mountInSidebar(){
  // The sidebar's account button can exist in more than one DOM copy at once
  // (a persistent icon-only rail plus a wider overlay/push variant used at
  // other viewport widths or collapse states) -- only one is ever actually
  // shown to the user. offsetParent alone doesn't detect the inactive one,
  // since it's kept in normal layout flow just faded out
  // (opacity:0/pointer-events:none) rather than display:none, so it must be
  // filtered out explicitly or the widget can end up mounted into a hidden
  // copy (never visible) or the wrong-width one (its label gets truncated).
  var accts=document.querySelectorAll('[data-testid="accounts-profile-button"]');
  var acct=null;
  for(var i=0;i<accts.length;i++){if(isReallyVisible(accts[i])){acct=accts[i];break;}}
  var anchor=acct,compactHint=null;
  if(!anchor){
    // Logged out: fall back to anchoring above the sidebar's own "Log in"
    // button instead of the (invisible, in this state) account button.
    anchor=findLoggedOutAnchor();
    compactHint=false; // the login promo pane only ever renders in the expanded sidebar
  }
  if(!anchor)return false;
  var wrapper=anchor.parentElement,container=wrapper&&wrapper.parentElement;
  if(!wrapper||!container)return false;
  var root=getWidget();
  if(root.nextElementSibling!==wrapper||root.parentElement!==container)container.insertBefore(root,wrapper);
  // Prefer a structural check over measuring container width: the account
  // button's own row can overflow wider than its rail ancestor on hover
  // (a flyout-label effect), which makes width alone an unreliable signal
  // for "is this the icon-only rail". #stage-sidebar-tiny-bar is ChatGPT's
  // collapsed icon rail; fall back to a width heuristic if that id ever
  // changes upstream.
  var compact;
  if(compactHint!==null){
    compact=compactHint;
  }else{
    var railAncestor=container.closest('#stage-sidebar-tiny-bar');
    compact=railAncestor?true:container.getBoundingClientRect().width<100;
  }
  root.classList.toggle('mirror-compact',compact);
  wireWidget(root);
  return true;
}
function hideWidget(){
  if(!widgetRoot||!widgetRoot.parentElement)return;
  var panel=widgetRoot.querySelector('.mirror-panel');
  if(panel)panel.classList.remove('open');
  widgetRoot.remove();
}
function tryMount(){if(!mountInSidebar())hideWidget();}
tryMount();
setInterval(tryMount,1000);

// ChatGPT's own "Log in" buttons (sidebar promo pane + top-right header)
// kick off its real OAuth flow, which can't complete through this proxy.
// Redirect clicks on either into our own sessionToken panel instead, so
// logged-out users aren't led down a login path that won't work. Re-scans
// on the same interval as tryMount since React can swap these nodes out.
function interceptLoginButtons(){
  if(!widgetRoot)return;
  var buttons=document.querySelectorAll('button');
  for(var i=0;i<buttons.length;i++){
    var b=buttons[i];
    if(b.dataset.mirrorIntercepted)continue;
    if((b.textContent||'').trim()!=='Log in')continue;
    b.dataset.mirrorIntercepted='1';
    b.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();e.stopImmediatePropagation();
      openPanel(getWidget());
    },true);
  }
}
setInterval(interceptLoginButtons,1000);

// The upstream bundle shows a blocking "Your session has expired" dialog
// (with a full-viewport backdrop) whenever the sessionToken this proxy is
// using no longer validates upstream -- e.g. the user logged out/back in or
// changed security settings on the real chatgpt.com account, rotating the
// token our stored session was minted from. That dialog is real ChatGPT
// chrome expecting its own (non-functional, through this proxy) login flow,
// and its backdrop sits above the sidebar and blocks all clicks/typing,
// including into our own widget -- so the normal fix (open Mirror controls,
// paste a fresh sessionToken) becomes unreachable right when it's needed
// most. We can't "log in" through it, so instead we tear the dialog (and
// its backdrop) out of the DOM whenever it appears, and clear any
// scroll/pointer-events lock it left behind on <html>/<body>, so the page
// -- and our widget -- stay usable. Runs on the same light interval as the
// rest of this shim in case the app re-renders the dialog back in.
function hideEl(el){
  // Neutralize visually AND for hit-testing, without detaching the node from
  // the DOM. React (which owns this whole tree, including Radix's portal
  // nodes) keeps its own fiber tree in sync with the real DOM; forcibly
  // removeChild-ing a node React still believes exists desyncs that
  // internal bookkeeping. React attaches ONE delegated listener at the
  // root for every event type rather than per-element handlers, so once
  // that desync happens its event dispatch can silently stop finding a
  // target for anything, anywhere on the page -- which is exactly the
  // "nothing is clickable or typable anymore" breakage this caused before.
  // Hiding via inline styles (kept off with !important so the app's own
  // stylesheet can't win the cascade back) leaves the node in place and
  // React's tree untouched, while still fully removing it from view and
  // from the hit-test/tab order.
  try{
    el.style.setProperty('display','none','important');
    el.style.setProperty('pointer-events','none','important');
    el.setAttribute('aria-hidden','true');
    el.setAttribute('inert','');
  }catch(e){}
}
function removeExpiredSessionModal(){
  var bodyText=document.body&&document.body.innerText;
  var sawExpired=!!bodyText&&bodyText.toLowerCase().indexOf("session has expired")!==-1;
  if(sawExpired){
    // The real upstream markup for this dialog is a plain
    // <div id="modal-expired-session" data-testid="modal-expired-session">
    // -- not role="dialog"/"alertdialog" and not inside a data-radix-portal
    // wrapper, so neither of those (reasonable-looking, but wrong for this
    // specific dialog) signals ever matched it. That mismatch is why the
    // previous version only ever hid a small inner text node instead of the
    // actual full-viewport clickable container, leaving the real thing live
    // and still swallowing every click/keystroke on the page. Prefer this
    // exact, stable identifier; keep the generic role/portal walk-up only as
    // a fallback in case a future upstream build changes the markup.
    var known=document.getElementById('modal-expired-session')
      ||document.querySelector('[data-testid="modal-expired-session"]');
    if(known){
      hideEl(known);
      window.__mirrorExpiredModalSeen=Date.now();
    }else{
      var leaves=document.body.querySelectorAll('*'),target=null;
      for(var i=0;i<leaves.length;i++){
        var el=leaves[i];
        if(el.children.length===0&&el.textContent&&el.textContent.toLowerCase().indexOf("session has expired")!==-1){target=el;break;}
      }
      if(target){
        var n=target,dialog=null;
        for(var j=0;j<20&&n&&n!==document.body;j++){
          var role=n.getAttribute&&n.getAttribute('role');
          if(role==='dialog'||role==='alertdialog'||(n.hasAttribute&&n.hasAttribute('data-radix-portal'))){dialog=n;break;}
          n=n.parentElement;
        }
        if(!dialog)dialog=target;
        var portalRoot=dialog.closest?dialog.closest('[data-radix-portal]')||dialog:dialog;
        hideEl(portalRoot);
        window.__mirrorExpiredModalSeen=Date.now();
      }
    }
  }
  // Radix (and similar) dialog libraries render the dimmed backdrop as a
  // sibling overlay element, not inside the dialog itself, so it survives
  // hiding the dialog above and keeps swallowing clicks even once the
  // dialog is gone -- neutralize it by selector, and (for a few seconds
  // after we last saw the expired-session text, in case the backdrop
  // doesn't match any of these selectors) any large invisible fixed-position
  // element still capturing pointer events anywhere on the page.
  var recentlyExpired=!!window.__mirrorExpiredModalSeen&&(Date.now()-window.__mirrorExpiredModalSeen)<5000;
  if(sawExpired||recentlyExpired){
    var overlaySelector='[data-radix-dialog-overlay],[class*="overlay" i][class*="fixed" i],[data-state="open"][class*="backdrop" i]';
    var overlays=document.querySelectorAll(overlaySelector);
    for(var k=0;k<overlays.length;k++)hideEl(overlays[k]);
    var candidates=document.body.querySelectorAll('div,section');
    for(var m=0;m<candidates.length;m++){
      var c=candidates[m];
      if(c.id==='mirror-launcher'||c.closest('#mirror-launcher'))continue;
      var cs=getComputedStyle(c);
      if(cs.position!=='fixed'||cs.pointerEvents==='none')continue;
      var r=c.getBoundingClientRect();
      if(r.width>=window.innerWidth*0.9&&r.height>=window.innerHeight*0.9)hideEl(c);
    }
  }
  if(sawExpired||recentlyExpired){
  document.documentElement.style.removeProperty('pointer-events');
  document.body.style.removeProperty('pointer-events');
  document.body.style.removeProperty('overflow');
  document.documentElement.removeAttribute('data-scroll-locked');
  document.body.removeAttribute('data-scroll-locked');
  }
  // The real bug: accessible dialog implementations (Radix included) don't
  // just render a backdrop -- opening one also marks every OTHER top-level
  // sibling of the dialog as aria-hidden/inert, so screen readers and
  // keyboard/tab navigation skip straight to the modal (a focus trap).
  // That marking is applied directly to the rest of the app's content, not
  // to the dialog itself, so hiding/removing the dialog above does nothing
  // to undo it -- the page looks normal again but every element is still
  // marked inert underneath, which is why nothing was clickable or
  // typable even after the dialog visually disappeared. Only runs while
  // we've actually just handled an expired-session dialog, since aria-hidden
  // is also used legitimately elsewhere (e.g. a real, dismissable modal that
  // IS currently open) and we must not rip focus-trapping out from under
  // one of those.
  if(sawExpired||recentlyExpired){
    var inertEls=document.body.querySelectorAll('[inert],[aria-hidden="true"]');
    for(var p=0;p<inertEls.length;p++){
      var ie=inertEls[p];
      if(ie.id==='mirror-launcher'||ie.closest('#mirror-launcher'))continue;
      if(ie.style.display==='none')continue; // one of the dialog/overlay nodes we just hid
      ie.removeAttribute('inert');
      ie.removeAttribute('aria-hidden');
    }
  }
  return sawExpired;
}
setInterval(removeExpiredSessionModal,500);
removeExpiredSessionModal();

var sidebarOpenedOnce=false;
function ensureSidebarOpenOnce(){
  if(sidebarOpenedOnce)return;
  var btn=document.querySelector('[data-testid="open-sidebar-button"]');
  if(!btn)return;
  sidebarOpenedOnce=true;
  if(btn.getAttribute('aria-expanded')==='false')btn.click();
}
ensureSidebarOpenOnce();
var sidebarPoll=setInterval(function(){
  ensureSidebarOpenOnce();
  if(sidebarOpenedOnce)clearInterval(sidebarPoll);
},200);
setTimeout(function(){clearInterval(sidebarPoll);},10000);
})();