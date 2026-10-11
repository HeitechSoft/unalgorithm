import { linkedinAdapter } from '@unalgorithm/platforms';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { bootContentScript } from '../../content/bootstrap.ts';

export default defineContentScript({
  matches: ['https://www.linkedin.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    return bootContentScript(linkedinAdapter, ctx);
  },
});
