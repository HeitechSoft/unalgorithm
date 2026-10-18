/**
 * Firefox-only extension APIs, which @wxt-dev/browser's Chrome-derived types leave out (ADR 0008). Each is undefined in
 * Chrome and Edge, so the types say so: check `browserKind()` (src/lib/browser-kind.ts) or the value itself first.
 */
import 'wxt/browser';

declare module 'wxt/browser' {
  export namespace Browser {
    /**
     * Firefox's sidebar, its side panel. One per window. `open`, `close` and `toggle` work only inside a user action:
     * a click in an extension page or on the toolbar button, an extension menu item or keyboard shortcut, and never
     * after an `await`. A click relayed from a content script doesn't count.
     */
    export const sidebarAction:
      | {
          open(): Promise<void>;
          close(): Promise<void>;
          toggle(): Promise<void>;
          isOpen(details: { windowId?: number }): Promise<boolean>;
          setPanel(details: { panel: string | null; tabId?: number; windowId?: number }): Promise<void>;
          getPanel(details: { tabId?: number; windowId?: number }): Promise<string>;
        }
      | undefined;

    export namespace runtime {
      /** `runtime.getBrowserInfo()`: "Firefox", or a Firefox-based browser's own name. */
      export interface BrowserInfo {
        name: string;
        vendor: string;
        version: string;
        buildID: string;
      }
      export const getBrowserInfo: (() => Promise<BrowserInfo>) | undefined;
    }

    export namespace permissions {
      /** Firefox's data-collection types (manifest `browser_specific_settings.gecko.data_collection_permissions`). */
      export type DataCollection =
        | 'authenticationInfo'
        | 'bookmarksInfo'
        | 'browsingActivity'
        | 'financialAndPaymentInfo'
        | 'healthInfo'
        | 'locationInfo'
        | 'personalCommunications'
        | 'personallyIdentifyingInfo'
        | 'searchTerms'
        | 'technicalAndInteraction'
        | 'websiteActivity'
        | 'websiteContent';

      export interface Permissions {
        /**
         * Firefox 140+: data-collection consent. `permissions.request()` asks for optional types from a user action;
         * `getAll()` and `contains()` report what was granted. Firefox only: Chrome and Edge refuse an object with an
         * unexpected property, so never pass it there.
         */
        data_collection?: DataCollection[];
      }
    }
  }
}
