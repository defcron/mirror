import {test,expect} from "@playwright/test";
test.describe("browser / playground", () => {
test.beforeEach(async({page})=>{
 await page.route("**/v1/models",route=>route.fulfill({json:{data:[]}}));
 await page.route("**/api/conversations?*",route=>route.fulfill({json:{items:[],hasMore:false}}));
});
test("stream error is shown as Error",async({page})=>{
 await page.route("**/v1/chat/completions",route=>route.fulfill({contentType:"text/event-stream",body:'data: {"error":{"message":"Synthetic failure"}}\n\ndata: [DONE]\n\n'}));
 await page.goto("/mirror/playground");await page.getByRole("button",{name:/^Run\b/}).click();
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
 await page.goto("/mirror/playground");await page.getByRole("button",{name:/^Run\b/}).click();await page.getByRole("button",{name:"Stop",exact:true}).click();await expect(page.locator(".run-status")).toHaveText("Stopped");
});
test("Responses mode runs, retains history and switches back to Chat", async ({page}) => {
 let request: any;
 await page.route("**/v1/responses", route => {
  request = route.request().postDataJSON();
  const response = {status:"completed",metadata:{conversation_id:"responses-conversation"},output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Hello from Responses"}]}]};
  return route.fulfill({contentType:"text/event-stream",body:`event: response.output_text.delta\ndata: ${JSON.stringify({type:"response.output_text.delta",delta:"Hello from Responses"})}\n\nevent: response.completed\ndata: ${JSON.stringify({type:"response.completed",response})}\n\n`});
 });
 await page.goto("/mirror/playground");
 await page.getByRole("button",{name:"◇ Responses"}).click();
 await expect(page.getByRole("heading",{name:"Responses",exact:true})).toBeVisible();
 await expect(page.getByLabel("Path",{exact:true})).toHaveValue("/v1/responses");
 await page.getByRole("button",{name:/^Run\b/}).click();
 await expect(page.locator(".run-status")).toHaveText("Completed");
 expect(request.input.at(-1).role).toBe("user"); expect(request.messages).toBeUndefined();
 await expect(page.getByPlaceholder("auto (filled in after the first response)")).toHaveValue("responses-conversation");
 await expect(page.locator(".output")).toContainText("Hello from Responses");
 await page.getByRole("button",{name:"☷ Chat"}).click();
 await expect(page.getByLabel("Path",{exact:true})).toHaveValue("/v1/chat/completions");
 await expect(page.getByPlaceholder("auto (filled in after the first response)")).toHaveValue("responses-conversation");
});
});
