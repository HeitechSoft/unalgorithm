import type { ServerInfo } from '@unalgorithm/protocol';
import type { ReactNode } from 'react';

/**
 * The frame of every page: the server's own name as the heading (the page belongs to whoever runs the server, so it
 * carries no UnAlgorithm logo), a line saying what it is for, and a footer linking the running release's source
 * (AGPL section 13). Before the discovery document has loaded there is no name and no link yet.
 */
export function Page({ info, intro, children }: { info: ServerInfo | null; intro: string; children?: ReactNode }) {
  return (
    <div className="web-page">
      <main className="web-main">
        <header className="web-header">
          <h1>{info?.name ?? 'Sign in'}</h1>
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
