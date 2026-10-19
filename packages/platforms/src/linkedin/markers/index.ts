import { LINKEDIN_EN, type LinkedInMarkers } from './en.ts';

/** LinkedIn's UI languages we read, by primary language subtag. */
export const LINKEDIN_MARKERS: Readonly<Record<string, LinkedInMarkers>> = Object.freeze({ en: LINKEDIN_EN });
