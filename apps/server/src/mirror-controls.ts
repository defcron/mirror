export const injectionCss = `
#mirror-launcher{font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#ececec;width:100%;position:relative;z-index:2147483647;pointer-events:auto}
#mirror-launcher *{box-sizing:border-box}
#mirror-launcher button{font:inherit}
#mirror-launcher .mirror-row{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:#ececec;border-radius:8px;padding:8px 10px;cursor:pointer;text-align:left;overflow:hidden}
#mirror-launcher .mirror-row:hover{background:rgba(255,255,255,.08)}
#mirror-launcher .mirror-row span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#mirror-launcher.mirror-compact{width:36px}
#mirror-launcher.mirror-compact .mirror-row{width:36px;height:36px;padding:0;justify-content:center;border-radius:50%}
#mirror-launcher.mirror-compact .mirror-row span:last-child{display:none}
#mirror-launcher .mirror-dot{width:8px;height:8px;border-radius:50%;background:#19c59a;flex:none}
#mirror-launcher .mirror-panel{position:fixed;display:none;z-index:2147483646;width:236px;padding:13px;border:1px solid #404040;border-radius:14px;background:#202020;box-shadow:0 18px 55px #000a}
#mirror-launcher .mirror-panel.open{display:block}
#mirror-launcher .mirror-panel strong,#mirror-launcher .mirror-panel label{display:block;margin-bottom:7px}
#mirror-launcher .mirror-panel p{color:#aaa;font-size:11px}
#mirror-launcher .mirror-panel textarea{width:100%;height:64px;resize:vertical;border:1px solid #444;border-radius:8px;background:#111;color:#eee;padding:8px;font:11px monospace}
#mirror-launcher .mirror-actions{display:flex;gap:7px;margin-top:8px}
#mirror-launcher .mirror-actions button,#mirror-launcher .mirror-actions a{flex:1;border:0;border-radius:8px;padding:8px;text-align:center;text-decoration:none;cursor:pointer}
#mirror-launcher .mirror-save{background:#fff;color:#111}
#mirror-launcher .mirror-play{background:#343434;color:#eee}
#mirror-launcher .mirror-status{min-height:16px;margin-top:6px;color:#9adfce;font-size:11px}
#mirror-launcher .mirror-egress{margin-top:8px;color:#aaa;font-size:11px}
`;

/**
 * Mirror controls widget. Mounted as a normal-flow row inside the sidebar,
 * directly above the account button (data-testid="accounts-profile-button"),
 * so it reads as part of the app chrome rather than a floating overlay.
 * When the sidebar's account button isn't reachable (sidebar collapsed, or
 * this view has no sidebar), the widget is simply hidden -- it must never
 * float over the main content area, since that overlaps and fights with
 * the composer/input for clicks. The widget node itself is kept around
 * (module-level widgetRoot) rather than rebuilt each time, so its state
 * (typed token, open/closed panel) survives hide/show cycles.
 * Since the ChatGPT bundle owns and periodically re-renders these DOM
 * regions (React), a plain one-time insert can get silently wiped on
 * re-render or route change -- so placement is re-asserted on a light
 * interval rather than relying on a single mount call.
 * Also forces the sidebar open once per page load (leaving the user's
 * normal manual collapse/expand alone afterward).
 */
export const injectionJs = `(()=>{
var widgetRoot=null;
function buildWidget(){
  var root=document.createElement('div');
  root.id='mirror-launcher';
  root.innerHTML='<button type="button" class="mirror-row"><span class="mirror-dot"></span><span>Mirror controls</span></button>'
    +'<div class="mirror-panel"><strong>Mirror controls</strong><p>Connect with a sessionToken. The credential stays encrypted on this server and is never inserted into ChatGPT page scripts.</p><label>sessionToken</label><textarea autocomplete="off" spellcheck="false" placeholder="Paste sessionToken"></textarea><div class="mirror-actions"><button class="mirror-save">Save &amp; reload</button><a class="mirror-play" href="/mirror/playground" target="_blank" rel="noopener noreferrer">API tester</a></div><div class="mirror-status"></div><div class="mirror-egress">Egress: checking…</div></div>';
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
  var apiLink=root.querySelector('.mirror-play');
  apiLink.addEventListener('click',function(e){
    e.preventDefault();
    window.open(apiLink.href,'_blank','noopener,noreferrer');
  });
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
})();`;
