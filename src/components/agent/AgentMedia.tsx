import { useAgentText } from './useAgentText';
import { useAuthenticatedMediaUrl } from '@/hooks/useAuthenticatedMediaUrl';
import { AuthenticatedImage } from '@/components/media/AuthenticatedImage';
export interface AgentMediaOutput { filename:string; subfolder:string; type:string; kind?:'image'|'video'|'audio' }
/** The `#t=0.1` fragment makes browsers decode and show that frame before playback; with metadata-only preload they would otherwise paint nothing behind the play button. */
export function AgentMedia({baseUrl,output,index}:{baseUrl:string;output:AgentMediaOutput;index:number}) {
  const at = useAgentText();
  const source=`${baseUrl}/view?${new URLSearchParams({filename:output.filename,subfolder:output.subfolder,type:output.type})}`;
  const kind=output.kind ?? (/\.(mp4|webm|mkv|mov)$/i.test(output.filename)?'video':/\.(mp3|wav|flac|ogg|m4a)$/i.test(output.filename)?'audio':'image');
  const media=useAuthenticatedMediaUrl(kind==='image'?null:source);
  if(kind==='image') return <AuthenticatedImage source={source} alt={at('生成结果 {{index}}', { index: index + 1 })} className="w-full rounded-lg object-contain max-h-[500px]" />;
  return <figure className="min-w-0 space-y-2" data-agent-media={kind}>
    {media.loading && <p className="text-sm text-slate-400">{at(kind==='video'?'正在加载视频…':'正在加载音频…')}</p>}
    {media.error && <p role="alert" className="text-sm text-amber-300">{at('媒体加载失败')}：{media.error.message}</p>}
    {media.url && (kind==='video'?<video controls playsInline preload="metadata" src={`${media.url}#t=0.1`} className="w-full rounded-lg max-h-[500px] bg-black" aria-label={at('生成视频 {{index}}', { index: index + 1 })} />:<audio controls preload="metadata" src={media.url} className="w-full" aria-label={at('生成音频 {{index}}', { index: index + 1 })} />)}
    <figcaption className="text-xs text-slate-400 break-all">{output.filename}</figcaption>
  </figure>;
}
