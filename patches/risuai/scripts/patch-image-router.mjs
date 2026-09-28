import fs from 'node:fs'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('usage: node patch-image-router.mjs <input.js> <output.js>')
}

let source = fs.readFileSync(inputPath, 'utf8')

function replaceOnce(name, from, to) {
  const count = source.split(from).length - 1
  if (count !== 1) {
    throw new Error(`${name}: expected exactly one match, got ${count}`)
  }
  source = source.replace(from, to)
}

replaceOnce(
  'image routing defaults',
  'e.openaiCompatImage??={url:``,key:``,model:``,size:`1024x1024`,quality:`auto`},e.wavespeedImage??=',
  'e.openaiCompatImage??={url:``,key:``,model:``,size:`1024x1024`,quality:`auto`},e.imageRouting??={enabled:!1,auto:!0,defaultClass:`sfw`,forceClass:``,nsfwKeywords:[`nsfw`,`nude`,`naked`,`explicit`,`\\u88f8`,`\\u8272\\u60c5`],nsfw:{provider:`comfyui`,transport:`local`,url:``,comfyConfig:{}},sfw:{provider:`openai-compat`,transport:`network`,url:``,openaiCompatImage:{}}},e.wavespeedImage??='
)

const localGuard = 'if(YV.includes(r)&&!Pa&&!Fa)return{ok:!1,headers:{},status:400,data:`You are trying local request on web version.'
const guardStart = source.indexOf(localGuard)
if (guardStart < 0) throw new Error('browser local guard: not found')
const guardEnd = source.indexOf('};', guardStart) + 2
if (guardEnd <= 1) throw new Error('browser local guard: terminator not found')
source = source.slice(0, guardStart) + source.slice(guardStart, guardEnd).replace('&&!Fa)', '&&!Fa&&!t.allowBrowserLocal)') + source.slice(guardEnd)

const router = 'async function oA(e,t,n,r,skipImageRouting=!1,routeTransport){let i=$();if(!skipImageRouting&&(i.imageRouting?.enabled||i.imageRouting?.auto&&(i.comfyUiUrl&&i.openaiCompatImage?.url))){let a=i.imageRouting,o=String(e||``)+` `+String(n||``),s=a.forceClass===`nsfw`||a.forceClass===`sfw`?a.forceClass:``,c=Array.isArray(a.nsfwKeywords)?a.nsfwKeywords:[],l=s||((c.some(e=>e&&o.toLowerCase().includes(String(e).toLowerCase())))?`nsfw`:(a.defaultClass===`nsfw`?`nsfw`:`sfw`)),u=a[l]||{},d=u.provider||``;if(d===`comfy`||d===`comfyui`){let prevUrl=i.comfyUiUrl,prevConfig=i.comfyConfig,prevProvider=i.sdProvider;i.comfyUiUrl=u.url||a.comfyUrl||prevUrl,i.comfyConfig={...prevConfig,...(u.comfyConfig||{})},i.sdProvider=`comfyui`;try{return await oA(e,t,n,r,!0,u.transport===`local`?`local`:`network`)}finally{i.comfyUiUrl=prevUrl,i.comfyConfig=prevConfig,i.sdProvider=prevProvider}}if(d===`openai-compat`){let prevImage=i.openaiCompatImage,prevProvider=i.sdProvider;i.openaiCompatImage={...prevImage,...(u.openaiCompatImage||{})},u.url&&(i.openaiCompatImage.url=u.url),i.sdProvider=`openai-compat`;try{return await oA(e,t,n,r,!0,u.transport===`local`?`local`:`network`)}finally{i.openaiCompatImage=prevImage,i.sdProvider=prevProvider}}}'
replaceOnce('image router entry', 'async function oA(e,t,n,r){let i=$();', router)

replaceOnce(
  'comfy prompt transport',
  'p=async(e,t={})=>{let n=await nH(e,t);',
  'p=async(e,t={})=>{let n=await nH(e,{...t,plainFetchForce:routeTransport===`local`,allowBrowserLocal:routeTransport===`local`});'
)

replaceOnce(
  'comfy history response',
  '(await(await EH(f(`/history`),{headers:{"Content-Type":`application/json`},method:`GET`})).json())[m]',
  '(await globalFetch(f(`/history`),{headers:{"Content-Type":`application/json`},method:`GET`,plainFetchForce:routeTransport===`local`,allowBrowserLocal:routeTransport===`local`})).data[m]'
)
replaceOnce(
  'comfy view transport',
  'y=await EH(f(`/view`,{filename:v.filename,subfolder:v.subfolder,type:v.type}),{headers:{"Content-Type":`application/json`},method:`GET`}),b=Buffer.from(await y.arrayBuffer()).toString(`base64`)',
  'y=await globalFetch(f(`/view`,{filename:v.filename,subfolder:v.subfolder,type:v.type}),{headers:{"Content-Type":`application/json`},method:`GET`,plainFetchForce:routeTransport===`local`,allowBrowserLocal:routeTransport===`local`,rawResponse:!0}),b=Buffer.from(y.data).toString(`base64`)'
)

fs.writeFileSync(outputPath, source)
console.log(`patched ${outputPath} (${source.length} bytes)`)
