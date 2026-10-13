import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {sourceBuildId} from './src/workspace/build';
import {version} from './package.json';
export default defineConfig(async()=>{
 const sourceHash=await sourceBuildId();
 return {worker:{format:'es' as const},define:{__RTLARCH_BUILD_ID__:JSON.stringify(sourceHash)},plugins:[react(),{name:'rtlarch-build-identity',generateBundle(){this.emitFile({type:'asset',fileName:'build-info.json',source:JSON.stringify({toolVersion:version,sourceHash},null,2)+'\n'});}}],server:{host:'127.0.0.1',port:Number(process.env.RTLARCH_WEB_PORT||5173),strictPort:true,proxy:{'/api':`http://127.0.0.1:${process.env.RTLARCH_API_PORT||4317}`}}};
});
