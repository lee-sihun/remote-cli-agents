import React, { useCallback, useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check } from 'lucide-react';

interface CodeBlockProps {
  language?: string;
  children: string;
}

function isDiff(code: string): boolean {
  const lines = code.split('\n');
  let diffLines = 0;
  for (const line of lines.slice(0, 20)) {
    if (
      line.startsWith('+') ||
      line.startsWith('-') ||
      line.startsWith('@@') ||
      line.startsWith('diff ') ||
      line.startsWith('index ')
    ) {
      diffLines++;
    }
  }
  return diffLines > 2;
}

function DiffRenderer({ code }: { code: string }) {
  const lines = code.split('\n');
  return (
    <pre className="overflow-x-auto p-4 text-sm font-mono leading-relaxed">
      {lines.map((line, i) => {
        let className = '';
        if (line.startsWith('+') && !line.startsWith('+++')) {
          className = 'diff-add';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          className = 'diff-remove';
        } else if (line.startsWith('@@')) {
          className = 'text-(--accent) opacity-70';
        }
        return (
          <div key={i} className={className}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

export default function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const code = String(children).replace(/\n$/, '');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  const effectiveLang = language || (isDiff(code) ? 'diff' : '');
  const showDiff = effectiveLang === 'diff' || (!language && isDiff(code));

  return (
    <div className="relative group rounded-lg overflow-hidden bg-[#1a1a1a] my-2">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#141414] text-xs text-(--text-muted)">
        <span>{effectiveLang || 'text'}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-(--bg-tertiary) transition-colors opacity-0 group-hover:opacity-100"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check size={12} />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {showDiff ? (
        <DiffRenderer code={code} />
      ) : (
        <SyntaxHighlighter
          language={effectiveLang || 'text'}
          style={oneDark}
          customStyle={{
            margin: 0,
            borderRadius: 0,
            background: 'transparent',
            fontSize: '0.875rem',
          }}
          showLineNumbers={code.split('\n').length > 3}
          lineNumberStyle={{ opacity: 0.4, minWidth: '2.5em' }}
        >
          {code}
        </SyntaxHighlighter>
      )}
    </div>
  );
}
