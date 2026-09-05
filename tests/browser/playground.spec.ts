import {test,expect} from "@playwright/test";
test.beforeEach(async({page})=>{
 await page.route("**/v1/models",route=>route.fulfill({json:{data:[]}}));
 await page.route("**/api/conversations?*",route=>route.fulfill({json:{items:[],hasMore:false}}));
});
test("stream error is shown as Error",async({page})=>{
 await page.route("**/v1/chat/completions",route=>route.fulfill({contentType:"text/event-stream",body:'data: {"error":{"message":"Synthetic failure"}}\n\ndata: [DONE]\n\n'}));
 await page.goto("/mirror/playground");await page.getByRole("button",{name:/Run/}).click();
 await expect(page.locator(".run-status")).toHaveText("Error");
 await expect(page.locator(".output")).toContainText("Synthetic failure");
});
test("legacy ID without history is not reused",async({page})=>{
 await page.goto("/mirror/playground");await page.evaluate(()=>localStorage.setItem("mirror-playground-conversation-id","stale-id"));await page.reload();
 await expect(page.getByPlaceholder("auto (filled in after the first response)")).toHaveValue("");
});
test("pagination loads more when remote history remains",async({page})=>{
 let calls=0;
 await page.route("**/api/conversations?*",route=>{calls++;const offset=Number(new URL(route.request().url()).searchParams.get("offset"));return route.fulfill({json:{items:Array.from({length:50},(_,i)=>({id:String(offset+i),title:`Chat ${offset+i}`,updatedAt:"2026-01-01"})),hasMore:offset===0}});});
 await page.goto("/mirror/playground");await expect(page.locator(".conversation-list-item")).toHaveCount(50);
 await page.locator(".conversation-list").evaluate(el=>{el.scrollTop=el.scrollHeight;});
 await expect(page.locator(".conversation-list-item")).toHaveCount(100);expect(calls).toBeGreaterThan(1);
});
test("Stop cancels a pending response",async({page})=>{
 await page.route("**/v1/chat/completions",async route=>{await new Promise(resolve=>setTimeout(resolve,1000));await route.abort().catch(()=>{});});
 await page.goto("/mirror/playground");await page.getByRole("button",{name:/Run/}).click();await page.getByRole("button",{name:"Stop",exact:true}).click();await expect(page.locator(".run-status")).toHaveText("Stopped");
});
