import {
  ACCOUNT_PAGE_PATH,
  ADMIN_PAGE_PATH,
  ADMIN_PRICES_PAGE_PATH,
  ADMIN_REPORTS_PAGE_PATH,
  ADMIN_SOURCES_PAGE_PATH,
  type ServerInfo,
} from '@unalgorithm/protocol';
import {
  Button,
  Coins,
  LayoutGrid,
  LoaderCircle,
  type LucideIcon,
  MessageSquareWarning,
  Newspaper,
  Tile,
  type TileTint,
  UserRound,
} from '@unalgorithm/ui';
import type { ReactNode } from 'react';

/** The pages the admin sidebar lists (docs/design/portal.md, *The shell*). */
export type NavKey = 'account' | 'admin' | 'sources' | 'prices' | 'reports';

const NAV: readonly { key: NavKey; label: string; path: string; icon: LucideIcon; tint: TileTint }[] = [
  { key: 'account', label: 'Account', path: ACCOUNT_PAGE_PATH, icon: UserRound, tint: 'blue' },
  { key: 'admin', label: 'Overview', path: ADMIN_PAGE_PATH, icon: LayoutGrid, tint: 'lagoon' },
  { key: 'sources', label: 'Source list', path: ADMIN_SOURCES_PAGE_PATH, icon: Newspaper, tint: 'indigo' },
  { key: 'prices', label: 'Pricing', path: ADMIN_PRICES_PAGE_PATH, icon: Coins, tint: 'green' },
  { key: 'reports', label: 'Problem reports', path: ADMIN_REPORTS_PAGE_PATH, icon: MessageSquareWarning, tint: 'orange' },
];

/** Who is signed in, for the top bar's trailing edge: their address and "Sign out". */
export interface TopBarAccount {
  email: string;
  onSignOut(): void;
  signingOut?: boolean;
}

export interface PageProps {
  info: ServerInfo | null;
  /**
   * `focus` (the default): one task in a centred column under the server's monogram and name, which is the page's
   * heading: signing in, the extension's sign-in, the setup link, an error that stops the page. `app`: the top bar and
   * the page under its own `title`.
   */
  layout?: 'focus' | 'app';
  /** The app layout's large title (`h1`); the focus layout's heading is the server's name. */
  title?: string;
  /** One sentence under the heading: what the page is for. */
  intro?: ReactNode;
  /** The page's primary action, on the trailing edge of its title (app layout). */
  actions?: ReactNode;
  /** A page of tables and dashboards rather than lists (app layout). */
  wide?: boolean;
  /** The signed-in account, shown in the top bar (app layout). */
  account?: TopBarAccount;
  /** Shows the admin sidebar with this page marked (app layout, admins only). */
  nav?: NavKey;
  children?: ReactNode;
}

/**
 * The frame of every page (docs/design/portal.md). The server's own name is its identity (the page belongs to whoever
 * runs the server, so it carries no unAlgorithm logo), with a monogram made from its first letter; a footer links the
 * running release's source (AGPL section 13). Before the discovery document has loaded there is no name and no link.
 */
export function Page({ info, layout = 'focus', title, intro, actions, wide = false, account, nav, children }: PageProps) {
  const footer = info ? (
    <footer className="web-footer">
      {info.name} ·{' '}
      <a href={info.source} target="_blank" rel="noreferrer">
        Source
      </a>
    </footer>
  ) : null;
  if (layout === 'focus') {
    return (
      <div className="web-page web-focus">
        <main className="web-main">
          <header className="web-focus-header">
            <Monogram name={info?.name} size="lg" />
            <h1>{info?.name ?? 'Sign in'}</h1>
            {intro ? <p>{intro}</p> : null}
          </header>
          {children}
        </main>
        {footer}
      </div>
    );
  }
  return (
    <div className={['web-page', 'web-app', nav ? 'web-app--nav' : '', wide ? 'web-page-wide' : ''].join(' ').trim()}>
      <TopBar info={info} account={account} />
      <div className="web-body">
        {nav ? <Sidebar current={nav} /> : null}
        <div className="web-column">
          <main className="web-main web-content">
            <header className="web-page-header">
              <div className="web-page-heading">
                <h1>{title}</h1>
                {intro ? <p>{intro}</p> : null}
              </div>
              {actions ? <div className="web-page-actions">{actions}</div> : null}
            </header>
            {children}
          </main>
          {footer}
        </div>
      </div>
    </div>
  );
}

/** The server's first letter on an accent tile: its mark, since a server's own pages carry no logo. */
export function Monogram({ name, size = 'md' }: { name?: string; size?: 'md' | 'lg' }) {
  const letter = name?.trim().charAt(0).toUpperCase() ?? '';
  return (
    <span className={`web-monogram web-monogram--${size}`} aria-hidden="true">
      {letter}
    </span>
  );
}

function TopBar({ info, account }: { info: ServerInfo | null; account?: TopBarAccount }) {
  return (
    <header className="web-topbar">
      <a className="web-brand" href={account ? ACCOUNT_PAGE_PATH : '/'}>
        <Monogram name={info?.name} />
        <span>{info?.name}</span>
      </a>
      {account ? (
        <div className="web-topbar-account">
          <span className="web-topbar-email">{account.email}</span>
          <Button size="sm" loading={account.signingOut} onClick={account.onSignOut}>
            Sign out
          </Button>
        </div>
      ) : null}
    </header>
  );
}

/** The admin pages, as the extension's Settings sidebar (macOS System Settings); tabs on a narrow screen. */
function Sidebar({ current }: { current: NavKey }) {
  const [own, ...admin] = NAV;
  const item = ({ key, label, path, icon, tint }: (typeof NAV)[number]) => (
    <li key={key}>
      <a className="web-sidebar-item" href={path} aria-current={key === current ? 'page' : undefined}>
        <Tile icon={icon} tint={tint} size="sm" />
        {label}
      </a>
    </li>
  );
  return (
    <nav className="web-sidebar" aria-label="Pages">
      <ul>{own ? item(own) : null}</ul>
      <p className="web-sidebar-heading" id="web-sidebar-admin">
        Admin
      </p>
      <ul aria-labelledby="web-sidebar-admin">{admin.map(item)}</ul>
    </nav>
  );
}

/** A page whose first answers haven't come yet: a spinner after a moment, never a blank page. */
export function PageLoading() {
  return (
    <div className="web-page web-loading" aria-busy="true">
      <LoaderCircle className="ua-spin" aria-hidden="true" />
    </div>
  );
}
