import '@unalgorithm/ui/styles.css';
import './web.css';
import {
  ACCOUNT_PAGE_PATH,
  ADMIN_PAGE_PATH,
  ADMIN_PRICES_PAGE_PATH,
  ADMIN_REPORTS_PAGE_PATH,
  ADMIN_SOURCES_PAGE_PATH,
  AUTHORIZE_PAGE_PATH,
  OUTLETS_PAGE_PATH,
  SETUP_PAGE_PATH,
  type ServerInfo,
} from '@unalgorithm/protocol';
import { Banner, ToastProvider } from '@unalgorithm/ui';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Account } from './Account.tsx';
import { Admin } from './Admin.tsx';
import { AdminPrices } from './AdminPrices.tsx';
import { AdminReports } from './AdminReports.tsx';
import { AdminSources } from './AdminSources.tsx';
import { Authorize } from './Authorize.tsx';
import { serverInfo } from './api.ts';
import { Page, PageLoading } from './Page.tsx';
import { Setup } from './Setup.tsx';
import { SourceList } from './SourceList.tsx';

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
  if (!info && !failed) return <PageLoading />;
  return (
    <Page info={info} intro="This server provides AI for the unAlgorithm Feed extension.">
      {failed ? (
        <Banner tone="danger" title="Couldn't reach the server. Try again." />
      ) : (
        <div className="web-card web-home">
          <p>To use it, enter this page's address in the extension and sign in from there.</p>
          <p className="web-home-address">{window.location.origin}</p>
          <a className="ua-button ua-button--secondary ua-button--lg ua-button--full" href={ACCOUNT_PAGE_PATH}>
            Your account
          </a>
        </div>
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
      <ToastProvider>
        {pathname === AUTHORIZE_PAGE_PATH ? (
          <Authorize />
        ) : pathname === ACCOUNT_PAGE_PATH ? (
          <Account />
        ) : pathname === SETUP_PAGE_PATH ? (
          <Setup />
        ) : pathname === ADMIN_PAGE_PATH ? (
          <Admin />
        ) : pathname === ADMIN_SOURCES_PAGE_PATH ? (
          <AdminSources />
        ) : pathname === ADMIN_PRICES_PAGE_PATH ? (
          <AdminPrices />
        ) : pathname === ADMIN_REPORTS_PAGE_PATH ? (
          <AdminReports />
        ) : pathname === OUTLETS_PAGE_PATH ? (
          <SourceList />
        ) : (
          <Home />
        )}
      </ToastProvider>
    </StrictMode>,
  );
}
