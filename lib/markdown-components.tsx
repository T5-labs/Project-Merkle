import type { Components } from 'react-markdown';
import { CodeBlock } from '@/components/markdown/code-block';

/**
 * Shared react-markdown `components` map used by doc-panel and document-tab.
 *
 * Applies visual styling for every GFM-relevant element so rendered markdown
 * has proper hierarchy, breathing room, and themed surfaces in both light and
 * dark mode. All classes resolve via existing CSS vars — no hardcoded colours.
 *
 * Inline-code detection (react-markdown v10): block code always receives a
 * `className` of `language-*`; inline code receives none. We use that to
 * branch between the two treatments.
 */
export const markdownComponents: Components = {
  h1: ({ children, ...props }) => (
    <h1
      className="text-3xl font-bold tracking-tight mt-8 mb-4 first:mt-0 border-b border-border pb-2"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2
      className="text-2xl font-semibold tracking-tight mt-6 mb-3 first:mt-0 border-b border-border pb-1"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="text-xl font-semibold mt-5 mb-2 first:mt-0" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="text-lg font-semibold mt-4 mb-2" {...props}>
      {children}
    </h4>
  ),
  h5: ({ children, ...props }) => (
    <h5 className="text-base font-semibold mt-3 mb-1" {...props}>
      {children}
    </h5>
  ),
  h6: ({ children, ...props }) => (
    <h6
      className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mt-3 mb-1"
      {...props}
    >
      {children}
    </h6>
  ),
  p: ({ children, ...props }) => (
    <p className="leading-7 mb-4 last:mb-0" {...props}>
      {children}
    </p>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="border-l-4 border-border pl-4 italic text-muted-foreground my-4"
      {...props}
    >
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }) => {
    // Block code always has className="language-*"; inline code has none.
    const isBlock = Boolean(className);
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="bg-muted text-foreground px-1.5 py-0.5 rounded text-[0.875em] font-mono"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: (props) => <CodeBlock {...props} />,
  ul: ({ children, ...props }) => (
    <ul className="list-disc list-outside ml-6 mb-4 space-y-1" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="list-decimal list-outside ml-6 mb-4 space-y-1" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-7" {...props}>
      {children}
    </li>
  ),
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto my-4">
      <table className="w-full border-collapse text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-muted/50 border-b border-border" {...props}>
      {children}
    </thead>
  ),
  tbody: ({ children, ...props }) => (
    <tbody {...props}>{children}</tbody>
  ),
  tr: ({ children, ...props }) => (
    <tr className="border-b border-border last:border-0" {...props}>
      {children}
    </tr>
  ),
  th: ({ children, ...props }) => (
    <th className="text-left font-semibold px-3 py-2" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="px-3 py-2" {...props}>
      {children}
    </td>
  ),
  hr: (props) => <hr className="my-8 border-t border-border" {...props} />,
  a: ({ children, ...props }) => (
    <a
      className="text-primary underline underline-offset-4 hover:no-underline"
      {...props}
    >
      {children}
    </a>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  del: ({ children, ...props }) => (
    <del className="line-through text-muted-foreground" {...props}>
      {children}
    </del>
  ),
  input: ({ ...props }) => (
    <input className="accent-primary mr-2 align-middle" {...props} />
  ),
  img: ({ ...props }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="rounded-md border border-border my-4 max-w-full h-auto"
      alt={props.alt ?? ''}
      {...props}
    />
  ),
};
