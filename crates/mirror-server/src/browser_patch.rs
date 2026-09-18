//! Browser runtime shim injected into served ChatGPT HTML documents.
//! Port of `apps/server/src/browser-patch.ts`.

pub const EARLY_PATCH: &str = r#"<script>(function(){
function rel(u){
  try{
    if(typeof u!=="string") return u;
    var x=new URL(u,location.href);
    if(x.hostname==="chatgpt.com"||x.hostname.endsWith(".chatgpt.com")||x.hostname==="chat.openai.com"){
      x.protocol=location.protocol;
      x.host=location.host;
      return x.href;
    }
  }catch(e){}
  return u;
}
function wrapFetch(delegate){
  var wrapped=function(input,init){
    try{
      if(typeof input==="string")input=rel(input);
      else if(input instanceof URL)input=rel(input.href);
      else if(input&&typeof input==="object"&&typeof input.url==="string"){
        var rewritten=rel(input.url);
        if(rewritten!==input.url){
          var base={
            method:input.method,headers:input.headers,mode:input.mode,
            credentials:input.credentials,cache:input.cache,redirect:input.redirect,
            referrer:input.referrer,referrerPolicy:input.referrerPolicy,
            integrity:input.integrity,keepalive:input.keepalive,signal:input.signal
          };
          if(input.method!=="GET"&&input.method!=="HEAD"){
            return input.clone().arrayBuffer().then(function(buf){
              base.body=buf;
              if(init)for(var key in init)base[key]=init[key];
              return delegate.call(this,rewritten,base);
            }.bind(this));
          }
          if(init)for(var key in init)base[key]=init[key];
          input=rewritten;init=base;
        }
      }
    }catch(e){}
    return delegate.call(this,input,init);
  };
  try{Object.defineProperty(wrapped,"__mirrorProxyPatch",{value:true});}catch(e){}
  return wrapped;
}
var currentFetch=window.fetch;
if(currentFetch){
  var patchedFetch=wrapFetch(currentFetch);
  try{
    Object.defineProperty(window,"fetch",{
      configurable:false,enumerable:true,
      get:function(){return patchedFetch;},
      set:function(next){
        if(typeof next==="function"&&!next.__mirrorProxyPatch){
          currentFetch=next;
          patchedFetch=wrapFetch(next);
        }
      }
    });
  }catch(e){window.fetch=patchedFetch;}
}
var open=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(method,url){
  var args=Array.prototype.slice.call(arguments);
  try{if(typeof url==="string")args[1]=rel(url);}catch(e){}
  try{if(typeof url==="string"&&url.indexOf("prepare")!==-1){window.__mirrorDebugXhr=window.__mirrorDebugXhr||[];window.__mirrorDebugXhr.push({method:method,url:url});}}catch(e){}
  return open.apply(this,args);
};
var OrigWorker=window.Worker;
if(OrigWorker){
  window.Worker=function(url,opts){
    try{window.__mirrorWorkers=window.__mirrorWorkers||[];window.__mirrorWorkers.push(String(url));}catch(e){}
    try{url=rel(String(url));}catch(e){}
    return opts!==undefined?new OrigWorker(url,opts):new OrigWorker(url);
  };
  window.Worker.prototype=OrigWorker.prototype;
}
var sb=navigator.sendBeacon;
if(sb)navigator.sendBeacon=function(url,data){try{if(typeof url==="string")url=rel(url);}catch(e){}return sb.call(navigator,url,data);};
var WS=window.WebSocket;
if(WS){
  var W2=function(url,protocols){
    try{
      if(typeof url==="string")url=rel(url).replace(/^https:/,"wss:").replace(/^http:/,"ws:");
    }catch(e){}
    return protocols!==undefined?new WS(url,protocols):new WS(url);
  };
  W2.prototype=WS.prototype;
  window.WebSocket=W2;
}
try{
  if(document.currentScript&&document.currentScript.parentNode){
    document.currentScript.parentNode.removeChild(document.currentScript);
  }
}catch(e){}
function mirrorAddInjectAssets(){
  try{
    var l=document.createElement("link");
    l.rel="stylesheet";l.href="/mirror/inject.css";
    var s=document.createElement("script");
    s.defer=true;s.src="/mirror/inject.js";
    var head=document.head||document.documentElement;
    head.appendChild(l);
    head.appendChild(s);
  }catch(e){}
}
if(document.readyState==="complete"){
  mirrorAddInjectAssets();
}else{
  window.addEventListener("load",mirrorAddInjectAssets,{once:true});
}

})();</script>"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_patch_is_well_formed_script() {
        assert!(EARLY_PATCH.starts_with("<script>"));
        assert!(EARLY_PATCH.ends_with("</script>"));
        assert!(EARLY_PATCH.contains("wrapFetch"));
        assert!(EARLY_PATCH.contains("/mirror/inject.css"));
        assert!(EARLY_PATCH.contains("/mirror/inject.js"));
    }
}
