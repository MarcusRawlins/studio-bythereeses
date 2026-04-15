export type Platform = 'TikTok' | 'Instagram Reels' | 'Instagram Feed' | 'YouTube Shorts'

export type PostStatus = 'Idea' | 'Scripting' | 'Editing' | 'Scheduled' | 'Published'

export type ContentPillar = 'Wedding Photography' | 'Behind the Scenes' | 'Education' | 'Brand Story'

export type SocialPost = {
  id: string
  title: string
  platform: Platform
  status: PostStatus
  pillar: ContentPillar
  publishDate: string
  hook: string
  owner: string
  cta: string
  notes: string
  repurposeTo: Platform[]
  metrics?: {
    views?: number
    likes?: number
    saves?: number
    shares?: number
  }
}

export const posts: SocialPost[] = [
  {
    id: 'tt-001',
    title: '3 wedding timeline mistakes couples make',
    platform: 'TikTok',
    status: 'Scheduled',
    pillar: 'Education',
    publishDate: '2026-04-18',
    hook: 'If your wedding day feels rushed, this is usually why.',
    owner: 'Tyler',
    cta: 'Comment TIMELINE for the checklist.',
    notes: 'Turn into carousel and short email tip.',
    repurposeTo: ['Instagram Reels', 'YouTube Shorts'],
  },
  {
    id: 'ig-014',
    title: 'What the photographer sees during first look',
    platform: 'Instagram Reels',
    status: 'Editing',
    pillar: 'Behind the Scenes',
    publishDate: '2026-04-20',
    hook: 'The emotional beat most people miss in the first look.',
    owner: 'Tyler',
    cta: 'Save this for your wedding planning board.',
    notes: 'Need b-roll from the Henderson wedding.',
    repurposeTo: ['TikTok'],
  },
  {
    id: 'igf-002',
    title: '5 image set: spring wedding color story',
    platform: 'Instagram Feed',
    status: 'Idea',
    pillar: 'Brand Story',
    publishDate: '2026-04-22',
    hook: 'A color palette that felt expensive without being trendy.',
    owner: 'Tyler',
    cta: 'Share this with your planner.',
    notes: 'Could anchor a longer blog post.',
    repurposeTo: ['Instagram Reels'],
  },
  {
    id: 'ys-003',
    title: 'Why documentary wedding coverage wins',
    platform: 'YouTube Shorts',
    status: 'Published',
    pillar: 'Wedding Photography',
    publishDate: '2026-04-12',
    hook: 'The best wedding photos are usually the ones nobody staged.',
    owner: 'Tyler',
    cta: 'Follow for more wedding strategy.',
    notes: 'High-performing opener. Recut for TikTok.',
    repurposeTo: ['TikTok', 'Instagram Reels'],
    metrics: {
      views: 4820,
      likes: 312,
      saves: 41,
      shares: 19,
    },
  },
  {
    id: 'tt-002',
    title: 'Wedding detail flat-lay setup in 20 seconds',
    platform: 'TikTok',
    status: 'Published',
    pillar: 'Behind the Scenes',
    publishDate: '2026-04-10',
    hook: 'Here is how I build a luxury-looking detail shot fast.',
    owner: 'Tyler',
    cta: 'Save this before your wedding day.',
    notes: 'Could become a lead magnet teaser.',
    repurposeTo: ['Instagram Reels', 'YouTube Shorts'],
    metrics: {
      views: 9180,
      likes: 644,
      saves: 126,
      shares: 54,
    },
  },
]
