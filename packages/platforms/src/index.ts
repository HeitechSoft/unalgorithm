import type { PlatformId } from '@unalgorithm/protocol';
import { facebookAdapter } from './facebook/adapter.ts';
import { linkedinAdapter } from './linkedin/adapter.ts';
import type { PlatformAdapter } from './types.ts';

export { facebookAdapter, facebookLocaleSelfTest } from './facebook/adapter.ts';
export { extractFacebookPost, isSponsored as isFacebookSponsored } from './facebook/extract.ts';
export { FACEBOOK_EN, type FacebookMarkers } from './facebook/markers/en.ts';
export { linkedinAdapter, linkedinLocaleSelfTest } from './linkedin/adapter.ts';
export {
  classifyHeader,
  extractPost as extractLinkedInPost,
  findPostRoots as findLinkedInPosts,
  moduleInfo as linkedinModuleInfo,
  parseAge,
} from './linkedin/extract.ts';
export { LINKEDIN_EN, type LinkedInMarkers } from './linkedin/markers/en.ts';
export * from './shared/dom.ts';
export * from './shared/keep-loading.ts';
export * from './types.ts';

export function adapterFor(platform: PlatformId): PlatformAdapter | undefined {
  return (platform === 'linkedin' ? linkedinAdapter : facebookAdapter) as PlatformAdapter;
}
