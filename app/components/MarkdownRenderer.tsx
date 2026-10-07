'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { Globe, ExternalLink, BookmarkPlus, Check } from 'lucide-react';
import { PERFORMATIVE_SOURCE_FLUFF_REGEX } from '@/lib/anti-fluff';
import 'katex/dist/katex.min.css';

interface MarkdownRendererProps {
  content: string;
  onAddMaterial?: (item: { title: string; url: string }) => void;
  savedUrls?: string[];
}

export function MarkdownRenderer({ content, onAddMaterial, savedUrls = [] }: MarkdownRendererProps) {
  // Pre-process content:
  let cleanContent = (typeof content === 'string' ? content : '')
    // 1. Unescape literal \n into real newlines
    .replace(/\\n/g, '\n')
    // 2. Fix broken LaTeX escapes like '$\ ' or '\$' that create '$\' artifacts
    .replace(/\\\$/g, '$')
    // 3. Fix dangling '$\' or '$ \'
    .replace(/\$\s*\\(?!\w)/g, '$')
    // 4. Ensure space after closing bold/code if needed
    .replace(/\*\*([^*]+)\*\*/g, '**$1**')
    // 5. Convert backtick-wrapped URLs into markdown links so they are rendered as interactive links
    .replace(/`\s*(https?:\/\/[^\s`]+)\s*`/g, '[$1]($1)')
    // 6. Anti-Fluff: Strip performative source/external filler & meta-announcements
    .replace(PERFORMATIVE_SOURCE_FLUFF_REGEX, '\n\n')
    // 7. Clean stray empty markdown artifacts (stray double asterisks, orphan blockquote markers)
    .replace(/(?:\r?\n)\s*\*{2,}\s*(?:\r?\n)/g, '\n')
    .replace(/^\s*\*{2,}\s*$/gm, '')
    .replace(/(?:^|\n\n)\s*>\s*/g, '\n\n')
    // 8. Transform citation tags (both verbose like '[HỌC LIỆU ĐÃ LƯU 2]', '[trích đoạn 5]' and concise like ' [1]', ' [2, 3]') into interactive Perplexity-style citation pill badges in a single pass
    .replace(/(?:\[(?:(?:học\s*liệu|tài\s*liệu)(?:\s*đã\s*lưu)?|trích\s*đoạn|đoạn\s*trích|trích|nguồn|giáo\s*trình|bài\s*giảng|cite:?)\s*\[?(\d+(?:\s*,\s*\d+)*)\]?\]|(?<=^|[\s,.:;!?)])\[(\d+(?:\s*,\s*\d+)*)\](?!\())/gi, (_match, verboseNums, conciseNums) => {
      const nums = verboseNums || conciseNums;
      if (!nums) return _match;
      const cleanNums = nums.replace(/\s+/g, '');
      return ` <span class="inline-citation-pill" title="Căn cứ tài liệu / học liệu tham khảo (${cleanNums})">[${cleanNums}]</span>`;
    })
    // 9. Deduplicate identical citation badges repeated in immediate succession
    .replace(/(<span class="inline-citation-pill"[^>]*>\[\d+\]<\/span>)(?:\s*(?:<br\/?>|\n|\.)?\s*\1)+/g, '$1')
    .trim();

  if (cleanContent.length > 0 && !cleanContent.startsWith('>') && !cleanContent.startsWith('#') && !cleanContent.startsWith('`')) {
    cleanContent = cleanContent.charAt(0).toUpperCase() + cleanContent.slice(1);
  }

  // Convert raw backtick code blocks inside table rows into inline formatted text so they don't break markdown tables
  cleanContent = cleanContent.split('\n').map(line => {
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      return line.replace(/```(?:text|cpp|java|python|c|js)?([\s\S]*?)```/g, (_match, code) => {
        return code.trim().replace(/\n/g, '<br/>');
      });
    }
    return line;
  }).join('\n');

  const renderExternalLinkPill = (url: string, label: React.ReactNode) => {
    const cleanNormUrl = url.trim();

    return (
      <a
        href={cleanNormUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="markdown-external-link"
        title={`Mở liên kết ngoài: ${cleanNormUrl}`}
        onClick={e => e.stopPropagation()}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          flexDirection: 'row',
          gap: '5px',
          color: '#38bdf8',
          background: 'rgba(14, 165, 233, 0.18)',
          border: '1px solid rgba(56, 189, 248, 0.45)',
          padding: '2px 9px',
          borderRadius: '6px',
          fontSize: '12.5px',
          fontWeight: 600,
          textDecoration: 'underline',
          textUnderlineOffset: '3px',
          whiteSpace: 'nowrap',
          lineHeight: 1.4,
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.25)',
          margin: '2px 4px',
          verticalAlign: 'middle',
        }}
      >
        <Globe size={13} style={{ color: '#38bdf8', flexShrink: 0, display: 'inline-block' }} />
        <span className="external-link-text" style={{ color: '#38bdf8', fontWeight: 600 }}>
          {label}
        </span>
        <ExternalLink size={11} style={{ color: '#38bdf8', opacity: 0.85, flexShrink: 0, display: 'inline-block' }} />
      </a>
    );
  };

  return (
    <div className="prose-message">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeRaw, rehypeKatex]}
        components={{
          table: ({ children }) => (
            <div className="table-container">
              <table className="markdown-table">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="markdown-thead">{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="markdown-tr">{children}</tr>,
          th: ({ children }) => <th className="markdown-th">{children}</th>,
          td: ({ children }) => <td className="markdown-td">{children}</td>,
          a: ({ href, children, ...props }) => {
            const rawUrl = href || '';
            const isExternal = rawUrl.startsWith('http://') || rawUrl.startsWith('https://');
            if (!isExternal) {
              return <a href={rawUrl} {...props}>{children}</a>;
            }

            return renderExternalLinkPill(rawUrl, children);
          },
          code: ({ className, children, ...props }) => {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !className && typeof children === 'string' && !children.includes('\n');
            if (isInline) {
              const text = String(children).trim();
              if (text.startsWith('http://') || text.startsWith('https://')) {
                return renderExternalLinkPill(text, text);
              }
              return <code className="markdown-inline-code" {...props}>{children}</code>;
            }
            return (
              <div className="code-block-wrapper">
                {match && <span className="code-lang-tag">{match[1]}</span>}
                <pre className="markdown-pre">
                  <code className="markdown-code" {...props}>
                    {children}
                  </code>
                </pre>
              </div>
            );
          },
          h1: ({ children }) => <h3 className="markdown-h1">{children}</h3>,
          h2: ({ children }) => <h4 className="markdown-h2">{children}</h4>,
          h3: ({ children }) => <h5 className="markdown-h3">{children}</h5>,
          ul: ({ children }) => <ul className="markdown-ul">{children}</ul>,
          ol: ({ children }) => <ol className="markdown-ol">{children}</ol>,
          li: ({ children }) => <li className="markdown-li">{children}</li>,
          p: ({ children }) => <p className="markdown-p">{children}</p>,
          blockquote: ({ children }) => <blockquote className="markdown-blockquote">{children}</blockquote>,
          strong: ({ children }) => <strong className="markdown-strong">{children}</strong>,
          br: () => <br />,
        }}
      >
        {cleanContent}
      </ReactMarkdown>
    </div>
  );
}
