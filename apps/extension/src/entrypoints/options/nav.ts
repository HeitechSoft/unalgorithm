import {
  BriefcaseBusiness,
  Cpu,
  Heart,
  Info,
  type LucideIcon,
  Palette,
  Shield,
  type TileTint,
  UsersRound,
} from '@unalgorithm/ui';

export type PaneId = 'linkedin' | 'facebook' | 'display' | 'interests' | 'ai' | 'privacy' | 'about';

export const NAV: { id: PaneId; label: string; group: string; icon: LucideIcon; tint: TileTint; keywords: string[] }[] = [
  {
    id: 'linkedin',
    label: 'LinkedIn',
    group: 'Feeds',
    icon: BriefcaseBusiness,
    tint: 'blue',
    keywords: ['promoted', 'suggested', 'follow', 'groups', 'strength'],
  },
  {
    id: 'facebook',
    label: 'Facebook',
    group: 'Feeds',
    icon: UsersRound,
    tint: 'indigo',
    keywords: ['sponsored', 'reels', 'friends', 'groups', 'strength'],
  },
  {
    id: 'display',
    label: 'Display',
    group: '',
    icon: Palette,
    tint: 'pink',
    keywords: ['collapse', 'hide', 'dim', 'badge', 'tips', 'for you'],
  },
  {
    id: 'interests',
    label: 'Interests',
    group: '',
    icon: Heart,
    tint: 'orange',
    keywords: ['topics', 'keywords', 'mute', 'less', 'more', 'feedback'],
  },
  {
    id: 'ai',
    label: 'AI',
    group: '',
    icon: Cpu,
    tint: 'violet',
    keywords: ['api key', 'anthropic', 'openai', 'ollama', 'model', 'on-device', 'limit'],
  },
  {
    id: 'privacy',
    label: 'Privacy & Data',
    group: '',
    icon: Shield,
    tint: 'green',
    keywords: ['export', 'import', 'erase', 'permissions', 'data'],
  },
  { id: 'about', label: 'About', group: '', icon: Info, tint: 'gray', keywords: ['version', 'license', 'help', 'source'] },
];
