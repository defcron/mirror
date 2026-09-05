import {defineConfig} from "@playwright/test";
export default defineConfig({testDir:"./tests/browser", use:{baseURL:"http://127.0.0.1:4173"}, webServer:{command:"npm exec --workspace=apps/web vite -- --host 127.0.0.1 --port 4173",url:"http://127.0.0.1:4173/mirror/playground",reuseExistingServer:false}, projects:[{name:"chromium",use:{browserName:"chromium"}}]});
