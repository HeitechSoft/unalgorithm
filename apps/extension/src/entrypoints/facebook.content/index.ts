import { facebookAdapter } from '@unalgorithm/platforms';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { bootContentScript } from '../../content/bootstrap.ts';

export default defineContentScript({
  matches: ['https://www.facebook.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    return bootContentScript(facebookAdapter, ctx);
  },
});
