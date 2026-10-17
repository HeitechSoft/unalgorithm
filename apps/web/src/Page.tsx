import type { ServerInfo } from '@unalgorithm/protocol';
import type { ReactNode } from 'react';

/**
 * The frame of every page: the server's own name as the heading (the page belongs to whoever runs the server, so it
 * carries no unAlgorithm logo), a line saying what it is for, and a footer linking the running release's source
 * (AGPL section 13). Before the discovery document has loaded there is no name and no link yet. A page may put its own
 * `heading` in place of the name (the admin page's "Admin · {name}"). `wide` is for a page of lists and tables rather
 * than a form: the signed-in admin page.
 */
export function Page({
  info,
  intro,
  heading,
  wide = false,
  children,
}: {
  info: ServerInfo | null;
  intro: string;
  heading?: string;
  wide?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={wide ? 'web-page web-page-wide' : 'web-page'}>
      <main className="web-main">
        <header className="web-header">
          <h1>{heading ?? info?.name ?? 'Sign in'}</h1>
          <p>{intro}</p>
        </header>
        {children}
      </main>
      {info ? (
        <footer className="web-footer">
          {info.name} ·{' '}
          <a href={info.source} target="_blank" rel="noreferrer">
            Source
          </a>
        </footer>
      ) : null}
    </div>
  );
}
