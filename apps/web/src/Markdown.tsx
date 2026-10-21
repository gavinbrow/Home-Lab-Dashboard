import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export function SafeMarkdown({text}:{text:string}) {
 return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a:({href,children})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,img:({src,alt})=><span className="blocked-image">[Image: {alt??'unlabeled'}]{src&&<a href={src} target="_blank" rel="noopener noreferrer"> Open image explicitly</a>}</span>}}>{text}</ReactMarkdown></div>;
}
