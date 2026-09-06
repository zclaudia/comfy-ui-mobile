export interface AgentOutput { filename:string; subfolder:string; type:string; kind:'image'|'video'|'audio' }
/** ComfyUI output nodes use images, videos, audio or gifs depending on node/version. */
export function collectMediaOutputs(outputs: unknown): AgentOutput[] {
  const result:AgentOutput[]=[];const seen=new Set<string>();
  function visit(value:unknown, depth=0) {
    if(depth>6 || result.length>=16 || !value || typeof value!=='object') return;
    if(Array.isArray(value)) {for(const child of value) visit(child,depth+1);return;}
    const item=value as Record<string,unknown>;
    if(typeof item.filename==='string') {
      const filename=item.filename; const ext=filename.split('.').at(-1)?.toLowerCase();
      const kind=['mp4','webm','mkv','mov'].includes(ext??'')?'video':['wav','mp3','flac','ogg','m4a'].includes(ext??'')?'audio':['png','jpg','jpeg','webp','gif','avif','svg'].includes(ext??'')?'image':null;
      const type=typeof item.type==='string'?item.type:'output';
      if(!kind || !['output','temp','input'].includes(type)) return;
      const output={filename,subfolder:typeof item.subfolder==='string'?item.subfolder:'',type,kind} as AgentOutput;
      const key=JSON.stringify([type,output.subfolder,filename]);if(!seen.has(key)){seen.add(key);result.push(output);}return;
    }
    for(const child of Object.values(item)) visit(child,depth+1);
  }
  visit(outputs);return result;
}
