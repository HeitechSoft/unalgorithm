import '@unalgorithm/ui/styles.css';
import './web.css';
import { ACCOUNT_PAGE_PATH, AUTHORIZE_PAGE_PATH, type ServerInfo } from '@unalgorithm/protocol';
import { Banner } from '@unalgorithm/ui';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Account } from './Account.tsx';
import { Authorize } from './Authorize.tsx';
import { serverInfo } from './api.ts';
import { Page } from './Page.tsx';

/** Any other address on the server: what the server is for, and where to start. */
export function Home() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    serverInfo().then(
      (found) => {
        setInfo(found);
        document.title = found.name;
      },
      () => setFailed(true),
    );
  }, []);
  if (!info && !failed) return <div className="web-page" aria-busy="true" />;
  return (
    <Page info={info} intro="This server provides AI for the UnAlgorithm Feed extension.">
      {failed ? (
        <Banner tone="danger" title="Couldn't reach the server. Try again." />
      ) : (
        <>
          <p className="web-status">To use it, enter this page's address in the extension and sign in from there.</p>
          <p className="web-status">
            <a href={ACCOUNT_PAGE_PATH}>Your account</a>
          </p>
        </>
      )}
    </Page>
  );
}

// Only in the built page: a test imports `Home` from here, and its document has no `#root`.
const root = document.getElementById('root');
if (root) {
  const { pathname } = window.location;
  createRoot(root).render(
    <StrictMode>
      {pathname === AUTHORIZE_PAGE_PATH ? <Authorize /> : pathname === ACCOUNT_PAGE_PATH ? <Account /> : <Home />}
    </StrictMode>,
  );
}
